import Observation

/// Hands a launch request from `AskIntent` to the UI. The intent can run
/// before any view exists, so it leaves a flag that the root view consumes.
@MainActor
@Observable
final class LaunchRouter {
    static let shared = LaunchRouter()

    private(set) var recordRequested = false

    func requestRecording() {
        recordRequested = true
    }

    /// Returns true once per request.
    func consumeRecordRequest() -> Bool {
        defer { recordRequested = false }
        return recordRequested
    }
}
