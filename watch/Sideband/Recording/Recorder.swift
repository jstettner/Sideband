import AVFoundation

/// Thin wrapper around `AVAudioRecorder` producing the format the protocol
/// requires: AAC in M4A, mono, 16 kHz, ~32 kbps.
@MainActor
final class Recorder {
    enum Failure: Error {
        case permissionDenied
        case couldNotStart
    }

    struct Clip: Equatable {
        let url: URL
        let duration: TimeInterval
        let bytes: Int
    }

    private static let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: 16_000,
        AVNumberOfChannelsKey: 1,
        AVEncoderBitRateKey: 32_000,
    ]

    private let workingURL = FileManager.default.temporaryDirectory
        .appendingPathComponent("recording.m4a")

    /// The most recent finished clip. Kept only so it can be pulled off the
    /// watch for testing; overwritten by the next recording.
    private let lastURL = URL.documentsDirectory.appendingPathComponent("last.m4a")

    private var recorder: AVAudioRecorder?

    var currentTime: TimeInterval { recorder?.currentTime ?? 0 }

    func requestPermission() async throws {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return
        case .denied:
            throw Failure.permissionDenied
        default:
            guard await AVAudioApplication.requestRecordPermission() else {
                throw Failure.permissionDenied
            }
        }
    }

    func start() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default)
        try session.setActive(true)

        try? FileManager.default.removeItem(at: workingURL)
        let recorder = try AVAudioRecorder(url: workingURL, settings: Self.settings)
        recorder.isMeteringEnabled = true
        guard recorder.record() else {
            deactivateSession()
            throw Failure.couldNotStart
        }
        self.recorder = recorder
    }

    /// Normalized input level, 0...1.
    func level() -> Float {
        guard let recorder else { return 0 }
        recorder.updateMeters()
        let db = recorder.averagePower(forChannel: 0)
        return min(max((db + 50) / 50, 0), 1)
    }

    func stop() -> Clip? {
        guard let recorder else { return nil }
        let duration = recorder.currentTime
        recorder.stop()
        self.recorder = nil
        deactivateSession()

        do {
            try? FileManager.default.removeItem(at: lastURL)
            try FileManager.default.moveItem(at: workingURL, to: lastURL)
            let bytes = try lastURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            return Clip(url: lastURL, duration: duration, bytes: bytes)
        } catch {
            return nil
        }
    }

    func cancel() {
        recorder?.stop()
        recorder?.deleteRecording()
        recorder = nil
        deactivateSession()
    }

    private func deactivateSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
