import Foundation
import Observation
import WatchKit

/// Single source of truth for the main screen: record, send, show the answer.
@MainActor
@Observable
final class TurnController {
    enum Phase: Equatable {
        case idle
        case starting
        case recording
        case sending
        case response(transcript: String?, text: String)
        case failed(message: String, retryable: Bool)
    }

    static let maxDuration: TimeInterval = 120
    static let meterWidth = 14

    private(set) var phase: Phase = .idle
    /// One-line note shown on the idle screen (e.g. after a cancel).
    private(set) var note: String?
    private(set) var elapsed: TimeInterval = 0
    private(set) var levels: [Float] = Array(repeating: 0, count: meterWidth)

    private let recorder = Recorder()
    private let client = SidebandClient.fromBundle()
    private var meterTask: Task<Void, Never>?

    /// The recording awaiting a confirmed outcome, with the key it was first
    /// sent under so a retry can't run the turn twice.
    private var pending: (clip: Recorder.Clip, key: String)?

    var canStart: Bool {
        switch phase {
        case .idle, .response, .failed: true
        case .starting, .recording, .sending: false
        }
    }

    func start() async {
        guard canStart else { return }
        note = nil
        phase = .starting
        do {
            try await recorder.requestPermission()
            try recorder.start()
        } catch Recorder.Failure.permissionDenied {
            fail("mic access denied. enable it in settings", retryable: false)
            return
        } catch {
            fail("couldn't start recording", retryable: false)
            return
        }

        elapsed = 0
        levels = Array(repeating: 0, count: Self.meterWidth)
        phase = .recording
        WKInterfaceDevice.current().play(.start)
        meterTask = Task { [weak self] in await self?.meter() }
    }

    /// Stops recording and sends it.
    func finish() {
        guard phase == .recording else { return }
        meterTask?.cancel()
        WKInterfaceDevice.current().play(.stop)
        guard let clip = recorder.stop() else {
            fail("couldn't save recording", retryable: false)
            return
        }
        pending = (clip, UUID().uuidString)
        Task { await send() }
    }

    func cancel() {
        guard phase == .recording else { return }
        meterTask?.cancel()
        recorder.cancel()
        phase = .idle
        note = "cancelled"
        WKInterfaceDevice.current().play(.retry)
    }

    /// Resends the pending recording under its original key.
    func retry() {
        guard case .failed(_, true) = phase, pending != nil else { return }
        Task { await send() }
    }

    func dismissError() {
        guard case .failed = phase else { return }
        pending = nil
        phase = .idle
    }

    private func send() async {
        guard let (clip, key) = pending else { return }
        guard let client else {
            fail("no backend configured", retryable: false)
            return
        }
        phase = .sending
        do {
            let turn = try await submitRetryingOnce(client, clip: clip, key: key)
            pending = nil
            try? FileManager.default.removeItem(at: clip.url)
            switch turn.status {
            case "completed":
                phase = .response(transcript: turn.transcript, text: turn.watch_text ?? "")
                WKInterfaceDevice.current().play(.success)
            default:
                // needs_approval / failed / unknown are final outcomes: retrying returns them again.
                fail(turn.message ?? "turn \(turn.status)", retryable: false)
            }
        } catch {
            fail(error.message, retryable: error.retryable)
        }
    }

    /// A dropped connection or timeout gets one automatic retry under the same
    /// key. Errors from the backend are not retried. The backend doesn't store
    /// turns yet: until the relay exists (Milestone 3), the only dedup is the
    /// transcription provider's own idempotency on this key.
    private func submitRetryingOnce(
        _ client: SidebandClient, clip: Recorder.Clip, key: String
    ) async throws(SidebandClient.Failure) -> SidebandClient.Turn {
        do {
            return try await client.submit(audio: clip.url, key: key)
        } catch where error.error == "transport" {
            return try await client.submit(audio: clip.url, key: key)
        }
    }

    private func fail(_ message: String, retryable: Bool) {
        if !retryable {
            pending = nil
        }
        phase = .failed(message: message, retryable: retryable)
        WKInterfaceDevice.current().play(.failure)
    }

    private func meter() async {
        while !Task.isCancelled, phase == .recording {
            elapsed = recorder.currentTime
            levels.removeFirst()
            levels.append(recorder.level())
            if elapsed >= Self.maxDuration {
                finish()
                return
            }
            try? await Task.sleep(for: .milliseconds(100))
        }
    }
}
