import SwiftUI

/// Reveals `text` one character at a time behind a block cursor, which blinks
/// once typing finishes. Retypes whenever `text` changes.
struct TypedText: View {
    let text: String
    var charactersPerSecond: Double = 40
    var cursor = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = 0
    @State private var cursorOn = true

    var body: some View {
        let visible = String(text.prefix(shown))
        let block = cursor && cursorOn ? "█" : " "
        Text(verbatim: visible + block)
            .accessibilityLabel(text)
            .task(id: text) { await type() }
    }

    private func type() async {
        cursorOn = true
        if reduceMotion {
            shown = text.count
        } else {
            shown = 0
            let delay = Duration.seconds(1 / charactersPerSecond)
            while shown < text.count {
                try? await Task.sleep(for: delay)
                if Task.isCancelled { return }
                shown += 1
            }
        }
        guard cursor, !reduceMotion else { return }
        while !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(530))
            cursorOn.toggle()
        }
    }
}
