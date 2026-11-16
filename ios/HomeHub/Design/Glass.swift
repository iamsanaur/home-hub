import SwiftUI

/// HomeHub Liquid Glass on iOS — Apple's native material (iOS 26 `glassEffect`), used only on the
/// functional layer: the tab bar (system, automatic), the AI composer, floating controls and
/// toolbars. Content, lists, forms and finance stay on solid surfaces (design.md §3).
///
/// Reduce Transparency → an opaque elevated surface with the same geometry. Increase Contrast →
/// a visible border.
struct GlassSurface<S: Shape>: ViewModifier {
    var shape: S
    var interactive: Bool = false
    var tint: Color? = nil
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        if reduceTransparency {
            content
                .background(HH.surfaceElevated, in: shape)
                .overlay(shape.stroke(HH.border, lineWidth: 1))
        } else {
            content
                .glassEffect(glass, in: shape)
                .overlay(contrast == .increased ? AnyView(shape.stroke(HH.border, lineWidth: 1)) : AnyView(EmptyView()))
        }
    }

    private var glass: Glass {
        var g = Glass.regular
        if let tint { g = g.tint(tint) }
        if interactive { g = g.interactive() }
        return g
    }
}

extension View {
    func glassSurface<S: Shape>(_ shape: S, interactive: Bool = false, tint: Color? = nil) -> some View {
        modifier(GlassSurface(shape: shape, interactive: interactive, tint: tint))
    }

    func glassCapsule(interactive: Bool = true) -> some View { glassSurface(Capsule(), interactive: interactive) }
}
