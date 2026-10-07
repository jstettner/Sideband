import AppIntents

/// Opens Sideband straight into recording. Compiled into both the app and the
/// widget extension; with a foreground mode, `perform()` runs in the app.
struct AskIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Sideband"
    static let description = IntentDescription("Open Sideband and start recording.")
    static let supportedModes: IntentModes = .foreground(.immediate)

    @MainActor
    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        LaunchRouter.shared.requestRecording()
        #endif
        return .result()
    }
}
