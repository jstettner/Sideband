import SwiftUI

/// Top bar, main pane, bottom bar. The main pane is the tap target; the bars
/// only ever do their own thing.
struct RootView: View {
    @Environment(TurnController.self) private var turn
    @Environment(LaunchRouter.self) private var router

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            topBar
            MainPane(onTap: tap)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            bottomBar
        }
        .font(Theme.mono())
        .foregroundStyle(Theme.foreground)
        .padding(.horizontal, 6)
        .background(Theme.background.ignoresSafeArea())
        .onChange(of: router.recordRequested, initial: true) {
            if router.consumeRecordRequest() {
                Task { await turn.start() }
            }
        }
    }

    private var topBar: some View {
        HStack {
            Button("[+]") { Task { await turn.newChat() } }
                .buttonStyle(.plain)
                .foregroundStyle(turn.canStartNewChat ? Theme.foreground : Theme.secondary)
                .disabled(!turn.canStartNewChat)
                .contentShape(Rectangle())
            Spacer()
            // Placeholder until context usage exists.
            Text("[ ]").foregroundStyle(Theme.secondary)
        }
    }

    /// Only takes space when it has a button, so answers get the full height.
    @ViewBuilder
    private var bottomBar: some View {
        switch turn.phase {
        case .recording:
            bar { barButton("[x]") { turn.cancel() } }
        case .failed(_, true):
            bar { barButton("[retry]") { turn.retry() } }
        default:
            EmptyView()
        }
    }

    private func bar(@ViewBuilder _ content: () -> some View) -> some View {
        HStack {
            Spacer()
            content()
            Spacer()
        }
        .frame(minHeight: 32)
    }

    private func barButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .buttonStyle(.plain)
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
    }

    private func tap() {
        switch turn.phase {
        case .idle, .response, .sending: Task { await turn.start() }
        case .recording: turn.finish()
        case .failed: turn.dismissError()
        case .starting, .resetting: break
        }
    }
}

private struct MainPane: View {
    @Environment(TurnController.self) private var turn
    let onTap: () -> Void

    private static let answerID = "answer"

    var body: some View {
        Group {
            if case .response(let transcripts, let text) = turn.phase {
                // The Crown scrolls; a tap (not a drag) starts the reply, or a steer.
                ScrollViewReader { scroller in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(Array(transcripts.enumerated()), id: \.offset) { _, transcript in
                                Text(verbatim: "> \(transcript)")
                                    .foregroundStyle(Theme.secondary)
                            }
                            TypedText(text: text, charactersPerSecond: 60)
                                .id(Self.answerID)
                            if turn.isWaiting {
                                Spinner(label: "> thinking").foregroundStyle(Theme.secondary)
                            }
                            steerNote
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                        .onTapGesture(perform: onTap)
                    }
                    // The default soft edge fades out the last lines; the bezel already rounds it off.
                    .scrollEdgeEffectHidden(true, for: .bottom)
                    // The answer is what matters at a glance: bring it to the top, with what was
                    // asked one Crown turn up. Again when a merged steer adds a question.
                    .task(id: transcripts) {
                        guard transcripts.count > 0 else { return }
                        try? await Task.sleep(for: .milliseconds(50))
                        withAnimation { scroller.scrollTo(Self.answerID, anchor: .top) }
                    }
                }
            } else {
                status
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .contentShape(Rectangle())
                    .onTapGesture(perform: onTap)
            }
        }
        .padding(.top, 8)
    }

    @ViewBuilder
    private var status: some View {
        VStack(alignment: .leading, spacing: 6) {
            switch turn.phase {
            case .idle:
                if let note = turn.note {
                    Text(verbatim: "> \(note)").foregroundStyle(Theme.secondary)
                }
                TypedText(text: "> tap to ask")
            case .starting:
                TypedText(text: "> starting")
            case .recording:
                HStack(spacing: 0) {
                    TypedText(text: "> listening", cursor: false)
                    Spacer()
                    Text(clock(turn.elapsed)).monospacedDigit()
                }
                Text(meter(turn.levels))
            case .sending:
                Spinner(label: "> thinking")
                Text(verbatim: "tap to steer").foregroundStyle(Theme.secondary)
                steerNote
            case .resetting:
                Spinner(label: "> new chat")
            case .failed(let message, _):
                TypedText(text: "! \(message)")
            case .response:
                EmptyView()
            }
        }
    }

    @ViewBuilder
    private var steerNote: some View {
        if let note = turn.steerNote {
            Text(verbatim: "! \(note)").foregroundStyle(Theme.secondary)
        }
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

/// `label |`, `label /`, `label -`, `label \` on a loop.
private struct Spinner: View {
    let label: String
    @State private var frame = 0
    private static let frames = Array("|/-\\")

    var body: some View {
        Text(verbatim: "\(label) \(Self.frames[frame])")
            .task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(120))
                    frame = (frame + 1) % Self.frames.count
                }
            }
    }
}
