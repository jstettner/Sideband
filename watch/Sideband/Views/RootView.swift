import SwiftUI

/// Top bar, main pane, bottom bar. The main pane is the tap target; the bars
/// only ever do their own thing.
struct RootView: View {
    @Environment(RecordingModel.self) private var model
    @Environment(LaunchRouter.self) private var router

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            topBar
            MainPane()
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .contentShape(Rectangle())
                .onTapGesture(perform: tap)
            bottomBar
        }
        .font(Theme.mono())
        .foregroundStyle(Theme.foreground)
        .padding(.horizontal, 6)
        .background(Theme.background.ignoresSafeArea())
        .onChange(of: router.recordRequested, initial: true) {
            if router.consumeRecordRequest() {
                Task { await model.start() }
            }
        }
    }

    // Placeholders until sessions and status exist.
    private var topBar: some View {
        HStack {
            Text("[+]")
            Spacer()
            Text("[ ]")
        }
        .foregroundStyle(Theme.secondary)
    }

    @ViewBuilder
    private var bottomBar: some View {
        HStack {
            Spacer()
            if model.phase == .recording {
                Button("[x]") { model.cancel() }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
            }
            Spacer()
        }
        .frame(minHeight: 32)
    }

    private func tap() {
        switch model.phase {
        case .idle: Task { await model.start() }
        case .recording: model.finish()
        case .failed: model.dismissError()
        case .starting: break
        }
    }
}

private struct MainPane: View {
    @Environment(RecordingModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            switch model.phase {
            case .idle:
                if let clip = model.lastClip {
                    Text("> saved \(clock(clip.duration)) · \(clip.bytes / 1024)kb")
                        .foregroundStyle(Theme.secondary)
                }
                TypedText(text: "> tap to ask")
            case .starting:
                TypedText(text: "> starting")
            case .recording:
                HStack(spacing: 0) {
                    TypedText(text: "> listening", cursor: false)
                    Spacer()
                    Text(clock(model.elapsed)).monospacedDigit()
                }
                Text(meter(model.levels))
            case .failed(let message):
                TypedText(text: "! \(message)")
            }
        }
        .padding(.top, 8)
    }

    private func clock(_ t: TimeInterval) -> String {
        let s = Int(t)
        return "\(s / 60):" + String(format: "%02d", s % 60)
    }

    private func meter(_ levels: [Float]) -> String {
        let bars = Array("▁▂▃▄▅▆▇█")
        return String(levels.map { bars[min(Int($0 * Float(bars.count)), bars.count - 1)] })
    }
}
