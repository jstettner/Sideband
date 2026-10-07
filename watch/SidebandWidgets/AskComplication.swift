import SwiftUI
import WidgetKit

/// Watch face complication. Shows the droid and opens the app already recording.
///
/// `Droid` is a template image, so the watch face tints it like any complication.
struct AskComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "sideband.face", provider: Provider()) { _ in
            DroidView()
                .widgetURL(AskURL.url)
                // Required since watchOS 10, or the system shows an error in place of the widget.
                .containerBackground(for: .widget) { Color.clear }
        }
        .configurationDisplayName("Ask Sideband")
        .description("Start recording a question.")
        .supportedFamilies([.accessoryCircular, .accessoryCorner])
    }
}

/// Nothing changes over time: one entry, never refreshed.
private struct Provider: TimelineProvider {
    struct Entry: TimelineEntry {
        let date: Date
    }

    func placeholder(in context: Context) -> Entry {
        Entry(date: .now)
    }

    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        completion(Entry(date: .now))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        completion(Timeline(entries: [Entry(date: .now)], policy: .never))
    }
}

private struct DroidView: View {
    @Environment(\.widgetFamily) private var family
    @Environment(\.widgetRenderingMode) private var renderingMode

    private static let gold = Color(red: 0.86, green: 0.68, blue: 0.27)

    var body: some View {
        let glyph = Image("Droid")
            .resizable()
            .scaledToFit()
            .foregroundStyle(renderingMode == .fullColor ? Self.gold : .white)
            .widgetAccentable()
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                glyph.padding(6)
            }
        default:
            glyph
        }
    }
}
