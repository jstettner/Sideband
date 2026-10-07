import SwiftUI

@main
struct SidebandApp: App {
    @State private var model = RecordingModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(LaunchRouter.shared)
        }
    }
}
