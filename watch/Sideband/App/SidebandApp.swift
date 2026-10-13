import SwiftUI

@main
struct SidebandApp: App {
    @State private var turn = TurnController(history: History())

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(turn)
                .environment(LaunchRouter.shared)
                .onOpenURL { url in
                    if url == AskURL.url { LaunchRouter.shared.requestRecording() }
                }
        }
    }
}
