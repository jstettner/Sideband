import Foundation
import Observation

/// Answered turns, grouped into chats, kept on the watch only. `[+]` starts a
/// new chat; everything answered until the next one goes into it.
@MainActor
@Observable
final class History {
    struct Entry: Codable, Identifiable, Sendable {
        /// The turn's idempotency key.
        let id: String
        let date: Date
        /// The turn's transcript, then any steers merged into it.
        var transcripts: [String]
        let answer: String
    }

    struct Chat: Codable, Identifiable, Sendable {
        let id: UUID
        /// Oldest first.
        var entries: [Entry]
    }

    /// Oldest first; the last one is the chat answers go into. Never empty.
    private(set) var chats: [Chat]

    /// Older chats are dropped past this.
    static let maxChats = 50

    private let file: URL

    init(file: URL = History.defaultFile) {
        self.file = file
        let saved = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode([Chat].self, from: $0) }
        chats = saved?.isEmpty == false ? saved! : [Chat(id: UUID(), entries: [])]
    }

    /// Chats with something in them, oldest first.
    var answered: [Chat] { chats.filter { !$0.entries.isEmpty } }

    /// Adds a turn's answer to the current chat, or updates it if `key` is already there.
    func record(key: String, transcripts: [String], answer: String) {
        let entry = Entry(id: key, date: .now, transcripts: transcripts, answer: answer)
        if let (c, e) = locate(key) {
            chats[c].entries[e] = entry
        } else {
            chats[chats.count - 1].entries.append(entry)
        }
        save()
    }

    /// A steer merged into `key` after its answer was recorded.
    func addTranscript(_ transcript: String, to key: String) {
        guard let (c, e) = locate(key) else { return }
        chats[c].entries[e].transcripts.append(transcript)
        save()
    }

    /// Answers from here on go into a new chat. A no-op while the current one is empty.
    func startChat() {
        guard chats.last?.entries.isEmpty == false else { return }
        chats.append(Chat(id: UUID(), entries: []))
        chats = Array(chats.suffix(Self.maxChats))
        save()
    }

    private func locate(_ key: String) -> (Int, Int)? {
        for (c, chat) in chats.enumerated().reversed() {
            if let e = chat.entries.firstIndex(where: { $0.id == key }) { return (c, e) }
        }
        return nil
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(chats) else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: file, options: .atomic)
    }

    static var defaultFile: URL {
        URL.applicationSupportDirectory.appending(path: "history.json")
    }
}
