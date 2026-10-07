import Foundation

/// Opened by the watch face complication: the app starts recording, like `AskIntent`.
enum AskURL {
    static let url = URL(string: "sideband://ask")!
}
