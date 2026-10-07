import SwiftUI
import WidgetKit

/// Control Center / Smart Stack / Action Button entry point. Opens the app
/// already recording.
struct AskControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "sideband.ask") {
            ControlWidgetButton(action: AskIntent()) {
                Label("Ask Sideband", systemImage: "mic")
            }
        }
        .displayName("Ask Sideband")
        .description("Start recording a question.")
    }
}
