import SwiftUI
import AppIntents
import FirebaseAuth

// Automatic spending capture on iOS. Apps can't read SMS or other apps' notifications on iOS, so the
// person sets up a Shortcuts personal automation ("When I get a message containing 'debited' → Log bank
// message") that hands the SMS text to this App Intent. The same on-device filter as Android decides
// what may leave the phone; the server parses it and files it in Finance → To review.

enum SpendCaptureSettings {
    private static let d = UserDefaults.standard
    static var enabled: Bool { d.bool(forKey: "homehub.spendCapture.enabled") }
    static var householdId: String? { d.string(forKey: "homehub.spendCapture.hid") }
    static func enable(hid: String) { d.set(true, forKey: "homehub.spendCapture.enabled"); d.set(hid, forKey: "homehub.spendCapture.hid") }
    static func disable() { d.set(false, forKey: "homehub.spendCapture.enabled") }

    /// Same rule as Android's SpendCapture.looksLikePayment: an amount, a payment verb, and not an OTP/reminder/request.
    static func looksLikePayment(_ text: String) -> Bool {
        guard (8...1000).contains(text.count) else { return false }
        let r: (String) -> Bool = { text.range(of: $0, options: [.regularExpression, .caseInsensitive]) != nil }
        return r(#"(₹|\bRs\.?|\bINR)\s*[0-9][0-9,]*(\.[0-9]{1,2})?"#)
            && r(#"\b(debited|credited|paid|spent|sent|received|withdrawn|purchase)\b"#)
            && !r(#"\b(OTP|one[- ]time password|verification code|will be debited|is due|has requested|collect request)\b"#)
    }
}

struct LogBankMessageIntent: AppIntent {
    static let title: LocalizedStringResource = "Log bank message"
    static let description = IntentDescription("Sends a bank or UPI message to HomeHub. Completed payments wait in Finance → To review until you confirm them.")
    static let openAppWhenRun = false

    @Parameter(title: "Message") var message: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard SpendCaptureSettings.enabled, let hid = SpendCaptureSettings.householdId else {
            return .result(dialog: "Turn on Automatic spending in HomeHub Settings first.")
        }
        guard SpendCaptureSettings.looksLikePayment(message) else { return .result(dialog: "Not a completed payment — skipped.") }
        FirebaseBootstrap.configure()
        guard Auth.auth().currentUser != nil else { return .result(dialog: "Sign in to HomeHub first.") }
        let r = try await Gateway.shared.call("POST", "/v1/households/\(hid)/spend/captures", body: [
            "source": "ios_shortcut", "text": message, "receivedAt": ISO8601DateFormatter().string(from: .now),
        ])
        switch r["status"] as? String {
        case "captured": return .result(dialog: "Added to HomeHub → To review.")
        case "duplicate": return .result(dialog: "Already in HomeHub.")
        default: return .result(dialog: "Not a completed payment — skipped.")
        }
    }
}

struct HomeHubAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: LogBankMessageIntent(), phrases: ["Log bank message in \(.applicationName)"],
                    shortTitle: "Log bank message", systemImageName: "indianrupeesign.circle")
    }
}

// MARK: Review inbox

private let incomeCategories = ["Salary", "Business", "Interest", "Gift", "Other"]
let expenseCategories = ["Groceries", "Utilities", "Rent", "Transport", "Dining", "Health", "Education", "Household", "Repairs", "Entertainment", "Other"]

struct SpendReviewView: View {
    @Environment(\.household) private var hOpt
    @State private var items: [[String: Any]]?
    @State private var error: String?
    @State private var tick = 0
    @State private var chosen: [String: String] = [:]
    @State private var busy: String?
    @State private var dismissing: JItem?
    @State private var note: String?
    @State private var importing = false

    var body: some View {
        if let h = hOpt {
            Screen(title: "To review", subtitle: "Payments captured automatically") {
                HHButton(title: "Import a statement", kind: .secondary, systemImage: "doc.badge.arrow.up") { importing = true }
                    .padding(.top, Space.md)
                if let list = items {
                    if list.isEmpty {
                        EmptyStateView(systemImage: "tray", title: "Nothing to review", message: "Payments captured from your bank messages appear here. Nothing is added to Finance until you confirm it.")
                    } else {
                        VStack(spacing: Space.sm) {
                            ForEach(Array(list.enumerated()), id: \.offset) { _, x in card(h, x) }
                        }.padding(.top, Space.md)
                        Text("Your choice of category is remembered for the next payment to the same merchant.").font(HHFont.caption).foregroundStyle(HH.inkTertiary).padding(.top, Space.sm)
                    }
                } else if let error { ErrorStateView(message: error) { tick += 1 } }
                else { LoadingSkeleton().padding(.top, Space.lg) }
            }
            .refreshable { tick += 1 }
            .sheet(isPresented: $importing) { StatementImportSheet(h: h) { tick += 1 }.presentationDetents([.large]) }
            .task(id: tick) {
                do { items = (try await Gateway.shared.call("GET", "/v1/households/\(h.hid)/spend/captures"))["items"] as? [[String: Any]] ?? []; error = nil }
                catch { self.error = error.localizedDescription }
            }
            .confirmationDialog("Dismiss this payment?", isPresented: Binding(get: { dismissing != nil }, set: { if !$0 { dismissing = nil } }), titleVisibility: .visible, presenting: dismissing) { x in
                Button("Dismiss", role: .destructive) {
                    Task {
                        do { try await Gateway.shared.call("POST", "/v1/households/\(h.hid)/spend/captures/\(x.id)/dismiss"); items = items?.filter { ($0["id"] as? String) != x.id } }
                        catch { note = error.localizedDescription }
                    }
                }
            } message: { _ in Text("It won't be added to Finance. You can still add it by hand.") }
            .overlay(alignment: .bottom) {
                if let note { Text(note).font(HHFont.bodyCompact).padding(.horizontal, Space.lg).padding(.vertical, Space.sm).glassSurface(Capsule()).padding(.bottom, Space.lg)
                    .task(id: note) { try? await Task.sleep(for: .seconds(3)); self.note = nil } }
            }
        }
    }

    @ViewBuilder private func card(_ h: HouseholdContext, _ x: [String: Any]) -> some View {
        let id = x["id"] as? String ?? ""
        let credit = x["direction"] as? String == "credit"
        let cats = credit ? incomeCategories : expenseCategories
        let suggested = (x["suggestedCategory"] as? String).flatMap { cats.contains($0) ? $0 : nil } ?? "Other"
        let cat = chosen[id] ?? suggested
        let amount = (x["amountMinor"] as? NSNumber)?.int64Value ?? 0
        let when = (x["occurredAt"] as? String).flatMap { ISO8601DateFormatter.withFractions.date(from: $0) ?? ISO8601DateFormatter().date(from: $0) }
        let method = ["upi": "UPI", "card": "Card", "bank_transfer": "Bank transfer", "wallet": "Wallet"][x["method"] as? String ?? ""]
        HHCard {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(x["merchant"] as? String ?? (credit ? "Money received" : "Payment")).font(HHFont.cardTitle).foregroundStyle(HH.ink)
                    Text([when.map { Dates.relative($0, tz: h.tz) }, method, (x["accountLast4"] as? String).map { "a/c ••\($0)" }].compactMap { $0 }.joined(separator: " · "))
                        .font(HHFont.caption).foregroundStyle(HH.inkSecondary)
                }
                Spacer()
                Text((credit ? "+" : "") + Money.format(amount, x["currency"] as? String ?? h.currency)).font(HHFont.numeric).foregroundStyle(credit ? HH.success : HH.ink)
            }
            if x["possibleDuplicateOf"] as? String != nil { StatusBadge(label: "Possibly already recorded", tone: .warning, systemImage: "doc.on.doc") }
            ChoiceChips(options: cats.map { ($0, $0) }, selection: Binding(get: { cat }, set: { chosen[id] = $0 }))
            HStack(spacing: Space.sm) {
                HHButton(title: credit ? "Add income" : "Add expense", loading: busy == id) {
                    busy = id
                    Task {
                        do {
                            try await Gateway.shared.call("POST", "/v1/households/\(h.hid)/spend/captures/\(id)/confirm", body: ["category": cat])
                            items = items?.filter { ($0["id"] as? String) != id }; note = "Added to Finance"
                        } catch { note = error.localizedDescription }
                        busy = nil
                    }
                }
                HHButton(title: "Dismiss", kind: .secondary, fullWidth: false) { dismissing = JItem(x) }
            }
        }
    }
}

extension ISO8601DateFormatter {
    static let withFractions: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
}

// MARK: Settings

struct SpendCaptureSettingsSection: View {
    let h: HouseholdContext
    @State private var enabled = SpendCaptureSettings.enabled
    @State private var disclosing = false
    @Environment(\.openURL) private var openURL

    var body: some View {
        if h.canFinance {
            SectionHeader(title: "Automatic spending")
            GroupedList {
                Toggle(isOn: Binding(get: { enabled }, set: { on in if on { disclosing = true } else { SpendCaptureSettings.disable(); enabled = false } })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Capture from bank messages").font(HHFont.cardTitle).foregroundStyle(HH.ink)
                        Text(enabled ? "On · set up the Shortcuts automation below" : "Uses a Shortcuts automation for bank SMS").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
                    }
                }.tint(HH.brand).padding(.horizontal, Space.md).padding(.vertical, Space.sm)
                if enabled {
                    RowDivider()
                    VStack(alignment: .leading, spacing: Space.xs) {
                        Text("One-time setup in Shortcuts").font(HHFont.label).foregroundStyle(HH.ink)
                        ForEach(Array([
                            "Open Shortcuts → Automation → New Automation → Message.",
                            "Message Contains: debited. Choose Run Immediately.",
                            "Add the action Log bank message (HomeHub) and set Message to Shortcut Input.",
                            "Repeat for spent and credited if your bank uses those words.",
                        ].enumerated()), id: \.offset) { i, step in
                            HStack(alignment: .firstTextBaseline, spacing: Space.xs) {
                                Text("\(i + 1).").font(HHFont.bodyCompact.monospacedDigit()).foregroundStyle(HH.inkSecondary)
                                Text(step).font(HHFont.bodyCompact).foregroundStyle(HH.ink)
                            }
                        }
                        HHButton(title: "Open Shortcuts", kind: .secondary, systemImage: "square.2.layers.3d", fullWidth: false) {
                            if let u = URL(string: "shortcuts://") { openURL(u) }
                        }.padding(.top, Space.xs)
                    }
                    .padding(.horizontal, Space.md).padding(.vertical, Space.sm)
                }
            }
            Text("Only messages that look like a completed payment leave this phone. HomeHub keeps the amount, merchant and date — never the message itself.")
                .font(HHFont.caption).foregroundStyle(HH.inkTertiary).padding(.top, Space.xs)
                .confirmationDialog("Capture spending automatically?", isPresented: $disclosing, titleVisibility: .visible) {
                    Button("Continue") { SpendCaptureSettings.enable(hid: h.hid); enabled = true }
                } message: {
                    Text("Bank messages you send to HomeHub from Shortcuts are checked on this phone; completed payments go to HomeHub's server for \(h.household.name) and wait in To review until you confirm them. Turn this off at any time.")
                }
        }
    }
}
