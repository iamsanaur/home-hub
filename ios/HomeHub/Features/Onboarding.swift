import SwiftUI
import FirebaseFirestore

private let steps = ["household", "location", "invite", "budget", "preferences", "autonomy"]
let currencies = ["INR", "USD", "EUR", "GBP", "AED", "SGD", "AUD", "CAD", "JPY", "CHF", "SAR", "ZAR", "NZD", "KWD"]

let autonomyModes: [(String, String, String)] = [
    ("assistant", "Assistant", "Only suggests. Every change waits for your approval."),
    ("copilot", "Copilot", "Prepares changes; you approve each one."),
    ("routine", "Routine (recommended)", "Handles safe, reversible chores — tasks, lists, reminders — on its own."),
    ("advanced", "Advanced", "Also makes bounded changes like meal plans. Purchases, payments and bookings still need approval."),
]

let roleHelp: [(Role, String)] = [
    (.admin, "Manages members, settings and the assistant. Sees everything."),
    (.adult, "Full household access, including finance unless you restrict it."),
    (.child, "Sees and completes their own tasks, shared events and notes. No finance."),
    (.staff, "Sees only assigned work — tasks, cleaning, shopping and pantry."),
]

/// Onboarding (claude.md §17): each step is persisted so the flow resumes; optional steps can be skipped.
struct OnboardingFlow: View {
    let uid: String
    let savedStep: String?
    let hid: String?
    @State private var step = "household"
    @State private var name = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.md) {
                    let idx = steps.firstIndex(of: step) ?? 0
                    Text("Step \(idx + 1) of \(steps.count)").font(HHFont.caption).foregroundStyle(HH.inkSecondary)
                    ProgressView(value: Double(idx + 1), total: Double(steps.count)).tint(HH.brand)
                    switch step {
                    case "household": HouseholdStep(name: $name, next: { go("location") }, joined: finish)
                    case "location": LocationStep(name: name, next: { go("invite") })
                    case "invite": if let hid { title("Invite your household", "Add family or staff. Each role only sees what it needs. You can do this later in Family."); InviteForm(hid: hid); HHButton(title: "Continue", kind: .tertiary) { go("budget") } }
                    case "budget": if let hid { BudgetStep(hid: hid, uid: uid, next: { go("preferences") }) }
                    case "preferences": if let hid { PreferencesStep(hid: hid, next: { go("autonomy") }) }
                    default: if let hid { AutonomyStep(hid: hid, done: finish) }
                    }
                }
                .frame(maxWidth: 520).padding(Space.xl).frame(maxWidth: .infinity)
            }
            .background(HH.canvas)
        }
        .onAppear {
            if let s = savedStep, steps.contains(s) { step = (hid == nil && (steps.firstIndex(of: s) ?? 0) > 1) ? "household" : s }
        }
    }

    private func go(_ s: String) {
        step = s
        Firestore.firestore().document("users/\(uid)").setData(["onboarding": ["step": s, "completed": false]], merge: true)
    }
    private func finish() { Firestore.firestore().document("users/\(uid)").setData(["onboarding": ["step": "done", "completed": true]], merge: true) }
    @ViewBuilder private func title(_ t: String, _ why: String) -> some View {
        Text(t).font(HHFont.screenTitle).foregroundStyle(HH.ink)
        Text(why).font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
    }
}

private struct HouseholdStep: View {
    @Binding var name: String
    let next: () -> Void, joined: () -> Void
    @State private var code = ""
    @State private var busy = false
    @State private var error: String?
    @State private var tried = false
    var body: some View {
        Text("Set up your household").font(HHFont.screenTitle).foregroundStyle(HH.ink)
        Text("Create a new household, or join one you were invited to.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
        HHTextField(label: "Household name", text: $name, error: tried && name.isEmpty ? "Give your household a name." : nil, placeholder: "e.g. Sharma Home")
        HHButton(title: "Continue") { tried = true; if !name.isEmpty { next() } }
        Text("Have an invitation code?").font(HHFont.cardTitle).foregroundStyle(HH.ink).padding(.top, Space.lg)
        HHTextField(label: "Invitation code", text: $code, helper: "Paste the code a household member shared with you.", error: error).textInputAutocapitalization(.never)
        HHButton(title: "Join household", kind: .secondary, loading: busy) {
            guard code.count >= 20 else { error = "That code looks too short. Paste the full code."; return }
            busy = true; error = nil
            Task { do { try await Gateway.shared.call("POST", "/v1/invitations/accept", body: ["token": code.trimmingCharacters(in: .whitespaces)]); joined() } catch { self.error = error.localizedDescription }; busy = false }
        }
    }
}

private struct LocationStep: View {
    let name: String, next: () -> Void
    @State private var currency: String = {
        let code = Locale.current.currency?.identifier ?? "INR"
        return currencies.contains(code) ? code : "INR"
    }()
    @State private var timezone = TimeZone.current.identifier
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        Text("Location, currency and time").font(HHFont.screenTitle).foregroundStyle(HH.ink)
        Text("Amounts are recorded in this currency, and reminders follow this time zone.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
        Text("Currency").font(HHFont.label).foregroundStyle(HH.ink)
        ChoiceChips(options: currencies.map { ($0, $0) }, selection: $currency)
        HHTextField(label: "Time zone", text: $timezone, helper: "Detected from this device (IANA name, e.g. Asia/Kolkata).", error: TimeZone(identifier: timezone) == nil ? "Unknown time zone" : nil)
        if let error { Text(error).font(HHFont.bodyCompact).foregroundStyle(HH.danger) }
        HHButton(title: "Create household", loading: busy) {
            guard TimeZone(identifier: timezone) != nil else { return }
            busy = true; error = nil
            var body: [String: Any] = ["name": name, "currency": currency, "timezone": timezone, "locale": Locale.current.identifier.replacingOccurrences(of: "_", with: "-")]
            if let r = Locale.current.region?.identifier, r.count == 2 { body["country"] = r }
            Task { do { try await Gateway.shared.call("POST", "/v1/households", body: body); next() } catch { self.error = error.localizedDescription }; busy = false }
        }
    }
}

struct RolePicker: View {
    @Binding var role: Role
    var body: some View {
        ForEach(roleHelp, id: \.0) { r, help in
            Button { role = r } label: {
                HStack(alignment: .top, spacing: Space.sm) {
                    Image(systemName: role == r ? "largecircle.fill.circle" : "circle").foregroundStyle(role == r ? HH.brand : HH.inkSecondary)
                    VStack(alignment: .leading) { Text(r.label).font(HHFont.cardTitle).foregroundStyle(HH.ink); Text(help).font(HHFont.caption).foregroundStyle(HH.inkSecondary) }
                    Spacer()
                }
                .contentShape(Rectangle()).frame(minHeight: 44)
            }
            .buttonStyle(.plain).accessibilityAddTraits(role == r ? .isSelected : [])
        }
    }
}

/// Invitation form (onboarding and Family). Shows a one-time code to share.
struct InviteForm: View {
    let hid: String
    @State private var name = ""
    @State private var email = ""
    @State private var role: Role = .adult
    @State private var busy = false
    @State private var code: String?
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            HHTextField(label: "Name", text: $name, optional: true)
            HHTextField(label: "Email", text: $email, optional: true, helper: "If you add an email, only that person can use the invitation.", keyboard: .emailAddress).textInputAutocapitalization(.never)
            Text("Role").font(HHFont.label).foregroundStyle(HH.ink)
            RolePicker(role: $role)
            if let code {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Share this code. It works once and expires in 7 days.").font(HHFont.caption).foregroundStyle(HH.inkSecondary)
                    Text(code).font(.body.monospaced()).foregroundStyle(HH.ink).textSelection(.enabled)
                    ShareLink(item: "Join our HomeHub household with this code: \(code)") { Label("Share code", systemImage: "square.and.arrow.up") }.foregroundStyle(HH.brand)
                }
                .padding(Space.md).frame(maxWidth: .infinity, alignment: .leading).background(HH.brandTint, in: RoundedRectangle(cornerRadius: Radius.input))
            }
            if let error { Text(error).font(HHFont.bodyCompact).foregroundStyle(HH.danger) }
            HHButton(title: code == nil ? "Create invitation" : "Invite someone else", kind: code == nil ? .primary : .secondary, loading: busy) {
                busy = true; error = nil
                var body: [String: Any] = ["role": role.rawValue]
                if !email.isEmpty { body["email"] = email }
                if !name.isEmpty { body["displayName"] = name }
                Task { do { code = try await Gateway.shared.call("POST", "/v1/households/\(hid)/invitations", body: body)["token"] as? String; name = ""; email = "" } catch { self.error = error.localizedDescription }; busy = false }
            }
        }
    }
}

private struct BudgetStep: View {
    let hid: String, uid: String, next: () -> Void
    @State private var budget = ""
    @State private var billName = ""
    @State private var billAmount = ""
    @State private var billDay = ""
    @State private var currency = "INR"
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        Text("Budget and recurring bills").font(HHFont.screenTitle).foregroundStyle(HH.ink)
        Text("Optional. A monthly budget lets HomeHub flag overspending; bills get reminders before they're due.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
        HHTextField(label: "Monthly household budget (\(currency))", text: $budget, optional: true, keyboard: .decimalPad)
        HHTextField(label: "A recurring bill", text: $billName, optional: true, placeholder: "e.g. Electricity")
        HStack { HHTextField(label: "Amount", text: $billAmount, optional: true, keyboard: .decimalPad); HHTextField(label: "Due day (1–28)", text: $billDay, optional: true, keyboard: .numberPad) }
        if let error { Text(error).font(HHFont.bodyCompact).foregroundStyle(HH.danger) }
        HHButton(title: "Save and continue", loading: busy) {
            error = nil
            let limit = budget.isEmpty ? nil : Money.parse(budget, currency: currency)
            if !budget.isEmpty && limit == nil { error = "Budget isn't a valid amount."; return }
            let amt = billAmount.isEmpty ? nil : Money.parse(billAmount, currency: currency)
            let day = Int(billDay)
            if !billName.isEmpty && (amt == nil || day == nil || !(1...28).contains(day!)) { error = "Add the bill's amount and a due day between 1 and 28."; return }
            busy = true
            Task {
                do {
                    let period = String(ISO8601DateFormatter().string(from: .now).prefix(7))
                    if let limit { try await HouseholdWrites.create(hid, "budgets", uid: uid, ["period": period, "category": "*", "limitMinor": limit, "currency": currency], id: "\(period)-all") }
                    if !billName.isEmpty, let amt, let day {
                        var comps = Calendar.current.dateComponents([.year, .month], from: .now); comps.day = day; comps.hour = 10
                        var due = Calendar.current.date(from: comps) ?? .now
                        if due < .now { due = Calendar.current.date(byAdding: .month, value: 1, to: due) ?? due }
                        try await HouseholdWrites.create(hid, "bills", uid: uid, ["name": billName, "category": "Utilities", "amountMinor": amt, "currency": currency, "nextDueAt": Timestamp(date: due),
                                                                                  "seriesStartAt": Timestamp(date: due), "recurrence": ["freq": "monthly"], "reminderDaysBefore": 3, "active": true, "status": "upcoming", "provider": NSNull()])
                    }
                    next()
                } catch { self.error = "Couldn't save. Try again." }
                busy = false
            }
        }
        HHButton(title: "Skip for now", kind: .tertiary, action: next)
            .task { currency = (try? await Firestore.firestore().document("households/\(hid)").getDocument().data()?["currency"] as? String) ?? "INR" }
    }
}

private struct PreferencesStep: View {
    let hid: String, next: () -> Void
    @State private var diet = ""
    @State private var allergies = ""
    @State private var busy = false
    var body: some View {
        Text("Household preferences").font(HHFont.screenTitle).foregroundStyle(HH.ink)
        Text("Optional. The assistant uses only what you write here — it never guesses diets or allergies.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
        HHTextField(label: "Food preferences", text: $diet, optional: true, placeholder: "e.g. Vegetarian on Tuesdays", multiline: true)
        HHTextField(label: "Allergies", text: $allergies, optional: true, helper: "Recorded exactly as entered. Shared with adults in your household.", multiline: true)
        HHButton(title: "Save and continue", loading: busy) {
            busy = true
            Task {
                if !diet.isEmpty || !allergies.isEmpty {
                    try? await Firestore.firestore().document("households/\(hid)/preferences/dietary").setData(["notes": diet, "allergies": allergies.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }, "source": "user"])
                }
                busy = false; next()
            }
        }
        HHButton(title: "Skip for now", kind: .tertiary, action: next)
    }
}

struct AutonomyPicker: View {
    @Binding var mode: String
    var body: some View {
        ForEach(autonomyModes, id: \.0) { id, title, help in
            Button { mode = id } label: {
                HStack(alignment: .top, spacing: Space.sm) {
                    Image(systemName: mode == id ? "largecircle.fill.circle" : "circle").foregroundStyle(mode == id ? HH.brand : HH.inkSecondary)
                    VStack(alignment: .leading) { Text(title).font(HHFont.cardTitle).foregroundStyle(HH.ink); Text(help).font(HHFont.caption).foregroundStyle(HH.inkSecondary) }
                    Spacer()
                }.contentShape(Rectangle()).frame(minHeight: 44)
            }
            .buttonStyle(.plain).accessibilityAddTraits(mode == id ? .isSelected : [])
        }
    }
}

private struct AutonomyStep: View {
    let hid: String, done: () -> Void
    @State private var mode = "routine"
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        Text("How much should the assistant do?").font(HHFont.screenTitle).foregroundStyle(HH.ink)
        Text("You can change this or pause the assistant at any time in Settings.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
        AutonomyPicker(mode: $mode)
        if let error { Text(error).font(HHFont.bodyCompact).foregroundStyle(HH.danger) }
        HHButton(title: "Finish setup", loading: busy) {
            busy = true
            Task { do { try await Gateway.shared.call("POST", "/v1/households/\(hid)/autonomy", body: ["mode": mode]); done() } catch { self.error = error.localizedDescription }; busy = false }
        }
    }
}
