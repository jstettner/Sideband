import SwiftUI

/// Past chats, tap one to read it. Here and in a chat, up is older: both
/// open at the newest end, like the main screen.
struct HistoryView: View {
    @Environment(TurnController.self) private var turn

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    Text(verbatim: "> history").foregroundStyle(Theme.secondary)
                    if turn.history.answered.isEmpty {
                        Text(verbatim: "nothing yet").foregroundStyle(Theme.secondary)
                    }
                    ForEach(turn.history.answered) { chat in
                        NavigationLink(value: chat.id) { ChatRow(chat: chat) }
                            .buttonStyle(.plain)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 6)
            }
            .defaultScrollAnchor(.bottom)
            .navigationDestination(for: UUID.self) { id in
                if let chat = turn.history.chats.first(where: { $0.id == id }) {
                    ChatView(chat: chat)
                }
            }
            .background(Theme.background.ignoresSafeArea())
        }
    }
}

/// The chat's first question and when it was last answered.
private struct ChatRow: View {
    let chat: History.Chat

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: chat.entries.first?.transcripts.first ?? chat.entries.first?.answer ?? "")
                .lineLimit(2)
            if let last = chat.entries.last {
                Text(last.date, format: .relative(presentation: .named))
                    .font(Theme.mono(13, relativeTo: .footnote))
                    .foregroundStyle(Theme.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// A chat's turns as the main screen showed them: what was asked, then the answer.
private struct ChatView: View {
    let chat: History.Chat

    var body: some View {
        ScrollViewReader { scroller in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(chat.entries) { entry in
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(Array(entry.transcripts.enumerated()), id: \.offset) { _, transcript in
                                Text(verbatim: "> \(transcript)").foregroundStyle(Theme.secondary)
                            }
                            Text(verbatim: entry.answer)
                        }
                        .id(entry.id)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 6)
            }
            // The latest turn's question at the top, so a long answer reads from its start.
            .onAppear {
                if let last = chat.entries.last { scroller.scrollTo(last.id, anchor: .top) }
            }
        }
        .scrollEdgeEffectHidden(true, for: .bottom)
        .font(Theme.mono())
        .foregroundStyle(Theme.foreground)
        .background(Theme.background.ignoresSafeArea())
    }
}
