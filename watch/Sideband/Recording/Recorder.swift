import AVFoundation

/// Thin wrapper around `AVAudioRecorder` producing the format the protocol
/// requires: WAV, 16 kHz mono 16-bit PCM.
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
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: 16_000,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
    ]

    private let workingURL = FileManager.default.temporaryDirectory
        .appendingPathComponent("recording.wav")

    /// The finished clip, kept until the backend has it so a retry can resend
    /// it. Overwritten by the next recording.
    private let clipURL = URL.documentsDirectory.appendingPathComponent("turn.wav")

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
            try? FileManager.default.removeItem(at: clipURL)
            try FileManager.default.moveItem(at: workingURL, to: clipURL)
            let bytes = try clipURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            return Clip(url: clipURL, duration: duration, bytes: bytes)
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
