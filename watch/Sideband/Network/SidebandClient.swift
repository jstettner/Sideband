import Foundation

/// Talks to a Sideband backend over the HTTP contract in `protocol/`. Nothing
/// here knows which agent or transcription provider is behind it.
struct SidebandClient: Sendable {
    let baseURL: URL
    let token: String

    /// Reads `SidebandBackendURL` / `SidebandWatchToken` from Info.plist
    /// (filled from Local.xcconfig). Nil when either is missing.
    static func fromBundle() -> SidebandClient? {
        let info = Bundle.main.infoDictionary ?? [:]
        guard
            let url = (info["SidebandBackendURL"] as? String).flatMap(URL.init(string:)),
            url.host() != nil,
            let token = info["SidebandWatchToken"] as? String, !token.isEmpty
        else { return nil }
        return SidebandClient(baseURL: url, token: token)
    }

    /// Outcome of a turn, decoded from `TurnState`. Only the fields the watch uses.
    struct Turn: Decodable, Sendable {
        let status: String
        let transcript: String?
        let watch_text: String?
        let message: String?
        let retry_after_ms: Int?
    }

    /// Protocol error body: `{ error, message, retryable }`.
    struct Failure: Error, Decodable, Sendable {
        let error: String
        let message: String
        let retryable: Bool

        static func transport(_ message: String) -> Failure {
            Failure(error: "transport", message: message, retryable: true)
        }
    }

    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        // The backend holds a turn open for up to ~25 s before answering `running`.
        config.timeoutIntervalForRequest = 40
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    /// Submits a recorded turn and waits for a final outcome, polling while it
    /// is `running`. Reuse `key` when retrying the same recording.
    func submit(audio file: URL, key: String, session: String = "main") async throws(Failure) -> Turn {
        var components = URLComponents(url: baseURL.appending(path: "v1/turn"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "session", value: session)]
        var request = authorized(URLRequest(url: components.url!))
        request.httpMethod = "POST"
        request.setValue("audio/wav", forHTTPHeaderField: "Content-Type")
        request.setValue(key, forHTTPHeaderField: "Idempotency-Key")

        var turn = try await send { try await Self.session.upload(for: request, fromFile: file) }
        while turn.status == "running" {
            try? await Task.sleep(for: .milliseconds(turn.retry_after_ms ?? 1000))
            let poll = authorized(URLRequest(url: baseURL.appending(path: "v1/turns/\(key)")))
            turn = try await send { try await Self.session.data(for: poll) }
        }
        return turn
    }

    private func authorized(_ request: URLRequest) -> URLRequest {
        var request = request
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func send(_ perform: () async throws -> (Data, URLResponse)) async throws(Failure) -> Turn {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await perform()
        } catch let error as URLError {
            throw .transport(Self.describe(error))
        } catch {
            throw .transport("network error")
        }

        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let decoder = JSONDecoder()
        if (200..<300).contains(status), let turn = try? decoder.decode(Turn.self, from: data) {
            return turn
        }
        if let failure = try? decoder.decode(Failure.self, from: data) {
            throw failure
        }
        throw Failure(error: "http_\(status)", message: "unexpected response (\(status))", retryable: status >= 500)
    }

    private static func describe(_ error: URLError) -> String {
        switch error.code {
        case .notConnectedToInternet, .networkConnectionLost: "no connection"
        case .timedOut: "timed out"
        case .cannotFindHost, .cannotConnectToHost: "backend unreachable"
        default: "network error"
        }
    }
}
