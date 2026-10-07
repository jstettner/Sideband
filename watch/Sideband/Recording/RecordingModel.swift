import Observation
import WatchKit

/// Single source of truth for the record screen.
@MainActor
@Observable
final class RecordingModel {
    enum Phase: Equatable {
        case idle
        case starting
        case recording
        case failed(String)
    }

    static let maxDuration: TimeInterval = 120
    static let meterWidth = 14

    private(set) var phase: Phase = .idle
    private(set) var elapsed: TimeInterval = 0
    private(set) var levels: [Float] = Array(repeating: 0, count: meterWidth)
    private(set) var lastClip: Recorder.Clip?

    private let recorder = Recorder()
    private var meterTask: Task<Void, Never>?

    func start() async {
        guard phase == .idle || isFailed else { return }
        phase = .starting
        do {
            try await recorder.requestPermission()
            try recorder.start()
        } catch Recorder.Failure.permissionDenied {
            fail("mic access denied. enable it in settings")
            return
        } catch {
            fail("couldn't start recording")
            return
        }

        elapsed = 0
        levels = Array(repeating: 0, count: Self.meterWidth)
        phase = .recording
        WKInterfaceDevice.current().play(.start)
        meterTask = Task { [weak self] in await self?.meter() }
    }

    /// Stops and keeps the clip. Later milestones send it here.
    func finish() {
        guard phase == .recording else { return }
        meterTask?.cancel()
        lastClip = recorder.stop()
        phase = lastClip == nil ? .failed("couldn't save recording") : .idle
        WKInterfaceDevice.current().play(.stop)
    }

    func cancel() {
        guard phase == .recording else { return }
        meterTask?.cancel()
        recorder.cancel()
        phase = .idle
        WKInterfaceDevice.current().play(.directionDown)
    }

    func dismissError() {
        if isFailed { phase = .idle }
    }

    private var isFailed: Bool {
        if case .failed = phase { return true }
        return false
    }

    private func fail(_ message: String) {
        phase = .failed(message)
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
