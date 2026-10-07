import SwiftUI

enum Theme {
    static let foreground = Color.white
    static let secondary = Color(white: 0.5)
    static let background = Color.black

    static func mono(_ size: CGFloat = 16, relativeTo style: Font.TextStyle = .body) -> Font {
        .custom("Iosevka", size: size, relativeTo: style)
    }
}
