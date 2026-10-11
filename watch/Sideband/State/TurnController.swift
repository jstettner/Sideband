import Foundation
import Observation
import WatchKit

/// Single source of truth for the main screen: record, send, show the answer.
///
/// A recording started while a turn is still out is a steer: the backend
/// folds it into that turn. Each turn polls on its own; the screen shows the
/// latest answer, and the transcripts of steers merged into it.
@MainActor
@Observable
final class TurnController {
    enum Phase: Equatable {
        case idle
        case starting
        case recording
        case sending
        case resetting
        /// `transcripts`: the turn's, then any steers merged into it.
        case response(transcripts: [String], text: String)
        case failed(message: String, retryable: Bool)
    }

    static let maxDuration: TimeInterval = 120
    static let meterWidth = 14

    private(set) var phase: Phase = .idle
    /// One-line note shown on the idle screen (e.g. after a cancel).
    private(set) var note: String?
    /// Why the last steer was lost, shown while the turn it steered goes on.
    private(set) var steerNote: String?
    /// Steers sent and still waiting for an outcome.
    private(set) var steers = 0
    private(set) var elapsed: TimeInterval = 0
    private(set) var levels: [Float] = Array(repeating: 0, count: meterWidth)

    private let recorder = Recorder()
    private let client = SidebandClient.fromBundle()
    private var meterTask: Task<Void, Never>?

    /// The recording awaiting a confirmed outcome, with the key it was first
    /// sent under so a retry can't run the turn twice.
    private var pending: (clip: Recorder.Clip, key: String)?
    /// Whether that turn is being sent or polled right now.
    private var sending = false

    /// While a steer is recorded: the screen to go back to, kept up to date
    /// as outcomes arrive, and the haptic they're owed. Nil otherwise.
    private var background: Phase?
    private var heldHaptic: WKHapticType?

    /// Order of submissions, so an older turn's answer never replaces a newer one's.
    private var nextSeq = 0
    private var shownSeq = -1
    /// Key of the turn whose answer is on screen, and the steers merged into each turn.
    private var shownKey: String?
    private var merged: [String: [String]] = [:]

    /// A tap starts recording (a steer while a turn is out).
    var canStart: Bool {
        switch phase {
        case .idle, .response, .failed, .sending: true
        case .starting, .recording, .resetting: false
        }
    }

    /// `[+]`: not while anything is out, which would only be refused as busy.
    var canStartNewChat: Bool {
        switch phase {
        case .idle, .response, .failed: steers == 0 && !sending
        case .starting, .recording, .sending, .resetting: false
        }
    }

    /// A turn or steer is still out: a recording now would be a steer.
    var isWaiting: Bool { sending || steers > 0 }

    func start() async {
        guard canStart else { return }
        note = nil
        steerNote = nil
        if isWaiting {
            background = phase
            heldHaptic = nil
        }
        phase = .starting
        do {
            try await recorder.requestPermission()
            try recorder.start()
        } catch Recorder.Failure.permissionDenied {
            failStart("mic access denied. enable it in settings")
            return
        } catch {
            failStart("couldn't start recording")
            return
        }

        elapsed = 0
        levels = Array(repeating: 0, count: Self.meterWidth)
        phase = .recording
        WKInterfaceDevice.current().play(.start)
        meterTask = Task { [weak self] in await self?.meter() }
    }

    /// Stops recording and sends it, as a steer if a turn is still out.
    func finish() {
        guard phase == .recording else { return }
        meterTask?.cancel()
        WKInterfaceDevice.current().play(.stop)
        let clip = recorder.stop()
        if background != nil {
            if let clip {
                let seq = takeSeq()
                Task { await sendSteer(clip, key: UUID().uuidString, seq: seq) }
            } else {
                steerNote = "steer lost: couldn't save recording"
            }
            resume()
            return
        }
        guard let clip else {
            fail("couldn't save recording", retryable: false)
            return
        }
        pending = (clip, UUID().uuidString)
        Task { await send(seq: takeSeq()) }
    }

    /// Drops the recording. A steer goes back to the turn it would have steered.
    func cancel() {
        guard phase == .recording else { return }
        meterTask?.cancel()
        recorder.cancel()
        if background != nil {
            WKInterfaceDevice.current().play(.retry)
            resume()
            return
        }
        phase = .idle
        note = "cancelled"
        WKInterfaceDevice.current().play(.retry)
    }

    /// Resends the pending recording under its original key.
    func retry() {
        guard case .failed(_, true) = phase, pending != nil else { return }
        Task { await send(seq: takeSeq()) }
    }

    /// Starts a fresh agent session. Drops any unsent recording, since it
    /// belonged to the old conversation.
    func newChat() async {
        guard canStartNewChat else { return }
        guard let client else {
            fail("no backend configured", retryable: false)
            return
        }
        discardPending()
        note = nil
        phase = .resetting
        do {
            _ = try await client.newSession()
            phase = .idle
            note = "new chat"
            WKInterfaceDevice.current().play(.success)
        } catch {
            // Not retryable here: [retry] resends a recording, not this.
            fail(Self.describe(error), retryable: false)
        }
    }

    func dismissError() {
        guard case .failed = phase else { return }
        pending = nil
        phase = .idle
    }

    private func send(seq: Int) async {
        guard let (clip, key) = pending else { return }
        guard let client else {
            fail("no backend configured", retryable: false)
            return
        }
        phase = .sending
        sending = true
        defer { sending = false }
        do {
            let turn = try await submitRetryingOnce(client, clip: clip, key: key)
            pending = nil
            try? FileManager.default.removeItem(at: clip.url)
            switch turn.status {
            case "completed":
                showAnswer(turn, key: key, seq: seq)
            case "needs_approval":
                // Approvals can't be given from the watch yet.
                fail("needs approval on another device", retryable: false, seq: seq)
            default:
                // failed / unknown are final outcomes: retrying returns them again.
                fail(turn.message ?? "turn \(turn.status)", retryable: false, seq: seq)
            }
        } catch {
            fail(Self.describe(error), retryable: error.retryable, seq: seq)
        }
    }

    /// Sends a steer. Never retried beyond the automatic transport retry: a
    /// lost steer only gets a note, the turn it steered goes on.
    private func sendSteer(_ clip: Recorder.Clip, key: String, seq: Int) async {
        defer { try? FileManager.default.removeItem(at: clip.url) }
        guard let client else {
            steerLost("no backend configured")
            return
        }
        steers += 1
        defer { steers -= 1 }
        do {
            let turn = try await submitRetryingOnce(client, clip: clip, key: key)
            switch turn.status {
            case "merged":
                // The turn it went into answers it: list it under that answer.
                guard let into = turn.into, let transcript = turn.transcript, !transcript.isEmpty else { return }
                merged[into, default: []].append(transcript)
                if shownKey == into, case .response(let transcripts, let text) = current {
                    present(.response(transcripts: transcripts + [transcript], text: text), haptic: nil)
                }
            case "completed":
                // It ran on its own (the turn it steered had finished): its answer is the latest.
                showAnswer(turn, key: key, seq: seq)
            case "needs_approval":
                steerLost("needs approval on another device")
            default:
                steerLost(turn.message ?? "turn \(turn.status)")
            }
        } catch {
            steerLost(Self.describe(error))
        }
    }

    private func showAnswer(_ turn: SidebandClient.Turn, key: String, seq: Int) {
        guard seq >= shownSeq else { return }
        shownSeq = seq
        shownKey = key
        let transcripts = [turn.transcript].compactMap { $0 }.filter { !$0.isEmpty } + (merged[key] ?? [])
        present(.response(transcripts: transcripts, text: turn.watch_text ?? ""), haptic: .success)
    }

    private func steerLost(_ message: String) {
        steerNote = "steer lost: \(message)"
        if background == nil {
            WKInterfaceDevice.current().play(.failure)
        } else {
            heldHaptic = heldHaptic ?? .failure
        }
    }

    /// The screen behind a steer being recorded, or the one showing.
    private var current: Phase { background ?? phase }

    /// Shows `next`, or holds it (and its haptic) while a steer is recorded:
    /// no screen change mid-sentence.
    private func present(_ next: Phase, haptic: WKHapticType?) {
        if background != nil {
            background = next
            if let haptic { heldHaptic = haptic }
        } else {
            phase = next
            if let haptic { WKInterfaceDevice.current().play(haptic) }
        }
    }

    /// Ends a steer recording: back to the screen behind it, with the haptic it held.
    private func resume() {
        guard let next = background else { return }
        background = nil
        phase = next
        if let haptic = heldHaptic { WKInterfaceDevice.current().play(haptic) }
        heldHaptic = nil
    }

    private func takeSeq() -> Int {
        defer { nextSeq += 1 }
        return nextSeq
    }

    private static func describe(_ failure: SidebandClient.Failure) -> String {
        switch failure.error {
        case "agent_offline": "agent offline. nothing was run"
        case "session_busy": "still working on the last one"
        default: failure.message
        }
    }

    /// A dropped connection or timeout gets one automatic retry under the same
    /// key. Errors from the backend are not retried. The backend dedups on the
    /// key, so a retry returns the original turn's outcome instead of running
    /// it again.
    private func submitRetryingOnce(
        _ client: SidebandClient, clip: Recorder.Clip, key: String
    ) async throws(SidebandClient.Failure) -> SidebandClient.Turn {
        do {
            return try await client.submit(audio: clip.url, key: key)
        } catch where error.error == "transport" {
            return try await client.submit(audio: clip.url, key: key)
        }
    }

    private func discardPending() {
        if let clip = pending?.clip {
            try? FileManager.default.removeItem(at: clip.url)
        }
        pending = nil
    }

    /// `seq`: the submission that failed. Nil for local failures, which always show.
    private func fail(_ message: String, retryable: Bool, seq: Int? = nil) {
        if !retryable {
            pending = nil
        }
        if let seq {
            guard seq >= shownSeq else { return }
            shownSeq = seq
            shownKey = nil
        }
        present(.failed(message: message, retryable: retryable), haptic: .failure)
    }

    /// Recording couldn't start. For a steer that's a note; the turn goes on.
    private func failStart(_ message: String) {
        guard background != nil else {
            fail(message, retryable: false)
            return
        }
        steerNote = "steer lost: \(message)"
        resume()
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
