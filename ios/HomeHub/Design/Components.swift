import SwiftUI

// MARK: Buttons — primary (one per view), secondary, tertiary, destructive; pressed, disabled, loading.

enum HHButtonKind { case primary, secondary, tertiary, destructive }

struct HHButton: View {
    let title: String
    var kind: HHButtonKind = .primary
    var systemImage: String? = nil
    var loading = false
    var fullWidth = true
    let action: () -> Void
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.xs) {
                if loading { ProgressView().tint(kind == .primary ? HH.onBrand : HH.brand) }
                else if let systemImage { Image(systemName: systemImage) }
                Text(title).font(.body.weight(.semibold)).lineLimit(1)
            }
            .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: 48)
            .padding(.horizontal, Space.lg)
        }
        .buttonStyle(HHButtonStyle(kind: kind))
        .disabled(loading)
        .accessibilityLabel(loading ? "\(title), in progress" : title)
    }
}

struct HHButtonStyle: ButtonStyle {
    let kind: HHButtonKind
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.input, style: .continuous)
        configuration.label
            .foregroundStyle(fg)
            .background(bg(configuration.isPressed), in: shape)
            .overlay(kind == .secondary ? shape.stroke(HH.border, lineWidth: 1) : nil)
            .opacity(enabled ? 1 : 0.45)
            .contentShape(shape)
    }
    private var fg: Color {
        switch kind { case .primary: HH.onBrand; case .destructive: .white; case .secondary: HH.ink; case .tertiary: HH.brand }
    }
    private func bg(_ pressed: Bool) -> Color {
        switch kind {
        case .primary: pressed ? HH.brandStrong : HH.brand
        case .destructive: HH.danger.opacity(pressed ? 0.85 : 1)
        case .secondary: pressed ? HH.surfaceSubtle : HH.surface
        case .tertiary: pressed ? HH.brandTint : .clear
        }
    }
}

// MARK: Surfaces

struct HHCard<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) { content }
            .padding(Space.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HH.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).stroke(HH.border, lineWidth: 1))
    }
}

/// Grouped solid list container (rows separated by hairlines) — instead of a card per row.
struct GroupedList<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(spacing: 0) { content }
            .background(HH.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).stroke(HH.border, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
    }
}

struct RowDivider: View { var body: some View { Rectangle().fill(HH.border).frame(height: 1) } }

struct SectionHeader: View {
    let title: String
    var action: String? = nil
    var onAction: (() -> Void)? = nil
    var body: some View {
        HStack {
            Text(title).font(HHFont.sectionTitle).foregroundStyle(HH.ink).accessibilityAddTraits(.isHeader)
            Spacer()
            if let action, let onAction { Button(action, action: onAction).font(HHFont.label).foregroundStyle(HH.brand).frame(minHeight: 44) }
        }
        .padding(.top, Space.xl).padding(.bottom, Space.xs)
    }
}

/// Section header whose trailing action opens another screen (same as Android's section shortcuts).
struct SectionHeaderLink<Destination: View>: View {
    let title: String
    let action: String
    @ViewBuilder var destination: () -> Destination
    var body: some View {
        HStack {
            Text(title).font(HHFont.sectionTitle).foregroundStyle(HH.ink).accessibilityAddTraits(.isHeader)
            Spacer()
            NavigationLink { destination() } label: { Text(action).font(HHFont.label).foregroundStyle(HH.brand).frame(minHeight: 44) }
        }
        .padding(.top, Space.xl).padding(.bottom, Space.xs)
    }
}

struct HHListRow: View {
    let title: String
    var subtitle: String? = nil
    var systemImage: String? = nil
    var trailing: AnyView? = nil
    var body: some View {
        HStack(spacing: Space.sm) {
            if let systemImage {
                Image(systemName: systemImage).font(.body.weight(.medium)).foregroundStyle(HH.brand)
                    .frame(width: 36, height: 36).background(HH.brandTint, in: RoundedRectangle(cornerRadius: Radius.control))
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(HHFont.cardTitle).foregroundStyle(HH.ink)
                if let subtitle { Text(subtitle).font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary) }
            }
            Spacer(minLength: 0)
            if let trailing { trailing }
        }
        .padding(.horizontal, Space.md).padding(.vertical, Space.sm)
        .frame(minHeight: 56)
        .contentShape(Rectangle())
    }
}

// MARK: Status — always label + icon, never colour alone.

struct StatusBadge: View {
    let label: String
    let tone: Tone
    var systemImage: String? = nil
    var body: some View {
        HStack(spacing: 4) {
            if let systemImage { Image(systemName: systemImage).font(.caption2.weight(.semibold)) }
            Text(label).font(HHFont.caption).lineLimit(1)
        }
        .foregroundStyle(tone.color)
        .padding(.horizontal, 10).padding(.vertical, 4)
        .background(tone.color.opacity(0.12), in: Capsule())
        .accessibilityElement(children: .combine)
    }
}

struct PriorityIndicator: View {
    let priority: Priority
    var body: some View {
        switch priority {
        case .urgent: StatusBadge(label: "Urgent", tone: .danger, systemImage: "chevron.up.2")
        case .high: StatusBadge(label: "High", tone: .warning, systemImage: "chevron.up")
        case .low: Text("Low").font(HHFont.caption).foregroundStyle(HH.inkTertiary)
        case .normal: EmptyView()
        }
    }
}

struct ProgressRow: View {
    let label: String
    let fraction: Double
    let value: String
    var tone: Tone = .brand
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack { Text(label).font(HHFont.bodyCompact).foregroundStyle(HH.ink); Spacer(); Text(value).font(.subheadline.monospacedDigit()).foregroundStyle(HH.inkSecondary) }
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(HH.surfaceSubtle)
                    Capsule().fill(tone.color).frame(width: max(0, min(1, fraction)) * g.size.width)
                }
            }
            .frame(height: 8)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label), \(value)")
    }
}

// MARK: States

struct EmptyStateView: View {
    let systemImage: String
    let title: String
    let message: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil
    var body: some View {
        VStack(spacing: Space.sm) {
            Image(systemName: systemImage).font(.title2).foregroundStyle(HH.brand)
                .frame(width: 56, height: 56).background(HH.brandTint, in: Circle()).accessibilityHidden(true)
            Text(title).font(HHFont.cardTitle).foregroundStyle(HH.ink)
            Text(message).font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary).multilineTextAlignment(.center)
            if let actionTitle, let action { HHButton(title: actionTitle, kind: .secondary, fullWidth: false, action: action) }
        }
        .frame(maxWidth: .infinity).padding(.vertical, Space.xxl).padding(.horizontal, Space.lg)
    }
}

struct ErrorStateView: View {
    let message: String
    var retry: (() -> Void)? = nil
    var body: some View {
        EmptyStateView(systemImage: "exclamationmark.triangle", title: "Something went wrong", message: message, actionTitle: retry == nil ? nil : "Try again", action: retry)
    }
}

struct LoadingSkeleton: View {
    var rows = 4
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false
    var body: some View {
        VStack(spacing: Space.sm) {
            ForEach(0..<rows, id: \.self) { _ in
                HStack(spacing: Space.sm) {
                    RoundedRectangle(cornerRadius: Radius.control).fill(HH.surfaceSubtle).frame(width: 36, height: 36)
                    VStack(alignment: .leading, spacing: 6) {
                        RoundedRectangle(cornerRadius: 4).fill(HH.surfaceSubtle).frame(height: 14).frame(maxWidth: 220)
                        RoundedRectangle(cornerRadius: 4).fill(HH.surfaceSubtle).frame(height: 12).frame(maxWidth: 130)
                    }
                    Spacer()
                }
            }
        }
        .opacity(pulse ? 0.55 : 0.9)
        .onAppear { if !reduceMotion { withAnimation(.easeInOut(duration: 0.9).repeatForever()) { pulse = true } } }
        .accessibilityLabel("Loading")
    }
}

struct MemberAvatar: View {
    let name: String
    var size: CGFloat = 36
    var initials: String { name.split(separator: " ").prefix(2).compactMap { $0.first.map(String.init) }.joined().uppercased() }
    var body: some View {
        Text(initials.isEmpty ? "?" : initials).font(HHFont.label).foregroundStyle(HH.ink)
            .frame(width: size, height: size).background(HH.sage.opacity(0.45), in: Circle())
            .accessibilityLabel(name)
    }
}

/// Persistent label, inline validation, helper text — never placeholder-only (design.md §7).
struct HHTextField: View {
    let label: String
    @Binding var text: String
    var optional = false
    var helper: String? = nil
    var error: String? = nil
    var placeholder = ""
    var keyboard: UIKeyboardType = .default
    var secure = false
    var multiline = false
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(label).font(HHFont.label).foregroundStyle(HH.ink)
                if optional { Text("Optional").font(HHFont.caption).foregroundStyle(HH.inkTertiary) }
            }
            Group {
                if secure { SecureField(placeholder, text: $text) }
                else if multiline { TextField(placeholder, text: $text, axis: .vertical).lineLimit(3...8) }
                else { TextField(placeholder, text: $text).keyboardType(keyboard) }
            }
            .font(HHFont.body)
            .padding(Space.sm)
            .frame(minHeight: 48)
            .background(HH.surface, in: RoundedRectangle(cornerRadius: Radius.input))
            .overlay(RoundedRectangle(cornerRadius: Radius.input).stroke(error == nil ? HH.border : HH.danger, lineWidth: 1))
            .accessibilityLabel(label)
            if let note = error ?? helper {
                Text(note).font(HHFont.caption).foregroundStyle(error == nil ? HH.inkSecondary : HH.danger)
            }
        }
    }
}

struct ChoiceChips<T: Hashable>: View {
    let options: [(T, String)]
    @Binding var selection: T
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Space.xs) {
                ForEach(options, id: \.0) { value, label in
                    let selected = value == selection
                    Button { selection = value } label: {
                        Text(label).font(HHFont.label).foregroundStyle(HH.ink)
                            .padding(.horizontal, 14).frame(minHeight: 40)
                            .background(selected ? HH.brandTint : HH.surface, in: Capsule())
                            .overlay(Capsule().stroke(selected ? HH.brand.opacity(0.5) : HH.border, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
        }
    }
}
