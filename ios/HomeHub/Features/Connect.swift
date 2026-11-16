import SwiftUI

// Gateway control plane (addendum Phase 1–3): integrations, model accounts, devices, automations,
// channels and Alexa, agents & skills, activity/audit and privacy. Mirrors Android's ConnectScreens;
// every call goes through the HomeHub gateway, which enforces policy, approvals and audit server-side.

// MARK: API

enum ConnectAPI {
    private static func h(_ hid: String) -> String { "/v1/households/\(hid)" }
    private static func get(_ p: String) async throws -> [String: Any] { try await Gateway.shared.call("GET", p) }
    @discardableResult
    private static func send(_ m: String, _ p: String, _ body: [String: Any]? = nil) async throws -> [String: Any] { try await Gateway.shared.call(m, p, body: body) }

    static func status(_ hid: String) async throws -> [String: Any] { try await get("\(h(hid))/gateway/status") }
    static func catalog() async throws -> [[String: Any]] { try await get("/v1/catalog").objs("items") }
    static func integrations(_ hid: String) async throws -> [[String: Any]] { try await get("\(h(hid))/integrations").objs("items") }
    static func connect(_ hid: String, pluginId: String, config: [String: String], secrets: [String: String], scope: String? = nil) async throws -> [String: Any] {
        var b: [String: Any] = ["pluginId": pluginId, "consent": true]
        if let scope { b["scope"] = scope }
        if !config.isEmpty { b["config"] = config }
        if !secrets.isEmpty { b["secrets"] = secrets }
        return try await send("POST", "\(h(hid))/integrations", b)
    }
    static func test(_ hid: String, _ iid: String) async throws -> [String: Any] { try await send("POST", "\(h(hid))/integrations/\(iid)/test") }
    static func pause(_ hid: String, _ iid: String, _ paused: Bool) async throws { try await send("POST", "\(h(hid))/integrations/\(iid)/pause", ["paused": paused]) }
    static func disconnect(_ hid: String, _ iid: String) async throws { try await send("DELETE", "\(h(hid))/integrations/\(iid)?deleteData=false") }
    static func makeDefault(_ hid: String, _ iid: String) async throws { try await send("PATCH", "\(h(hid))/integrations/\(iid)", ["isDefault": true]) }

    static func modelAccounts(_ hid: String) async throws -> [String: Any] { try await get("\(h(hid))/model-accounts") }
    static func startOpenRouter(_ hid: String, scope: String) async throws -> URL {
        let r = try await send("POST", "\(h(hid))/model-accounts/openrouter/start", ["scope": scope])
        guard let s = r.str("authUrl"), let url = URL(string: s) else { throw GatewayError(status: 0, code: "bad_response", message: "The server didn't return a sign-in link.") }
        return url
    }

    static func devices(_ hid: String) async throws -> [String: Any] { try await get("\(h(hid))/devices") }
    static func deviceAction(_ hid: String, _ did: String, _ action: [String: Any], confirmed: Bool) async throws -> [String: Any] {
        var b: [String: Any] = ["action": action]
        if confirmed { b["confirmed"] = true }
        return try await send("POST", "\(h(hid))/devices/\(did)/actions", b)
    }
    static func exposeDevice(_ hid: String, _ did: String, _ on: Bool) async throws { try await send("PATCH", "\(h(hid))/devices/\(did)", ["alexaExposed": on]) }
    static func exposeRoom(_ hid: String, _ rid: String, _ on: Bool) async throws { try await send("PATCH", "\(h(hid))/rooms/\(rid)", ["alexaExposed": on]) }

    static func automations(_ hid: String) async throws -> [[String: Any]] { try await get("\(h(hid))/automations").objs("items") }
    static func saveAutomation(_ hid: String, _ body: [String: Any], id: String? = nil) async throws {
        if let id { try await send("PUT", "\(h(hid))/automations/\(id)", body) } else { try await send("POST", "\(h(hid))/automations", body) }
    }
    static func deleteAutomation(_ hid: String, _ id: String) async throws { try await send("DELETE", "\(h(hid))/automations/\(id)") }
    static func testAutomation(_ hid: String, _ id: String, execute: Bool) async throws -> [String: Any] { try await send("POST", "\(h(hid))/automations/\(id)/test", ["execute": execute]) }
    static func automationRuns(_ hid: String, _ id: String) async throws -> [[String: Any]] { try await get("\(h(hid))/automations/\(id)/runs").objs("items") }

    static func channels(_ hid: String) async throws -> [[String: Any]] { try await get("\(h(hid))/channels").objs("items") }
    static func disconnectAlexa(_ hid: String) async throws { try await send("DELETE", "\(h(hid))/channels/alexa") }
    static func agents(_ hid: String) async throws -> [String: Any] { try await get("\(h(hid))/agents") }
    static func setSkill(_ hid: String, _ name: String, _ on: Bool) async throws { try await send("PATCH", "\(h(hid))/skills/\(name)", ["enabled": on]) }
    static func privacy(_ hid: String) async throws -> [String: Any] { try await get("\(h(hid))/privacy") }
    static func audit(_ hid: String, channel: String?, before: String?) async throws -> [[String: Any]] {
        var q = URLComponents()
        q.queryItems = [channel.map { URLQueryItem(name: "channel", value: $0) }, before.map { URLQueryItem(name: "before", value: $0) }].compactMap { $0 }
        let qs = q.queryItems!.isEmpty ? "" : "?" + (q.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
        return try await get("\(h(hid))/audit-events\(qs)").objs("items")
    }
}

extension Dictionary where Key == String, Value == Any {
    func objs(_ k: String) -> [[String: Any]] { (self[k] as? [Any])?.compactMap { $0 as? [String: Any] } ?? [] }
    func strs(_ k: String) -> [String] { (self[k] as? [Any])?.compactMap { $0 as? String } ?? [] }
    func o(_ k: String) -> [String: Any] { self[k] as? [String: Any] ?? [:] }
}

/// Makes a gateway JSON object usable with `.sheet(item:)`.
struct JItem: Identifiable {
    let id: String, d: [String: Any]
    init(_ d: [String: Any]) { self.d = d; id = d.str("id") ?? UUID().uuidString }
}

// MARK: Shared helpers

private func isOffline(_ e: Error?) -> Bool { (e as? GatewayError)?.code == "network" }
private func friendly(_ e: Error?) -> String {
    if isOffline(e) { return "You're offline. Connections need the HomeHub server." }
    return e?.localizedDescription ?? "Something went wrong."
}
private func humanize(_ s: String?) -> String {
    let t = (s ?? "").replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: ".", with: " ").replacingOccurrences(of: "-", with: " ")
    return t.prefix(1).uppercased() + t.dropFirst()
}
private func statusTone(_ s: String?) -> Tone {
    switch s {
    case "connected", "succeeded", "verified", "ok", "ready", "active", "available": .success
    case "paused", "needs_setup", "action_required", "approval_required", "needs_model_account", "needs_platform_credentials", "partial", "skipped": .warning
    case "error", "failed", "denied", "disconnected", "offline": .danger
    default: .neutral
    }
}
private func statusLabel(_ s: String?) -> String {
    switch s {
    case "needs_platform_credentials": "Awaiting setup"
    case "needs_model_account": "Needs a model account"
    case "not_configured": "Not configured"
    case "approval_required": "Needs approval"
    default: humanize(s)
    }
}
private func parseISO(_ s: String?) -> Date? {
    guard let s else { return nil }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s)
}
private func whenText(_ iso: String?, _ tz: TimeZone) -> String { parseISO(iso).map { Dates.relative($0, tz: tz) } ?? "—" }

/// Loading / error / content for one gateway read.
private struct RemoteContent<T, Content: View>: View {
    let value: T?
    let error: Error?
    let retry: () -> Void
    @ViewBuilder let content: (T) -> Content
    var body: some View {
        if let value { content(value) }
        else if let error {
            if isOffline(error) { EmptyStateView(systemImage: "wifi.slash", title: "You're offline", message: friendly(error), actionTitle: "Try again", action: retry) }
            else { ErrorStateView(message: friendly(error), retry: retry) }
        } else { LoadingSkeleton().padding(.top, Space.lg) }
    }
}

/// Transient confirmation on a small glass capsule (glass is for floating controls only — design.md §3).
private struct NoticeModifier: ViewModifier {
    @Binding var text: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottom) {
                if let text {
                    Text(text).font(HHFont.bodyCompact).foregroundStyle(HH.ink).multilineTextAlignment(.center)
                        .padding(.horizontal, Space.lg).padding(.vertical, Space.sm)
                        .glassSurface(Capsule())
                        .padding(.horizontal, Space.md).padding(.bottom, Space.lg)
                        .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                        .onTapGesture { self.text = nil }
                        .task(id: text) { try? await Task.sleep(for: .seconds(3)); self.text = nil }
                }
            }
            .animation(reduceMotion ? nil : .snappy, value: text)
            .onChange(of: text) { _, t in if let t { AccessibilityNotification.Announcement(t).post() } }
    }
}
private extension View { func notice(_ text: Binding<String?>) -> some View { modifier(NoticeModifier(text: text)) } }

/// Solid form sheet (forms never sit on glass — design.md §3).
private struct SheetForm<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView { VStack(alignment: .leading, spacing: Space.md) { content }.padding(Space.lg) }
                .background(HH.canvas)
                .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}

private struct AuditRow: View {
    let e: [String: Any], tz: TimeZone
    var body: some View {
        let target = e.o("target")
        let sub = [target.str("name") ?? target.str("type").map(humanize), e.str("channel").map(humanize), whenText(e.str("createdAt"), tz)].compactMap { $0 }.joined(separator: " · ")
        HHListRow(title: humanize(e.str("requestedAction")), subtitle: sub, trailing: AnyView(StatusBadge(label: statusLabel(e.str("result")), tone: statusTone(e.str("result")))))
    }
}

private struct StatusLine: View {
    let title: String, status: String?
    var body: some View {
        let tone = statusTone(status)
        let icon: String? = switch tone { case .success: "checkmark.circle"; case .warning, .danger: "exclamationmark.circle"; default: nil }
        let badge = StatusBadge(label: statusLabel(status), tone: tone, systemImage: icon).fixedSize()
        let name = Text(title).font(HHFont.cardTitle).foregroundStyle(HH.ink)
        // Badge beside the title when it fits; below it on narrow widths or large text — never truncated.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Space.sm) { name.fixedSize(); Spacer(minLength: Space.sm); badge }
            VStack(alignment: .leading, spacing: Space.xxs) { name; badge }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, Space.md).padding(.vertical, Space.sm)
        .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

private struct ChevronRow: View {
    let title: String, subtitle: String?, systemImage: String
    var body: some View { HHListRow(title: title, subtitle: subtitle, systemImage: systemImage, trailing: AnyView(Image(systemName: "chevron.right").foregroundStyle(HH.inkTertiary))) }
}

// MARK: Connections hub

struct ConnectionsView: View {
    @Environment(\.household) private var hOpt
    @State private var data: [String: Any]?
    @State private var error: Error?
    @State private var tick = 0

    var body: some View {
        if let h = hOpt {
            Screen(title: "Connections", subtitle: h.household.name) {
                RemoteContent(value: data, error: error, retry: { tick += 1 }) { s in
                    SectionHeader(title: "Status")
                    GroupedList {
                        StatusLine(title: "Assistant on this phone", status: s.o("agents").str("phone"))
                        RowDivider()
                        StatusLine(title: "Server assistant (fallback)", status: s.o("agents").str("server"))
                        RowDivider()
                        let integ = s.o("integrations")
                        HHListRow(title: "Integrations", subtitle: integ.isEmpty ? "None connected" : integ.sorted { $0.key < $1.key }.map { "\($0.value) \(statusLabel($0.key).lowercased())" }.joined(separator: " · "))
                        RowDivider()
                        let dev = s.o("devices"), offline = Int(dev.dbl("offline") ?? 0)
                        HHListRow(title: "Devices", subtitle: "\(Int(dev.dbl("total") ?? 0)) total",
                                  trailing: offline > 0 ? AnyView(StatusBadge(label: "\(offline) offline", tone: .warning, systemImage: "wifi.slash")) : nil)
                        RowDivider()
                        let runs = s.o("automations24h")
                        HHListRow(title: "Automations, last 24 h", subtitle: runs.isEmpty ? "No runs" : runs.sorted { $0.key < $1.key }.map { "\($0.value) \(humanize($0.key).lowercased())" }.joined(separator: " · "))
                    }
                    if s.bool("paused") {
                        HHCard { Label("Automated actions are paused for this household.", systemImage: "pause.circle").font(HHFont.bodyCompact).foregroundStyle(HH.ink) }.padding(.top, Space.sm)
                    }
                }
                SectionHeader(title: "Manage")
                GroupedList {
                    link("AI model", "Use your own OpenRouter, OpenAI, Gemini or other account", "sparkles") { ModelAccountsView() }
                    RowDivider(); link("Integrations", "Connect services and devices", "puzzlepiece.extension") { IntegrationsView() }
                    RowDivider(); link("Devices", "Lights, plugs, AC, locks and sensors", "lightbulb") { DevicesView() }
                    RowDivider(); link("Automations", "When this happens, do that", "bolt") { AutomationsView() }
                    RowDivider(); link("Channels and Alexa", "Where you can reach HomeHub", "waveform") { ChannelsView() }
                    RowDivider(); link("Agents and skills", "What the assistant can do", "brain") { AgentsView() }
                    RowDivider(); link("Activity and audit", "Every action, who did it and the result", "clock.arrow.circlepath") { ActivityView() }
                    RowDivider(); link("Privacy and permissions", "What each connection can see and keep", "hand.raised") { ConnectPrivacyView() }
                }
                let events = data?.objs("recentEvents") ?? []
                if !events.isEmpty {
                    SectionHeader(title: "Recent activity")
                    GroupedList { ForEach(Array(events.prefix(5).enumerated()), id: \.offset) { i, e in if i > 0 { RowDivider() }; AuditRow(e: e, tz: h.tz) } }
                    NavigationLink { ActivityView() } label: { Text("See all activity").font(HHFont.label).foregroundStyle(HH.brand).frame(minHeight: 44) }
                }
            }
            .refreshable { tick += 1 }
            .task(id: tick) { do { data = try await ConnectAPI.status(h.hid); error = nil } catch { self.error = error } }
        }
    }
    private func link<D: View>(_ t: String, _ s: String, _ icon: String, @ViewBuilder _ dest: () -> D) -> some View {
        NavigationLink { dest() } label: { ChevronRow(title: t, subtitle: s, systemImage: icon) }.buttonStyle(.plain)
    }
}

// MARK: AI model accounts (bring your own)

struct ModelAccountsView: View {
    @Environment(\.household) private var hOpt
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var phase
    @State private var data: [String: Any]?
    @State private var error: Error?
    @State private var tick = 0
    @State private var keyFor: JItem?
    @State private var removing: JItem?
    @State private var busy: String?
    @State private var note: String?

    var body: some View {
        if let h = hOpt {
            Screen(title: "AI model", subtitle: "Whose account the assistant uses") {
                RemoteContent(value: data, error: error, retry: { tick += 1 }) { d in
                    let active = d["active"] as? [String: Any]
                    HHCard {
                        Text(active.map { "Using \($0.str("label") ?? "")" } ?? "No model account yet").font(HHFont.cardTitle).foregroundStyle(HH.ink)
                        Text(active.map { "Quick requests: \($0.str("modelSimple") ?? "—") · Planning: \($0.str("modelComplex") ?? "—"). Your key stays on HomeHub's server; it never reaches this phone." }
                             ?? "Connect your own account to use the assistant. Everything else in HomeHub works without one.")
                            .font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
                    }.padding(.top, Space.md)
                    let accounts = d.objs("items")
                    if !accounts.isEmpty {
                        SectionHeader(title: "Connected accounts")
                        GroupedList {
                            ForEach(Array(accounts.enumerated()), id: \.offset) { i, a in
                                if i > 0 { RowDivider() }
                                let iid = a.str("id") ?? ""
                                let mine = a.bool("ownedByMe") || h.role.isManager
                                let sub = [a.str("scope") == "household" ? "Household account" : "Your account", statusLabel(a.str("status")), a.str("lastError")].compactMap { $0 }.joined(separator: " · ")
                                HStack(spacing: 0) {
                                    Button { if mine { removing = JItem(a) } } label: { HHListRow(title: a.str("name") ?? "Account", subtitle: sub, systemImage: "key") }
                                        .buttonStyle(.plain).disabled(!mine)
                                        .accessibilityHint(mine ? "Remove this account" : "")
                                    if a.bool("isDefault") { StatusBadge(label: "Default", tone: .brand, systemImage: "checkmark.circle").padding(.trailing, Space.md) }
                                    else if mine {
                                        HHButton(title: "Use", kind: .tertiary, loading: busy == iid, fullWidth: false) {
                                            busy = iid
                                            Task { do { try await ConnectAPI.makeDefault(h.hid, iid) } catch { note = friendly(error) }; busy = nil; tick += 1 }
                                        }.padding(.trailing, Space.xs)
                                    }
                                }
                            }
                        }
                    }
                    SectionHeader(title: "Add an account")
                    if !h.role.isAdultPlus { Text("Only adults can connect a model account.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary) }
                    else {
                        GroupedList {
                            ForEach(Array(d.objs("providers").enumerated()), id: \.offset) { i, p in
                                if i > 0 { RowDivider() }
                                let oauth = p.str("signIn") == "oauth"
                                HHListRow(title: p.str("name") ?? "",
                                          subtitle: oauth ? "Sign in with your account; reaches Claude, GPT, Gemini, Llama and more" : "Paste an API key from your \(p.str("name") ?? "") account",
                                          trailing: AnyView(HHButton(title: oauth ? "Sign in" : "Add key", kind: .secondary, loading: oauth && busy == "openrouter", fullWidth: false) {
                                              if oauth {
                                                  busy = "openrouter"
                                                  Task { do { openURL(try await ConnectAPI.startOpenRouter(h.hid, scope: "personal")) } catch { note = friendly(error) }; busy = nil }
                                              } else { keyFor = JItem(p) }
                                          }))
                            }
                        }
                    }
                    Text("Usage is billed by the provider to the account you connect. HomeHub records only token counts.").font(HHFont.caption).foregroundStyle(HH.inkTertiary).padding(.top, Space.sm)
                }
            }
            .refreshable { tick += 1 }
            .task(id: tick) { do { data = try await ConnectAPI.modelAccounts(h.hid); error = nil } catch { self.error = error } }
            // Returning from the browser sign-in (homehub://model-accounts) — refresh.
            .onChange(of: phase) { _, p in if p == .active { tick += 1 } }
            .sheet(item: $keyFor) { p in
                ApiKeySheet(provider: p.d, canHousehold: h.role.isManager) { key, simple, complex, household in
                    var cfg: [String: String] = [:]
                    if !simple.isEmpty { cfg["modelSimple"] = simple }
                    if !complex.isEmpty { cfg["modelComplex"] = complex }
                    do {
                        let r = try await ConnectAPI.connect(h.hid, pluginId: p.d.str("pluginId") ?? "", config: cfg, secrets: ["apiKey": key], scope: household ? "household" : "personal")
                        let ok = r.str("status") == "connected"
                        if ok, let iid = r.str("integrationId") { try? await ConnectAPI.makeDefault(h.hid, iid) }
                        note = ok ? "Connected" : "Saved, but the key was rejected — check it and try again"
                        keyFor = nil; tick += 1
                    } catch { note = friendly(error) }
                }
            }
            .confirmationDialog("Remove \(removing?.d.str("name") ?? "account")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible, presenting: removing) { a in
                Button("Remove", role: .destructive) { Task { do { try await ConnectAPI.disconnect(h.hid, a.id) } catch { note = friendly(error) }; tick += 1 } }
            } message: { _ in Text("HomeHub deletes the stored key. You can also revoke it in your provider account.") }
            .notice($note)
        }
    }
}

private struct ApiKeySheet: View {
    let provider: [String: Any]
    let canHousehold: Bool
    let onSave: (String, String, String, Bool) async -> Void
    @State private var key = ""
    @State private var simple = ""
    @State private var complex = ""
    @State private var household = false
    @State private var consent = false
    @State private var saving = false
    var body: some View {
        let name = provider.str("name") ?? "provider"
        SheetForm(title: "Add \(name) key") {
            HHTextField(label: "API key", text: $key, helper: "Stored in Google Secret Manager on HomeHub's server. It's never shown again or stored on this phone.", secure: true)
            HHTextField(label: "Model for quick requests", text: $simple, optional: true, helper: "Leave blank for HomeHub's default for this provider.")
            HHTextField(label: "Model for planning", text: $complex, optional: true)
            if canHousehold { Toggle("Share with the household (members without their own account use it)", isOn: $household).tint(HH.brand) }
            Toggle("I understand my assistant requests and a compact household summary are sent to \(name) under my account.", isOn: $consent).tint(HH.brand)
            HHButton(title: "Connect", loading: saving) {
                saving = true
                Task { await onSave(key.trimmingCharacters(in: .whitespacesAndNewlines), simple.trimmingCharacters(in: .whitespaces), complex.trimmingCharacters(in: .whitespaces), household); saving = false }
            }.disabled(key.trimmingCharacters(in: .whitespaces).count < 8 || !consent)
            Text("You can remove the key here at any time.").font(HHFont.caption).foregroundStyle(HH.inkTertiary)
        }
    }
}

// MARK: Integrations marketplace

private let categoryNames = ["smart_home": "Smart home", "developer": "Developer", "channels": "Messaging", "productivity": "Email, calendar and files",
                             "finance": "Finance", "shopping": "Shopping", "information": "Information", "ai_provider": "AI models"]

struct IntegrationsView: View {
    @Environment(\.household) private var hOpt
    @State private var catalog: [[String: Any]]?
    @State private var connected: [[String: Any]] = []
    @State private var error: Error?
    @State private var tick = 0
    @State private var filter = 0
    @State private var open: JItem?
    @State private var openConnected: JItem?
    @State private var note: String?

    var body: some View {
        if let h = hOpt {
            Screen(title: "Integrations", subtitle: "Connect services and devices") {
                RemoteContent(value: catalog, error: error, retry: { tick += 1 }) { cat in
                    let entries = cat.filter { $0.str("category") != "ai_provider" }
                    let mine = connected.filter { $0.str("category") != "ai_provider" }
                    GroupedList { NavigationLink { ModelAccountsView() } label: { ChevronRow(title: "AI model accounts", subtitle: "Managed in AI model", systemImage: "sparkles") }.buttonStyle(.plain) }
                        .padding(.top, Space.md)
                    if !mine.isEmpty {
                        SectionHeader(title: "Connected")
                        GroupedList {
                            ForEach(Array(mine.enumerated()), id: \.offset) { i, x in
                                if i > 0 { RowDivider() }
                                Button { openConnected = JItem(x) } label: {
                                    HHListRow(title: x.str("name") ?? "", subtitle: x.str("lastError") ?? "Connected \(whenText(x.str("connectedAt"), h.tz))", systemImage: "point.3.connected.trianglepath.dotted",
                                              trailing: AnyView(StatusBadge(label: statusLabel(x.str("status")), tone: statusTone(x.str("status")))))
                                }.buttonStyle(.plain)
                            }
                        }
                    }
                    SectionHeader(title: "Catalog")
                    ChoiceChips(options: [(0, "Available"), (1, "Coming later")], selection: $filter)
                    let shown = entries.filter { filter == 0 ? $0.str("availability") != "planned" : $0.str("availability") == "planned" }
                    let groups = Dictionary(grouping: shown) { categoryNames[$0.str("category") ?? ""] ?? humanize($0.str("category")) }
                    ForEach(groups.keys.sorted(), id: \.self) { g in
                        Text(g).font(HHFont.label).foregroundStyle(HH.inkSecondary).padding(.top, Space.sm).padding(.bottom, Space.xxs)
                        GroupedList {
                            ForEach(Array(groups[g]!.enumerated()), id: \.offset) { i, e in
                                if i > 0 { RowDivider() }
                                let av = e.str("availability")
                                let row = HHListRow(title: e.str("name") ?? "", subtitle: e.str("note") ?? e.str("description"),
                                                    trailing: av == "available" ? AnyView(Image(systemName: "chevron.right").foregroundStyle(HH.inkTertiary)) : AnyView(StatusBadge(label: av == "planned" ? "Planned" : statusLabel(av), tone: .neutral)))
                                if av == "available" { Button { open = JItem(e) } label: { row }.buttonStyle(.plain) } else { row }
                            }
                        }
                    }
                    Text("“Planned” integrations aren't built yet. HomeHub only lists something as available once it works and is tested.").font(HHFont.caption).foregroundStyle(HH.inkTertiary).padding(.top, Space.sm)
                }
            }
            .refreshable { tick += 1 }
            .task(id: tick) {
                do { async let c = ConnectAPI.catalog(); async let m = ConnectAPI.integrations(h.hid); let (cc, mm) = try await (c, m); catalog = cc; connected = mm; error = nil }
                catch { self.error = error }
            }
            .sheet(item: $open) { e in ConnectSheet(h: h, entry: e.d) { msg in note = msg; open = nil; tick += 1 } }
            .sheet(item: $openConnected) { x in ConnectedSheet(h: h, x: x.d) { msg in note = msg; openConnected = nil; tick += 1 } }
            .notice($note)
        }
    }
}

private struct ConnectSheet: View {
    let h: HouseholdContext, entry: [String: Any]
    let onDone: (String) -> Void
    @State private var values: [String: String] = [:]
    @State private var consent = false
    @State private var saving = false
    @State private var error: String?
    var body: some View {
        let name = entry.str("name") ?? "Integration"
        let fields = entry.objs("config")
        SheetForm(title: name) {
            Text(entry.str("description") ?? "").font(HHFont.body).foregroundStyle(HH.inkSecondary)
            Text("What it can do").font(HHFont.label).foregroundStyle(HH.ink)
            ForEach(Array(entry.objs("tools").enumerated()), id: \.offset) { _, tool in
                VStack(alignment: .leading, spacing: Space.xxs) {
                    Text(tool.str("description") ?? "").font(HHFont.bodyCompact).foregroundStyle(HH.ink)
                    HStack(spacing: Space.xs) {
                        StatusBadge(label: tool.str("access") == "read" ? "Reads" : "Makes changes", tone: .neutral)
                        if tool.str("confirmation") == "approval" { StatusBadge(label: "Always needs approval", tone: .warning, systemImage: "lock") }
                        if tool.str("confirmation") == "confirm" { StatusBadge(label: "Asks you to confirm", tone: .info) }
                        if tool.bool("physicalSafety") { StatusBadge(label: "Physical safety", tone: .danger) }
                    }
                }
            }
            let cats = entry.strs("dataCategories")
            if !cats.isEmpty { Text("Data it uses: \(cats.joined(separator: ", "))").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary) }
            if let r = entry.o("privacy").str("retention") { Text(r).font(HHFont.caption).foregroundStyle(HH.inkSecondary) }
            if !h.role.isManager {
                Text("Ask a household manager to connect this.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
            } else {
                ForEach(Array(fields.enumerated()), id: \.offset) { _, f in
                    let key = f.str("key") ?? ""
                    HHTextField(label: f.str("label") ?? key, text: Binding(get: { values[key] ?? "" }, set: { values[key] = $0 }), optional: !f.bool("required"),
                                helper: f.str("help") ?? (f.bool("secret") ? "Stored in Secret Manager; never shown again." : nil), secure: f.bool("secret"))
                }
                Toggle("I allow \(name) to access the data listed above for this household.", isOn: $consent).tint(HH.brand)
                if let error { Text(error).font(HHFont.bodyCompact).foregroundStyle(HH.danger) }
                let missing = fields.contains { $0.bool("required") && (values[$0.str("key") ?? ""] ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
                HHButton(title: "Connect", loading: saving) {
                    saving = true; error = nil
                    var cfg: [String: String] = [:], sec: [String: String] = [:]
                    for f in fields {
                        guard let k = f.str("key"), let v = values[k], !v.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
                        if f.bool("secret") { sec[k] = v } else { cfg[k] = v.trimmingCharacters(in: .whitespaces) }
                    }
                    Task {
                        do {
                            let r = try await ConnectAPI.connect(h.hid, pluginId: entry.str("id") ?? "", config: cfg, secrets: sec)
                            onDone(r.str("status") == "connected" ? "\(name) connected" : "Connected — needs attention: \(statusLabel(r.str("status")))")
                        } catch { self.error = friendly(error) }
                        saving = false
                    }
                }.disabled(!consent || missing)
            }
        }
    }
}

private struct ConnectedSheet: View {
    let h: HouseholdContext, x: [String: Any]
    let onChanged: (String?) -> Void
    @State private var busy: String?
    @State private var confirm = false
    @State private var error: String?
    var body: some View {
        let iid = x.str("id") ?? "", name = x.str("name") ?? "Integration"
        let paused = x.str("status") == "paused"
        SheetForm(title: name) {
            StatusBadge(label: statusLabel(x.str("status")), tone: statusTone(x.str("status")))
            if let e = x.str("lastError") { Text(e).font(HHFont.bodyCompact).foregroundStyle(HH.danger) }
            Text("Tools turned on: \(x.strs("enabledTools").map(humanize).joined(separator: ", "))").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
            if !h.role.isManager {
                Text("Only household managers can change integrations.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
            } else {
                if let error { Text(error).font(HHFont.bodyCompact).foregroundStyle(HH.danger) }
                HHButton(title: "Test connection", kind: .secondary, loading: busy == "test") {
                    act("test") { let r = try await ConnectAPI.test(h.hid, iid); onChanged("Status: \(statusLabel(r.str("status")))") }
                }.disabled(paused)
                HHButton(title: paused ? "Resume" : "Pause", kind: .secondary, loading: busy == "pause") {
                    act("pause") { try await ConnectAPI.pause(h.hid, iid, !paused); onChanged(paused ? "\(name) resumed" : "\(name) paused") }
                }
                HHButton(title: "Disconnect", kind: .destructive, loading: busy == "disconnect") { confirm = true }
            }
        }
        .confirmationDialog("Disconnect \(name)?", isPresented: $confirm, titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) { act("disconnect") { try await ConnectAPI.disconnect(h.hid, iid); onChanged("Disconnected") } }
        } message: { Text("Stored credentials are deleted and its devices stop working in HomeHub. Device history is kept.") }
    }
    private func act(_ label: String, _ block: @escaping () async throws -> Void) {
        busy = label; error = nil
        Task { do { try await block() } catch { self.error = friendly(error) }; busy = nil }
    }
}

// MARK: Devices

private func caps(_ d: [String: Any]) -> [String] { d.strs("capabilities") }
private func num(_ v: Double) -> String { v.formatted(.number.precision(.fractionLength(0...1))) }

private func stateSummary(_ d: [String: Any], state: [String: Any]? = nil) -> String {
    let s = state ?? d.o("state")
    var parts: [String] = []
    if let p = s.str("power") { parts.append(p == "ON" ? "On" : "Off") }
    if let b = s.dbl("brightness"), caps(d).contains("brightness") { parts.append("\(Int(b))%") }
    if let t = s.dbl("targetTemperature") { parts.append("Set to \(num(t))°") }
    if let t = s.dbl("temperature") { parts.append("\(num(t))°C") }
    if let hu = s.dbl("humidity") { parts.append("\(Int(hu))% humidity") }
    if let l = s.str("lock") { parts.append(l == "LOCKED" ? "Locked" : l == "UNLOCKED" ? "Unlocked" : "Unknown") }
    if let c = s.str("contact") { parts.append(c == "DETECTED" ? "Open" : "Closed") }
    if let m = s.str("motion") { parts.append(m == "DETECTED" ? "Motion" : "No motion") }
    return parts.isEmpty ? "No state yet" : parts.joined(separator: " · ")
}

private func deviceIcon(_ type: String?) -> String {
    switch type {
    case "lock": "lock"
    case "thermostat", "ac", "climate_sensor": "thermometer.medium"
    case "contact_sensor", "motion_sensor": "sensor"
    case "light": "lightbulb"
    default: "power"
    }
}

struct DevicesView: View {
    @Environment(\.household) private var hOpt
    @State private var data: [String: Any]?
    @State private var error: Error?
    @State private var tick = 0
    @State private var open: JItem?
    @State private var note: String?

    var body: some View {
        if let h = hOpt {
            Screen(title: "Devices", subtitle: h.household.name) {
                RemoteContent(value: data, error: error, retry: { tick += 1 }) { d in
                    let devices = d.objs("devices"), rooms = d.objs("rooms")
                    if devices.isEmpty {
                        EmptyStateView(systemImage: "lightbulb", title: "No devices yet", message: "Connect “Demo devices” in Integrations to try HomeHub without hardware, or pair a home bridge.")
                        NavigationLink { IntegrationsView() } label: { Text("Open integrations").font(HHFont.label).foregroundStyle(HH.brand).frame(maxWidth: .infinity, minHeight: 44) }
                    } else {
                        if devices.contains(where: { $0.bool("simulated") }) {
                            HHCard { Label("Some devices are simulated. Nothing physical is controlled.", systemImage: "flask").font(HHFont.bodyCompact).foregroundStyle(HH.ink) }.padding(.top, Space.md)
                        }
                        let roomIds = devices.map { $0.str("roomId") ?? "" }.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
                        ForEach(roomIds, id: \.self) { rid in
                            let room = rooms.first { $0.str("id") == rid }
                            HStack {
                                Text(room?.str("name") ?? "No room").font(HHFont.sectionTitle).foregroundStyle(HH.ink).accessibilityAddTraits(.isHeader)
                                Spacer()
                                if h.role.isManager, let room {
                                    Toggle("Alexa", isOn: Binding(get: { room.bool("alexaExposed") }, set: { v in
                                        Task { do { try await ConnectAPI.exposeRoom(h.hid, rid, v) } catch { note = friendly(error) }; tick += 1 }
                                    }))
                                    .font(HHFont.caption).foregroundStyle(HH.inkSecondary).fixedSize().tint(HH.brand)
                                    .accessibilityLabel("Let Alexa see \(room.str("name") ?? "this room")")
                                }
                            }
                            .padding(.top, Space.xl).padding(.bottom, Space.xs)
                            GroupedList {
                                let list = devices.filter { ($0.str("roomId") ?? "") == rid }
                                ForEach(Array(list.enumerated()), id: \.offset) { i, dev in
                                    if i > 0 { RowDivider() }
                                    let offline = dev["reachable"] != nil && !dev.bool("reachable")
                                    Button { open = JItem(dev) } label: {
                                        HHListRow(title: dev.str("name") ?? "Device", subtitle: stateSummary(dev), systemImage: deviceIcon(dev.str("type")),
                                                  trailing: AnyView(HStack(spacing: Space.xxs) {
                                                      if offline { StatusBadge(label: "Offline", tone: .warning, systemImage: "wifi.slash") }
                                                      if dev.o("alexa").bool("exposed") { StatusBadge(label: "Alexa", tone: .neutral) }
                                                  }))
                                    }.buttonStyle(.plain)
                                }
                            }
                        }
                    }
                }
            }
            .refreshable { tick += 1 }
            .task(id: tick) { do { data = try await ConnectAPI.devices(h.hid); error = nil } catch { self.error = error } }
            .sheet(item: $open) { dev in DeviceSheet(h: h, dev: dev.d) { tick += 1 } }
            .notice($note)
        }
    }
}

private struct DeviceSheet: View {
    let h: HouseholdContext, dev: [String: Any]
    let onChanged: () -> Void
    @State private var state: [String: Any] = [:]
    @State private var busy = false
    @State private var message: String?
    @State private var confirmAction: [String: Any]?
    @State private var exposed = false
    @State private var brightness: Double = 50
    @State private var loaded = false

    var body: some View {
        let did = dev.str("id") ?? ""
        let cs = caps(dev)
        let bridge = dev.str("integrationId")?.hasPrefix("bridge:") == true
        let safety = dev.str("safety") == "physical_safety"
        // Mirrors the server policy: children and staff may switch ordinary devices, never safety ones.
        let canControl = !bridge && (!safety || h.role.isAdultPlus)
        SheetForm(title: dev.str("name") ?? "Device") {
            HStack(spacing: Space.xs) {
                if dev.bool("simulated") { StatusBadge(label: "Simulated", tone: .info, systemImage: "flask") }
                if safety { StatusBadge(label: "Physical safety", tone: .warning, systemImage: "lock") }
            }
            Text(stateSummary(dev, state: state)).font(HHFont.body).foregroundStyle(HH.ink)
            if bridge { Text("This device is reported by your home bridge. Control arrives with the Home Assistant bridge.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary) }
            if canControl {
                if cs.contains("power") {
                    Toggle("Power", isOn: Binding(get: { state.str("power") == "ON" }, set: { run(did, ["type": "power", "value": $0 ? "ON" : "OFF"]) }))
                        .font(HHFont.cardTitle).tint(HH.brand).disabled(busy)
                }
                if cs.contains("brightness") {
                    Text("Brightness \(Int(brightness))%").font(HHFont.label).foregroundStyle(HH.ink)
                    Slider(value: $brightness, in: 0...100, step: 10) { editing in
                        if !editing { run(did, ["type": "brightness", "value": Int(brightness)]) }
                    }
                    .tint(HH.brand).disabled(busy).accessibilityLabel("Brightness")
                }
                if cs.contains("thermostat") {
                    let target = state.dbl("targetTemperature") ?? 24
                    HStack(spacing: Space.sm) {
                        Text("Target \(num(target))°C").font(HHFont.cardTitle).foregroundStyle(HH.ink)
                        Spacer()
                        HHButton(title: "−", kind: .secondary, fullWidth: false) { run(did, ["type": "thermostat", "targetTemperature": max(16, target - 1)]) }
                            .disabled(busy || target <= 16).accessibilityLabel("Lower temperature")
                        HHButton(title: "+", kind: .secondary, fullWidth: false) { run(did, ["type": "thermostat", "targetTemperature": min(30, target + 1)]) }
                            .disabled(busy || target >= 30).accessibilityLabel("Raise temperature")
                    }
                }
                if cs.contains("lock") && h.role.isAdultPlus {
                    if state.str("lock") == "LOCKED" { HHButton(title: "Unlock (needs approval)", kind: .secondary, systemImage: "lock.open", loading: busy) { run(did, ["type": "unlock"]) } }
                    else { HHButton(title: "Lock", systemImage: "lock", loading: busy) { run(did, ["type": "lock"]) } }
                }
            } else if !bridge {
                Text("Ask an adult to use this device.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
            }
            if let message { Text(message).font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary) }
            if h.role.isManager {
                RowDivider()
                Toggle(isOn: Binding(get: { exposed }, set: { v in
                    exposed = v
                    Task { do { try await ConnectAPI.exposeDevice(h.hid, did, v); onChanged() } catch { exposed = !v; message = friendly(error) } }
                })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Let Alexa see this device").font(HHFont.cardTitle).foregroundStyle(HH.ink)
                        Text(safety ? "Alexa can lock it but never unlock it." : "Off by default. Changes apply at Alexa's next discovery.").font(HHFont.caption).foregroundStyle(HH.inkSecondary)
                    }
                }.tint(HH.brand)
            }
        }
        .onAppear {
            guard !loaded else { return }
            loaded = true; state = dev.o("state"); exposed = dev.o("alexa").bool("exposed"); brightness = state.dbl("brightness") ?? 50
        }
        .onChange(of: message) { _, m in if let m { AccessibilityNotification.Announcement(m).post() } }
        .confirmationDialog("Confirm", isPresented: Binding(get: { confirmAction != nil }, set: { if !$0 { confirmAction = nil } }), titleVisibility: .visible) {
            Button("Confirm") { if let a = confirmAction { confirmAction = nil; run(did, a, confirmed: true) } }
        } message: { Text("Do this now on \(dev.str("name") ?? "this device")?") }
    }

    private func run(_ did: String, _ action: [String: Any], confirmed: Bool = false) {
        busy = true; message = nil
        Task {
            do {
                let r = try await ConnectAPI.deviceAction(h.hid, did, action, confirmed: confirmed)
                switch r.str("status") {
                case "verified": state.merge(r.o("state")) { $1 }; message = "Done. The device confirmed it."; onChanged()
                case "approval_required": message = "Sent for approval. Nothing changes until someone approves it in Approvals."
                case "confirmation_required": confirmAction = action
                case "unverified": message = "Sent, but the device didn't confirm the change. Check the device."; onChanged()
                default: message = r.str("message") ?? "The device didn't respond."
                }
            } catch { message = friendly(error) }
            busy = false
        }
    }
}

// MARK: Automations

private func triggerText(_ tr: [String: Any], _ name: (String?) -> String?) -> String {
    switch tr.str("type") {
    case "schedule": "Every day at \(tr.str("time") ?? "")"
    case "device_state": "When \(name(tr.str("deviceId")) ?? "a device") \(humanize(tr.str("property")).lowercased()) changes"
    case "pantry_low": "When something in the pantry runs low"
    case "bill_due": "When a bill is due within \(Int(tr.dbl("withinDays") ?? 3)) days"
    case "webhook": "When a signed webhook arrives"
    default: "When you run it"
    }
}

private func actionText(_ a: [String: Any], _ name: (String?) -> String?) -> String {
    switch a.str("type") {
    case "create_task": "Create task “\(a.str("title") ?? "")”"
    case "notify": "Notify \(a.str("audience") ?? "adults"): \(a.str("title") ?? "")"
    case "add_shopping_item": "Add \(a.str("name") ?? "an item") to the shopping list"
    case "device_action": "\(humanize(a.str("action"))) \(name(a.str("deviceId")) ?? "a device")"
    default: humanize(a.str("type"))
    }
}

/// Rebuild the server input from a stored automation (server fields like lastRunAt are dropped).
private func automationBody(_ a: [String: Any], enabled: Bool? = nil) -> [String: Any] {
    var b: [String: Any] = ["name": a.str("name") ?? "Automation", "enabled": enabled ?? a.bool("enabled"),
                            "trigger": a.o("trigger"), "conditions": a.objs("conditions"), "actions": a.objs("actions")]
    if let c = a.dbl("cooldownMinutes") { b["cooldownMinutes"] = Int(c) }
    if let m = a.dbl("maxRunsPerDay") { b["maxRunsPerDay"] = Int(m) }
    return b
}

struct AutomationsView: View {
    @Environment(\.household) private var hOpt
    @State private var items: [[String: Any]]?
    @State private var devices: [[String: Any]] = []
    @State private var error: Error?
    @State private var tick = 0
    @State private var open: JItem?
    @State private var creating = false
    @State private var note: String?

    var body: some View {
        if let h = hOpt {
            let name = { (id: String?) in devices.first { $0.str("id") == id }?.str("name") }
            Screen(title: "Automations", subtitle: "When this happens, do that") {
                RemoteContent(value: items, error: error, retry: { tick += 1 }) { list in
                    if list.isEmpty {
                        EmptyStateView(systemImage: "bolt", title: "No automations yet",
                                       message: "Automations run checks and actions for you, like a task when the balcony door opens. Unlocking and payments always need approval.",
                                       actionTitle: h.role.isManager ? "Create one" : nil, action: h.role.isManager ? { creating = true } : nil)
                    } else {
                        GroupedList {
                            ForEach(Array(list.enumerated()), id: \.offset) { i, a in
                                if i > 0 { RowDivider() }
                                HStack(spacing: 0) {
                                    Button { open = JItem(a) } label: {
                                        HHListRow(title: a.str("name") ?? "Automation",
                                                  subtitle: "\(triggerText(a.o("trigger"), name)) → \(a.objs("actions").map { actionText($0, name) }.joined(separator: ", "))",
                                                  systemImage: a.o("trigger").str("type") == "schedule" ? "clock" : "bolt",
                                                  trailing: a.str("lastStatus").map { AnyView(StatusBadge(label: statusLabel($0), tone: statusTone($0))) })
                                    }.buttonStyle(.plain)
                                    if h.role.isManager {
                                        Toggle("Enabled", isOn: Binding(get: { a.bool("enabled") }, set: { v in
                                            Task { do { try await ConnectAPI.saveAutomation(h.hid, automationBody(a, enabled: v), id: a.str("id")) } catch { note = friendly(error) }; tick += 1 }
                                        })).labelsHidden().tint(HH.brand).padding(.trailing, Space.md)
                                        .accessibilityLabel("\(a.str("name") ?? "Automation") enabled")
                                    }
                                }
                            }
                        }.padding(.top, Space.md)
                        Text("Automations stop when the household is paused, after their daily limit, and can't trigger themselves in a loop.").font(HHFont.caption).foregroundStyle(HH.inkTertiary).padding(.top, Space.sm)
                    }
                }
            }
            .toolbar { if h.role.isManager { ToolbarItem(placement: .primaryAction) { Button { creating = true } label: { Image(systemName: "plus") }.accessibilityLabel("New automation") } } }
            .refreshable { tick += 1 }
            .task(id: tick) {
                do {
                    items = try await ConnectAPI.automations(h.hid)
                    devices = (try? await ConnectAPI.devices(h.hid).objs("devices")) ?? []
                    error = nil
                } catch { self.error = error }
            }
            .sheet(item: $open) { a in AutomationSheet(h: h, a: a.d, devices: devices) { msg in note = msg; open = nil; tick += 1 } }
            .sheet(isPresented: $creating) { NewAutomationSheet(h: h, devices: devices) { creating = false; note = "Automation saved"; tick += 1 } }
            .notice($note)
        }
    }
}

private struct AutomationSheet: View {
    let h: HouseholdContext, a: [String: Any], devices: [[String: Any]]
    let onChanged: (String?) -> Void
    @State private var runs: [[String: Any]]?
    @State private var runsError: Error?
    @State private var runsTick = 0
    @State private var result: [String: Any]?
    @State private var busy: String?
    @State private var confirmDelete = false
    @State private var error: String?

    var body: some View {
        let id = a.str("id") ?? ""
        let name = { (d: String?) in devices.first { $0.str("id") == d }?.str("name") }
        SheetForm(title: a.str("name") ?? "Automation") {
            Text(triggerText(a.o("trigger"), name)).font(HHFont.body).foregroundStyle(HH.ink)
            ForEach(Array(a.objs("actions").enumerated()), id: \.offset) { _, x in Text("• \(actionText(x, name))").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary) }
            Text("Waits \(Int(a.dbl("cooldownMinutes") ?? 5)) min between runs · at most \(Int(a.dbl("maxRunsPerDay") ?? 24)) runs a day").font(HHFont.caption).foregroundStyle(HH.inkTertiary)
            if h.role.isManager {
                HStack(spacing: Space.sm) {
                    HHButton(title: "Preview", kind: .secondary, loading: busy == "preview") { test(id, execute: false) }
                    HHButton(title: "Run now", loading: busy == "run") { test(id, execute: true) }
                }
            }
            if let error { Text(error).font(HHFont.bodyCompact).foregroundStyle(HH.danger) }
            if let r = result {
                HHCard {
                    StatusBadge(label: statusLabel(r.str("status")), tone: statusTone(r.str("status")))
                    if let reason = r.str("reason") { Text(reason).font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary) }
                    ForEach(Array(r.objs("steps").enumerated()), id: \.offset) { _, s in
                        Text("\(humanize(s.str("status"))): \(s.str("detail") ?? humanize(s.str("action")))").font(HHFont.bodyCompact).foregroundStyle(HH.ink)
                    }
                }
            }
            Text("Recent runs").font(HHFont.label).foregroundStyle(HH.ink)
            RemoteContent(value: runs, error: runsError, retry: { runsTick += 1 }) { list in
                if list.isEmpty { Text("Hasn't run yet.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary) }
                else {
                    GroupedList {
                        ForEach(Array(list.prefix(10).enumerated()), id: \.offset) { i, r in
                            if i > 0 { RowDivider() }
                            HHListRow(title: statusLabel(r.str("status")), subtitle: [r.str("reason"), whenText(r.str("createdAt"), h.tz)].compactMap { $0 }.joined(separator: " · "),
                                      trailing: AnyView(StatusBadge(label: statusLabel(r.str("status")), tone: statusTone(r.str("status")))))
                        }
                    }
                }
            }
            if h.role.isManager { HHButton(title: "Delete automation", kind: .tertiary) { confirmDelete = true } }
        }
        .task(id: runsTick) { do { runs = try await ConnectAPI.automationRuns(h.hid, id); runsError = nil } catch { self.runsError = error } }
        .confirmationDialog("Delete \(a.str("name") ?? "automation")?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { do { try await ConnectAPI.deleteAutomation(h.hid, id); onChanged("Automation deleted") } catch { self.error = friendly(error) } } }
        } message: { Text("It stops running immediately. Its run history is kept for 90 days.") }
    }

    private func test(_ id: String, execute: Bool) {
        busy = execute ? "run" : "preview"; error = nil
        Task {
            do { result = try await ConnectAPI.testAutomation(h.hid, id, execute: execute); if execute { runsTick += 1 } }
            catch { self.error = friendly(error) }
            busy = nil
        }
    }
}

private struct NewAutomationSheet: View {
    let h: HouseholdContext, devices: [[String: Any]]
    let onSaved: () -> Void
    @State private var name = ""
    @State private var trigger = 0 // 0 manual, 1 daily, 2 device, 3 pantry low, 4 bill due
    @State private var time = "21:00"
    @State private var deviceIdx = 0
    @State private var action = 0 // 0 task, 1 notify, 2 device on/off
    @State private var text = ""
    @State private var targetIdx = 0
    @State private var turnOn = false
    @State private var saving = false
    @State private var error: String?

    private static let watchable = ["contact", "motion", "power", "lock", "temperature"]

    var body: some View {
        let sensors = devices.filter { caps($0).contains { Self.watchable.contains($0) } }
        let switchable = devices.filter { caps($0).contains("power") }
        let timeOk = time.range(of: #"^([01]\d|2[0-3]):[0-5]\d$"#, options: .regularExpression) != nil
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let valid = !name.trimmingCharacters(in: .whitespaces).isEmpty && (trigger != 1 || timeOk) && (trigger != 2 || !sensors.isEmpty)
            && (action <= 1 ? !trimmed.isEmpty : !switchable.isEmpty)
        SheetForm(title: "New automation") {
            HHTextField(label: "Name", text: $name, placeholder: "Night check")
            Text("When").font(HHFont.label).foregroundStyle(HH.ink)
            ChoiceChips(options: [(0, "I run it"), (1, "Daily"), (2, "Device"), (3, "Pantry low"), (4, "Bill due")], selection: $trigger)
            if trigger == 1 {
                HHTextField(label: "Time (24-hour)", text: $time, helper: "In the household's time zone", error: timeOk ? nil : "Use HH:MM, like 21:00", keyboard: .numbersAndPunctuation)
            }
            if trigger == 2 {
                if sensors.isEmpty { Text("No devices to watch yet.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary) }
                else { ChoiceList(options: sensors.map { "\($0.str("name") ?? "Device") (\(stateSummary($0)))" }, selected: $deviceIdx) }
            }
            Text("Do").font(HHFont.label).foregroundStyle(HH.ink)
            ChoiceChips(options: [(0, "Create a task"), (1, "Notify adults"), (2, "Switch a device")], selection: $action)
            if action <= 1 {
                HHTextField(label: action == 0 ? "Task" : "Message", text: $text, placeholder: action == 0 ? "Close the balcony door" : "Balcony door is open")
            } else if switchable.isEmpty {
                Text("No switchable devices.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
            } else {
                ChoiceList(options: switchable.map { $0.str("name") ?? "Device" }, selected: $targetIdx)
                Toggle("Turn it on (otherwise off)", isOn: $turnOn).tint(HH.brand)
            }
            if let error { Text(error).font(HHFont.bodyCompact).foregroundStyle(HH.danger) }
            HHButton(title: "Save automation", loading: saving) {
                var tr: [String: Any]
                switch trigger {
                case 1: tr = ["type": "schedule", "time": time]
                case 2:
                    let d = sensors[min(deviceIdx, sensors.count - 1)]
                    tr = ["type": "device_state", "deviceId": d.str("id") ?? "", "property": caps(d).first { Self.watchable.contains($0) } ?? "power"]
                case 3: tr = ["type": "pantry_low"]
                case 4: tr = ["type": "bill_due", "withinDays": 3]
                default: tr = ["type": "manual"]
                }
                let act: [String: Any] = switch action {
                case 0: ["type": "create_task", "title": trimmed]
                case 1: ["type": "notify", "title": String(trimmed.prefix(120)), "body": String(trimmed.prefix(300)), "audience": "adults"]
                default: ["type": "device_action", "deviceId": switchable[min(targetIdx, switchable.count - 1)].str("id") ?? "", "action": turnOn ? "power_on" : "power_off"]
                }
                saving = true; error = nil
                Task {
                    do { try await ConnectAPI.saveAutomation(h.hid, ["name": name.trimmingCharacters(in: .whitespaces), "trigger": tr, "actions": [act]]); onSaved() }
                    catch { self.error = friendly(error) }
                    saving = false
                }
            }.disabled(!valid)
            Text("Use Preview on the saved automation to check it before it runs for real.").font(HHFont.caption).foregroundStyle(HH.inkTertiary)
        }
    }
}

private struct ChoiceList: View {
    let options: [String]
    @Binding var selected: Int
    var body: some View {
        GroupedList {
            ForEach(Array(options.enumerated()), id: \.offset) { i, o in
                if i > 0 { RowDivider() }
                Button { selected = i } label: {
                    HHListRow(title: o, trailing: i == selected ? AnyView(Image(systemName: "checkmark.circle.fill").foregroundStyle(HH.brand)) : nil)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(i == selected ? .isSelected : [])
            }
        }
    }
}

// MARK: Channels and Alexa

private let channelNames = ["app": "HomeHub app", "push": "Push notifications", "alexa": "Amazon Alexa", "webhook": "Signed webhooks",
                            "telegram": "Telegram", "whatsapp": "WhatsApp", "email": "Email", "sms": "SMS"]

struct ChannelsView: View {
    @Environment(\.household) private var hOpt
    @State private var channels: [[String: Any]]?
    @State private var error: Error?
    @State private var tick = 0
    @State private var confirm = false
    @State private var note: String?

    var body: some View {
        if let h = hOpt {
            Screen(title: "Channels and Alexa", subtitle: "Where you can reach HomeHub") {
                RemoteContent(value: channels, error: error, retry: { tick += 1 }) { list in
                    let alexa = list.first { $0.str("type") == "alexa" }
                    let st = alexa?.str("status")
                    let linkedMe = alexa?.strs("linkedMembers").contains(h.uid) == true
                    SectionHeader(title: "Amazon Alexa")
                    HHCard {
                        HStack {
                            Text(linkedMe ? "Linked to your account" : "Not linked to your account").font(HHFont.cardTitle).foregroundStyle(HH.ink)
                            Spacer()
                            StatusBadge(label: statusLabel(st), tone: statusTone(st))
                        }
                        Text(st == "needs_platform_credentials" ? "Alexa isn't set up on this HomeHub server yet. A HomeHub administrator needs to add the Alexa skill credentials."
                             : linkedMe ? "Say “Alexa, ask Home Hub what's on the shopping list”, or control devices you've shared. Alexa can lock doors but never unlock them."
                             : "In the Alexa app, open Skills, find HomeHub, choose Enable, then sign in with your HomeHub email. Only adults can link.")
                            .font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
                        Text("HomeHub never receives or stores voice recordings — only the request type, time and result.").font(HHFont.caption).foregroundStyle(HH.inkTertiary)
                        HStack(spacing: Space.sm) {
                            NavigationLink { DevicesView() } label: { Text("Choose devices").font(.body.weight(.semibold)).padding(.horizontal, Space.lg).frame(minHeight: 48) }
                                .buttonStyle(HHButtonStyle(kind: .secondary))
                            if linkedMe { HHButton(title: "Disconnect", kind: .tertiary, fullWidth: false) { confirm = true } }
                        }.padding(.top, Space.xs)
                    }
                    SectionHeader(title: "All channels")
                    GroupedList {
                        let others = list.filter { $0.str("type") != "alexa" }
                        ForEach(Array(others.enumerated()), id: \.offset) { i, ch in
                            if i > 0 { RowDivider() }
                            let type = ch.str("type") ?? ""
                            let sub: String? = switch type {
                            case "webhook": "Set up in Integrations"
                            case "app", "push": "Always on for members"
                            default: ch.bool("implemented") ? nil : "Not built yet"
                            }
                            let row = HHListRow(title: channelNames[type] ?? humanize(type), subtitle: sub, trailing: AnyView(StatusBadge(label: statusLabel(ch.str("status")), tone: statusTone(ch.str("status")))))
                            if type == "webhook" { NavigationLink { IntegrationsView() } label: { row }.buttonStyle(.plain) } else { row }
                        }
                    }
                }
            }
            .refreshable { tick += 1 }
            .task(id: tick) { do { channels = try await ConnectAPI.channels(h.hid); error = nil } catch { self.error = error } }
            .confirmationDialog("Disconnect Alexa?", isPresented: $confirm, titleVisibility: .visible) {
                Button("Disconnect", role: .destructive) { Task { do { try await ConnectAPI.disconnectAlexa(h.hid); note = "Alexa disconnected" } catch { note = friendly(error) }; tick += 1 } }
            } message: { Text("Alexa stops working with HomeHub for your account immediately. You can link again from the Alexa app.") }
            .notice($note)
        }
    }
}

// MARK: Agents and skills

struct AgentsView: View {
    @Environment(\.household) private var hOpt
    @State private var data: [String: Any]?
    @State private var error: Error?
    @State private var tick = 0
    @State private var note: String?

    var body: some View {
        if let h = hOpt {
            Screen(title: "Agents and skills", subtitle: "What the assistant can do") {
                RemoteContent(value: data, error: error, retry: { tick += 1 }) { d in
                    SectionHeader(title: "Agents")
                    GroupedList {
                        ForEach(Array(d.objs("agents").enumerated()), id: \.offset) { i, a in
                            if i > 0 { RowDivider() }
                            HHListRow(title: a.str("name") ?? "", subtitle: a.str("description"), systemImage: "brain",
                                      trailing: AnyView(StatusBadge(label: statusLabel(a.str("status")), tone: statusTone(a.str("status")))))
                        }
                    }
                    if let s = d.str("specialists") { Text(s).font(HHFont.caption).foregroundStyle(HH.inkTertiary).padding(.top, Space.xs) }
                    SectionHeader(title: "Skills")
                    GroupedList {
                        ForEach(Array(d.objs("skills").enumerated()), id: \.offset) { i, s in
                            if i > 0 { RowDivider() }
                            let skill = s.str("name") ?? ""
                            let runs = Int(s.o("usage30d").dbl("runs") ?? 0)
                            HHListRow(title: humanize(skill), subtitle: "\(s.str("description") ?? "") · \(runs) runs in 30 days",
                                      trailing: h.role.isManager
                                        ? AnyView(Toggle("\(humanize(skill)) enabled", isOn: Binding(get: { s.bool("enabled") }, set: { v in
                                            Task { do { try await ConnectAPI.setSkill(h.hid, skill, v) } catch { note = friendly(error) }; tick += 1 }
                                        })).labelsHidden().tint(HH.brand).disabled(skill == "household-manager"))
                                        : AnyView(StatusBadge(label: s.bool("enabled") ? "On" : "Off", tone: s.bool("enabled") ? .success : .neutral)))
                        }
                    }
                    Text("Household manager is the fallback skill and stays on. Turning a skill off sends its requests to the household manager instead.").font(HHFont.caption).foregroundStyle(HH.inkTertiary).padding(.top, Space.xs)
                }
            }
            .refreshable { tick += 1 }
            .task(id: tick) { do { data = try await ConnectAPI.agents(h.hid); error = nil } catch { self.error = error } }
            .notice($note)
        }
    }
}

// MARK: Activity and audit

private let auditFilters: [(String, String?)] = [("All", nil), ("App", "app"), ("Alexa", "alexa"), ("Automations", "automation"), ("Assistant", "agent"), ("Webhooks", "webhook")]

struct ActivityView: View {
    @Environment(\.household) private var hOpt
    @State private var filter = 0
    @State private var items: [[String: Any]]?
    @State private var error: Error?
    @State private var tick = 0
    @State private var hasMore = false
    @State private var loadingMore = false

    var body: some View {
        if let h = hOpt {
            Screen(title: "Activity and audit", subtitle: h.role.isManager ? "Everything that happened in \(h.household.name)" : "Your actions") {
                ChoiceChips(options: auditFilters.indices.map { ($0, auditFilters[$0].0) }, selection: $filter).padding(.top, Space.md)
                RemoteContent(value: items, error: error, retry: { tick += 1 }) { all in
                    if all.isEmpty {
                        EmptyStateView(systemImage: "clock.arrow.circlepath", title: "Nothing here yet", message: "Actions by people, the assistant, automations and Alexa appear here.")
                    } else {
                        GroupedList { ForEach(Array(all.enumerated()), id: \.offset) { i, e in if i > 0 { RowDivider() }; AuditRow(e: e, tz: h.tz) } }.padding(.top, Space.sm)
                        if hasMore {
                            HHButton(title: "Load more", kind: .tertiary, loading: loadingMore) {
                                loadingMore = true
                                Task {
                                    if let page = try? await ConnectAPI.audit(h.hid, channel: auditFilters[filter].1, before: all.last?.str("createdAt")) {
                                        items = all + page; hasMore = page.count == 50
                                    }
                                    loadingMore = false
                                }
                            }.padding(.top, Space.sm)
                        }
                        Text("Kept for the household's audit trail. Voice audio is never stored.").font(HHFont.caption).foregroundStyle(HH.inkTertiary).padding(.top, Space.sm)
                    }
                }
            }
            .refreshable { tick += 1 }
            .task(id: "\(filter)-\(tick)") {
                items = nil
                do { let page = try await ConnectAPI.audit(h.hid, channel: auditFilters[filter].1, before: nil); items = page; hasMore = page.count == 50; error = nil }
                catch { self.error = error }
            }
        }
    }
}

// MARK: Privacy and permissions

struct ConnectPrivacyView: View {
    @Environment(\.household) private var hOpt
    @State private var data: [String: Any]?
    @State private var error: Error?
    @State private var tick = 0

    var body: some View {
        if let h = hOpt {
            Screen(title: "Privacy and permissions", subtitle: "What each connection can see and keep") {
                RemoteContent(value: data, error: error, retry: { tick += 1 }) { d in
                    let list = d.objs("integrations")
                    SectionHeader(title: "Connections")
                    if list.isEmpty { Text("Nothing is connected. HomeHub's own data stays in your household.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary) }
                    else {
                        GroupedList {
                            ForEach(Array(list.enumerated()), id: \.offset) { i, x in
                                if i > 0 { RowDivider() }
                                VStack(alignment: .leading, spacing: Space.xxs) {
                                    HStack {
                                        Text(x.str("name") ?? "").font(HHFont.cardTitle).foregroundStyle(HH.ink)
                                        Spacer()
                                        StatusBadge(label: x.str("scope") == "personal" ? "Only you" : "Household", tone: .neutral)
                                    }
                                    let cats = x.strs("dataCategories")
                                    if !cats.isEmpty { Text("Uses: \(cats.joined(separator: ", "))").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary) }
                                    if let r = x.str("retention") { Text(r).font(HHFont.caption).foregroundStyle(HH.inkSecondary) }
                                    Text([x.bool("credentialsStored") ? "Credentials in Secret Manager" : "No credentials stored", x.str("consentedAt").map { "allowed \(whenText($0, h.tz))" }].compactMap { $0 }.joined(separator: " · "))
                                        .font(HHFont.caption).foregroundStyle(HH.inkTertiary)
                                }
                                .padding(.horizontal, Space.md).padding(.vertical, Space.sm)
                                .accessibilityElement(children: .combine)
                            }
                        }
                    }
                    SectionHeader(title: "Alexa")
                    Text(d.o("alexa").str("note") ?? "").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
                    SectionHeader(title: "Your data")
                    GroupedList {
                        NavigationLink { SettingsView() } label: { ChevronRow(title: "Export or delete your data", subtitle: "In Settings", systemImage: "hand.raised") }.buttonStyle(.plain)
                        RowDivider()
                        NavigationLink { ActivityView() } label: { ChevronRow(title: "See every action", subtitle: "Activity and audit", systemImage: "clock.arrow.circlepath") }.buttonStyle(.plain)
                    }
                }
            }
            .refreshable { tick += 1 }
            .task(id: tick) { do { data = try await ConnectAPI.privacy(h.hid); error = nil } catch { self.error = error } }
        }
    }
}
