import SwiftUI
import UIKit

/// HomeHub semantic colour tokens (design.md §2.1). Same values as Android (`Tokens.kt`).
/// Each token resolves for light/dark automatically; feature code never uses raw hex.
enum HH {
    private static func dyn(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }
    static let canvas = dyn(0xF6F7F2, 0x101713)
    static let surface = dyn(0xFFFFFF, 0x18221C)
    static let surfaceSubtle = dyn(0xEEF1E9, 0x202D24)
    static let surfaceElevated = dyn(0xFFFFFF, 0x26352B)
    static let ink = dyn(0x18231D, 0xF1F5EF)
    static let inkSecondary = dyn(0x536158, 0xC0CCC2)
    /// design.md lists #758078 (3.81:1 on canvas). Darkened to #66716A → 4.72:1 on canvas, 5.08:1 on white (measured).
    static let inkTertiary = dyn(0x66716A, 0x9BA99E)
    static let brand = dyn(0x176B45, 0x83C69A)
    static let brandStrong = dyn(0x105638, 0xA2D8B1)
    static let brandTint = dyn(0xE1F0E6, 0x233C2C)
    static let onBrand = dyn(0xFFFFFF, 0x0C2416)
    static let sage = dyn(0xA8BFA7, 0x789B7D)
    static let gold = dyn(0xD6A344, 0xE4BB68)
    static let terracotta = dyn(0xB9674E, 0xD58B72)
    static let border = dyn(0xDCE3DA, 0x344238)
    static let success = dyn(0x28764D, 0x83C69A)
    static let warning = dyn(0x94600B, 0xE4BB68)
    static let danger = dyn(0xB33B36, 0xF08B83)
    static let info = dyn(0x356C9A, 0x8CB8E0)
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

/// 8-point spacing (design.md §4).
enum Space {
    static let xxs: CGFloat = 4, xs: CGFloat = 8, sm: CGFloat = 12, md: CGFloat = 16, lg: CGFloat = 20
    static let xl: CGFloat = 24, xxl: CGFloat = 32, xxxl: CGFloat = 40
}

enum Radius {
    static let control: CGFloat = 10, input: CGFloat = 12, card: CGFloat = 18, panel: CGFloat = 24, sheet: CGFloat = 28
}

/// Type scale (design.md §2.3) on San Francisco, scaling with Dynamic Type.
enum HHFont {
    static let display = Font.system(size: 32, weight: .bold).leading(.tight)
    static let screenTitle = Font.system(.largeTitle, weight: .bold)
    static let sectionTitle = Font.system(.title3, weight: .semibold)
    static let cardTitle = Font.system(.headline)
    static let body = Font.system(.body)
    static let bodyCompact = Font.system(.subheadline)
    static let label = Font.system(.footnote, weight: .semibold)
    static let caption = Font.system(.caption, weight: .medium)
    static let kpi = Font.system(.largeTitle, weight: .bold).monospacedDigit()
    static let numeric = Font.system(.body, weight: .medium).monospacedDigit()
}

enum Tone {
    case neutral, brand, success, warning, danger, info
    var color: Color {
        switch self {
        case .neutral: HH.inkSecondary
        case .brand: HH.brand
        case .success: HH.success
        case .warning: HH.warning
        case .danger: HH.danger
        case .info: HH.info
        }
    }
}
