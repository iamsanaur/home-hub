import SwiftUI
import SwiftData
import FirebaseFirestore

// MARK: Family

struct FamilyView: View {
    @Environment(\.household) private var hOpt
    @Query private var tasks: [LocalTask]
    @State private var inviting = false
    @State private var managing: Member?
    @State private var invites: LiveQuery<Record>?
    var body: some View {
        if let h = hOpt {
            Screen(title: "Family", subtitle: "\(h.members.count) members") {
                SectionHeader(title: "Members")
                GroupedList {
                    ForEach(Array(h.members.enumerated()), id: \.element.id) { i, m in
                        if i > 0 { RowDivider() }
                        let open = tasks.filter { $0.householdId == h.hid && $0.assigneeUid == m.id && $0.status != "done" }.count
                        HStack(spacing: Space.sm) {
                            MemberAvatar(name: m.displayName)
                            VStack(alignment: .leading) {
                                Text(m.displayName + (m.id == h.uid ? " (you)" : "")).font(HHFont.cardTitle).foregroundStyle(HH.ink)
                                Text("\(m.role.label) · \(open) open task\(open == 1 ? "" : "s")" + (m.role == .staff ? " · assigned work only" : (m.role.isAdultPlus ? (m.financeAllowed ? " · finance" : " · no finance") : "")))
                                    .font(HHFont.caption).foregroundStyle(HH.inkSecondary)
                            }
                            Spacer()
                            if h.role.isManager && m.id != h.uid && m.role != .owner { Button("Manage") { managing = m }.font(HHFont.label).foregroundStyle(HH.brand).frame(minHeight: 44) }
                        }
                        .padding(.horizontal, Space.md).padding(.vertical, Space.sm)
                    }
                }
                let pending = invites?.items ?? []
                if !pending.isEmpty {
                    SectionHeader(title: "Pending invitations")
                    GroupedList {
                        ForEach(Array(pending.enumerated()), id: \.element.id) { i, inv in
                            if i > 0 { RowDivider() }
                            HHListRow(title: inv.s("displayName") ?? inv.s("email") ?? "Invitation", subtitle: (Role(rawValue: inv.s("role") ?? "") ?? .adult).label + " · awaiting acceptance",
                                      trailing: AnyView(Button("Revoke") { Task { try? await Gateway.shared.call("DELETE", "/v1/households/\(h.hid)/invitations/\(inv.id)") } }.font(HHFont.label).foregroundStyle(HH.brand)))
                        }
                    }
                }
                SectionHeader(title: "Schedules")
                GroupedList {
                    NavigationLink { RecordListView(spec: .calendar(h)) } label: { HHListRow(title: "Family calendar", subtitle: "Appointments, birthdays, school", systemImage: "calendar", trailing: AnyView(Image(systemName: "chevron.right").foregroundStyle(HH.inkTertiary))) }.buttonStyle(.plain)
                    RowDivider()
                    NavigationLink { TasksView() } label: { HHListRow(title: "Assignments", subtitle: "Who is doing what", systemImage: "checklist", trailing: AnyView(Image(systemName: "chevron.right").foregroundStyle(HH.inkTertiary))) }.buttonStyle(.plain)
                }
                HHCard {
                    Text("Privacy by role").font(HHFont.cardTitle)
                    Text("Staff see only their assigned work. Children see their own tasks and shared events. Finance and documents stay with permitted adults.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
                }.padding(.top, Space.lg)
            }
            .toolbar { if h.role.isManager { ToolbarItem(placement: .primaryAction) { Button { inviting = true } label: { Image(systemName: "person.badge.plus") }.accessibilityLabel("Invite") } } }
            .sheet(isPresented: $inviting) { NavigationStack { ScrollView { InviteForm(hid: h.hid).padding(Space.lg) }.navigationTitle("Invite to \(h.household.name)").navigationBarTitleDisplayMode(.inline) } }
            .sheet(item: $managing) { m in ManageMember(h: h, member: m) }
            .task(id: h.hid) { if h.role.isManager { invites = LiveQuery(Firestore.firestore().collection("households/\(h.hid)/invitations").whereField("status", isEqualTo: "pending")) { Record(id: $0, data: $1) } } }
        }
    }
}

private struct ManageMember: View {
    let h: HouseholdContext, member: Member
    @Environment(\.dismiss) private var dismiss
    @State private var role: Role = .adult
    @State private var finance = true
    @State private var busy = false
    @State private var confirmRemove = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.md) {
                    RolePicker(role: $role)
                    if role == .adult || role == .admin { Toggle("Can see household finance", isOn: $finance).tint(HH.brand) }
                    if let error { Text(error).font(HHFont.bodyCompact).foregroundStyle(HH.danger) }
                    HHButton(title: "Save", loading: busy) {
                        busy = true
                        Task {
                            do {
                                if role != member.role { try await Gateway.shared.call("PATCH", "/v1/households/\(h.hid)/members/\(member.id)", body: ["role": role.rawValue]) }
                                if (role == .adult || role == .admin) && finance != member.financeAllowed { try await Gateway.shared.call("PATCH", "/v1/households/\(h.hid)/members/\(member.id)", body: ["permissions": ["finance": finance]]) }
                                dismiss()
                            } catch { self.error = error.localizedDescription }
                            busy = false
                        }
                    }
                    HHButton(title: "Remove from household", kind: .tertiary) { confirmRemove = true }
                }.padding(Space.lg)
            }
            .navigationTitle(member.displayName).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .onAppear { role = member.role; finance = member.financeAllowed }
            .confirmationDialog("Remove \(member.displayName)?", isPresented: $confirmRemove, titleVisibility: .visible) {
                Button("Remove", role: .destructive) { Task { try? await Gateway.shared.call("DELETE", "/v1/households/\(h.hid)/members/\(member.id)"); dismiss() } }
            } message: { Text("They'll lose access immediately. Their completed work stays in the history.") }
        }
    }
}

// MARK: Insights

struct InsightsView: View {
    @Environment(\.household) private var hOpt
    @State private var report: Loadable<[String: Any]> = .loading
    @State private var usage: [String: Any]?
    var body: some View {
        if let h = hOpt {
            Screen(title: "Insights", subtitle: "Last 30 days · recorded data") {
                switch report {
                case .loading: LoadingSkeleton()
                case .failed(let m): ErrorStateView(message: m) { Task { await load(h) } }
                case .ready(let o):
                    if let f = o["finance"] as? [String: Any] {
                        let exp = (f["expenseMinor"] as? NSNumber)?.int64Value ?? 0
                        SectionHeader(title: "Spending")
                        HHCard {
                            Text("Spent \(Money.format(exp, h.currency)) · earned \(Money.format((f["incomeMinor"] as? NSNumber)?.int64Value ?? 0, h.currency))").font(HHFont.cardTitle)
                            ForEach(Array(((f["byCategory"] as? [[String: Any]]) ?? []).prefix(6).enumerated()), id: \.offset) { _, c in
                                let amt = (c["amountMinor"] as? NSNumber)?.int64Value ?? 0
                                ProgressRow(label: c["category"] as? String ?? "", fraction: Double(Money.percent(amt, of: max(exp, 1))) / 100, value: Money.format(amt, h.currency)).padding(.vertical, 4)
                            }
                        }
                    }
                    if let t = o["tasks"] as? [String: Any] {
                        SectionHeader(title: "Tasks")
                        let done = t["completed"] as? Int ?? 0, onTime = t["onTime"] as? Int ?? 0
                        HHCard {
                            Text("\(done) completed · \(t["openNow"] as? Int ?? 0) open now").font(HHFont.cardTitle)
                            if done > 0 { ProgressRow(label: "On time", fraction: Double(onTime) / Double(done), value: "\(onTime * 100 / done)%") }
                        }
                    }
                    SectionHeader(title: "Shopping, maintenance and waste")
                    GroupedList {
                        if let s = o["shopping"] as? [String: Any] { let n = s["itemsPurchased"] as? Int ?? 0; HHListRow(title: "Groceries bought", subtitle: "\(n) item\(n == 1 ? "" : "s") · \(Money.format((s["spentMinor"] as? NSNumber)?.int64Value ?? 0, h.currency))") }
                        RowDivider()
                        if let m = o["maintenance"] as? [String: Any] { HHListRow(title: "Maintenance", subtitle: "\(m["requests"] as? Int ?? 0) requests · \(m["completed"] as? Int ?? 0) done · \(Money.format((m["costMinor"] as? NSNumber)?.int64Value ?? 0, h.currency))") }
                        RowDivider()
                        if let w = o["wastage"] as? [String: Any] { HHListRow(title: "Pantry waste", subtitle: "\(w["events"] as? Int ?? 0) items wasted") }
                    }
                    if let u = usage { UsageCard(u: u) }
                }
            }
            .task(id: h.hid) { await load(h) }
            .refreshable { await load(h) }
        }
    }
    private func load(_ h: HouseholdContext) async {
        guard h.role.isAdultPlus else { report = .failed("Reports are available to adults in the household."); return }
        do { report = .ready(try await Gateway.shared.call("GET", "/v1/households/\(h.hid)/reports/overview")) } catch { report = .failed(error.localizedDescription) }
        if h.role.isManager { usage = try? await Gateway.shared.call("GET", "/v1/households/\(h.hid)/agent/usage") }
    }
}

struct UsageCard: View {
    let u: [String: Any]
    var body: some View {
        let tokens = u["tokens"] as? [String: Any]
        SectionHeader(title: "Assistant usage")
        HHCard {
            Text("\(u["runs"] as? Int ?? 0) runs · \(tokens?["total"] as? Int ?? 0) tokens").font(HHFont.cardTitle)
            Text("Per successful request: \((u["tokensPerSuccessfulRun"] as? Int).map(String.init) ?? "—") tokens · cached \(tokens?["cached"] as? Int ?? 0)").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
            Text("Measured by HomeHub's model proxy, not estimated. Cost shown only when pricing is configured.").font(HHFont.caption).foregroundStyle(HH.inkTertiary)
        }
    }
}

// MARK: Approvals

struct ApprovalsView: View {
    @Environment(\.household) private var hOpt
    @State private var q: LiveQuery<Approval>?
    @State private var busy: String?
    @State private var message: String?
    var body: some View {
        if let h = hOpt {
            let items = (q?.items ?? []).filter { ($0.expiresAt ?? .distantFuture) > .now }
            Screen(title: "Approvals", subtitle: "\(items.count) waiting") {
                if !h.role.isAdultPlus { EmptyStateView(systemImage: "checkmark.shield", title: "Adults decide approvals", message: "Requests you make will appear for the adults in your household.") }
                else if items.isEmpty { EmptyStateView(systemImage: "checkmark.circle", title: "Nothing waiting", message: "Purchases, payments, bookings and other sensitive actions appear here for a decision.") }
                if let message { Text(message).font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary) }
                ForEach(items) { a in ApprovalCardView(approval: a, ctx: h, busy: busy == a.id) { decide(h, a, $0) }.padding(.vertical, 6) }
            }
            .task(id: h.hid) { if h.role.isAdultPlus { q = LiveQuery(Firestore.firestore().collection("households/\(h.hid)/approvals").whereField("status", isEqualTo: "pending").order(by: "createdAt", descending: true).limit(to: 30)) { Approval(id: $0, $1) } } }
        }
    }
    private func decide(_ h: HouseholdContext, _ a: Approval, _ approve: Bool) {
        busy = a.id
        Task {
            do {
                let r = try await Gateway.shared.call("POST", "/v1/households/\(h.hid)/approvals/\(a.id)/decision", body: ["decision": approve ? "approve" : "reject"])
                message = switch r["status"] as? String { case "executed": "Approved and done."; case "approved": "Approved — a person needs to complete it."; case "failed": "Approved, but it couldn't be completed."; default: "Rejected." }
            } catch { message = error.localizedDescription }
            busy = nil
        }
    }
}

// MARK: Notifications

struct NotificationsView: View {
    @Environment(\.household) private var hOpt
    @State private var q: LiveQuery<Record>?
    var body: some View {
        if let h = hOpt {
            Screen(title: "Notifications") {
                let items = q?.items ?? []
                if items.isEmpty { EmptyStateView(systemImage: "bell", title: "You're all caught up", message: "Reminders, approvals and briefings appear here.") }
                else {
                    GroupedList {
                        ForEach(Array(items.enumerated()), id: \.element.id) { i, n in
                            if i > 0 { RowDivider() }
                            Button { Firestore.firestore().document("households/\(h.hid)/notifications/\(n.id)").updateData(["readAt": FieldValue.serverTimestamp()]) } label: {
                                HHListRow(title: n.s("title") ?? "", subtitle: (n.s("body") ?? "") + (n.t("createdAt").map { " · \(Dates.relative($0, tz: h.tz))" } ?? ""),
                                          trailing: n.data["readAt"] == nil || n.data["readAt"] is NSNull ? AnyView(StatusBadge(label: "New", tone: .brand)) : nil)
                            }.buttonStyle(.plain)
                        }
                    }
                }
            }
            .task(id: h.hid) { q = LiveQuery(Firestore.firestore().collection("households/\(h.hid)/notifications").whereField("recipientUid", isEqualTo: h.uid).order(by: "createdAt", descending: true).limit(to: 50)) { Record(id: $0, data: $1) } }
        }
    }
}

// MARK: Settings

struct SettingsView: View {
    @Environment(\.household) private var hOpt
    @Environment(AppModel.self) private var model
    @Query private var conflicts: [SyncConflict]
    @Query private var outbox: [OutboxOp]
    @State private var jobs: LiveQuery<Record>?
    @State private var mode = "routine"
    @State private var memories: [[String: Any]] = []
    @State private var prefs: [String: Bool] = [:]
    @State private var confirmPause = false
    @State private var confirmDelete = false
    @State private var message: String?

    var body: some View {
        if let h = hOpt {
            let power = HermesMobile.shared.power.snapshot()
            Screen(title: "Settings") {
                ProfileSettingsSection(h: h)
                SectionHeader(title: "Assistant")
                HHCard {
                    Text(h.household.paused ? "Assistant is paused" : "Assistant is active").font(HHFont.cardTitle).foregroundStyle(h.household.paused ? HH.warning : HH.ink)
                    Text(h.household.paused ? "No autonomous changes until a manager resumes it. Reads still work." : "Emergency pause stops every autonomous change immediately.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
                    if !h.household.paused && h.role.isAdultPlus { HHButton(title: "Pause the assistant", kind: .destructive) { confirmPause = true } }
                    if h.household.paused && h.role.isManager { HHButton(title: "Resume the assistant") { autonomy(h, ["paused": false]) } }
                    if h.role.isManager {
                        Text("Autonomy").font(HHFont.label).padding(.top, Space.sm)
                        AutonomyPicker(mode: Binding(get: { mode }, set: { mode = $0; autonomy(h, ["mode": $0]) }))
                    }
                    Text("Runs on this phone (Hermes Mobile). Battery \(power.levelPercent.map { "\($0)%" } ?? "unknown")\(power.charging ? ", charging" : "") · mode \(power.mode.rawValue). Scheduled assistant jobs run only while charging; otherwise the HomeHub server runs them.")
                        .font(HHFont.caption).foregroundStyle(HH.inkSecondary)
                }
                if h.role.isManager {
                    SectionHeader(title: "Automations")
                    GroupedList {
                        ForEach(Array((jobs?.items ?? []).sorted { $0.id < $1.id }.enumerated()), id: \.element.id) { i, j in
                            if i > 0 { RowDivider() }
                            Toggle(isOn: Binding(get: { j.b("enabled") }, set: { on in Task { try? await Gateway.shared.call("POST", "/v1/households/\(h.hid)/jobs/\(j.id)", body: ["action": on ? "resume" : "pause"]) } })) {
                                VStack(alignment: .leading) {
                                    Text(j.id.replacingOccurrences(of: "_", with: " ").capitalized).font(HHFont.cardTitle)
                                    Text(((j.data.map("schedule")?.str("kind")) ?? "").capitalized + " at " + ((j.data.map("schedule")?.str("time")) ?? "") + (j.b("requiresAgent") ? " · uses the assistant" : "")).font(HHFont.caption).foregroundStyle(HH.inkSecondary)
                                }
                            }.tint(HH.brand).padding(.horizontal, Space.md).padding(.vertical, Space.sm)
                        }
                    }
                }
                SpendCaptureSettingsSection(h: h)
                SectionHeader(title: "Notifications")
                GroupedList {
                    ForEach(Array([("tasks", "Tasks"), ("bills", "Bills"), ("pantry", "Pantry"), ("maintenance", "Maintenance"), ("approvals", "Approvals"), ("agent", "Assistant"), ("briefing", "Daily briefing")].enumerated()), id: \.offset) { i, c in
                        if i > 0 { RowDivider() }
                        Toggle(c.1, isOn: Binding(get: { prefs[c.0] ?? true }, set: { prefs[c.0] = $0; savePrefs(h) })).tint(HH.brand).padding(.horizontal, Space.md).frame(minHeight: 52)
                    }
                }
                SectionHeader(title: "Assistant memory")
                if memories.isEmpty { Text("Nothing remembered. HomeHub never stores whole conversations as memory.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary) }
                else {
                    GroupedList {
                        ForEach(Array(memories.enumerated()), id: \.offset) { i, m in
                            if i > 0 { RowDivider() }
                            HHListRow(title: m["text"] as? String ?? "", subtitle: "\(m["scope"] as? String ?? "") · \(m["kind"] as? String ?? "")",
                                      trailing: AnyView(Button("Forget") { Task { try? await Gateway.shared.call("DELETE", "/v1/households/\(h.hid)/memories/\(m["id"] as? String ?? "")"); await loadMemories(h) } }.foregroundStyle(HH.brand)))
                        }
                    }
                }
                SectionHeader(title: "Sync & diagnostics")
                GroupedList {
                    let pending = outbox.filter { $0.householdId == h.hid && $0.state == "pending" }.count
                    HHListRow(title: "Waiting to sync", subtitle: pending == 0 ? "Everything is up to date" : "\(pending) change\(pending == 1 ? "" : "s") will sync when you're online", systemImage: "arrow.triangle.2.circlepath")
                    RowDivider()
                    let mine = conflicts.filter { $0.householdId == h.hid }
                    NavigationLink { ConflictsView() } label: { HHListRow(title: "Sync conflicts", subtitle: mine.isEmpty ? "None" : "\(mine.count) need your decision", systemImage: "exclamationmark.arrow.triangle.2.circlepath") }.buttonStyle(.plain)
                }
                SectionHeader(title: "Your data")
                GroupedList {
                    Button { Task { do { let d = try await Gateway.shared.call("GET", "/v1/me/export"); message = "Export ready (\(((try? JSONSerialization.data(withJSONObject: d))?.count ?? 0) / 1024) KB)." } catch { message = error.localizedDescription } } } label: { HHListRow(title: "Export my data", subtitle: "Profile, memberships, private notes and memories") }.buttonStyle(.plain)
                    RowDivider()
                    Button { model.signOut() } label: { HHListRow(title: "Sign out") }.buttonStyle(.plain)
                    RowDivider()
                    Button { confirmDelete = true } label: { HHListRow(title: "Delete my account", subtitle: "Removes your profile, private notes and memories") }.buttonStyle(.plain)
                }
                if let message { Text(message).font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary).padding(.top, Space.sm) }
            }
            .onAppear { mode = h.household.autonomyMode }
            .task(id: h.hid) {
                if h.role.isManager { jobs = LiveQuery(Firestore.firestore().collection("households/\(h.hid)/scheduledJobs")) { Record(id: $0, data: $1) } }
                if let d = try? await Firestore.firestore().document("users/\(h.uid)").getDocument().data(), let p = d.map("notificationPrefs")?["categories"] as? [String: Bool] { prefs = p }
                await loadMemories(h)
            }
            .confirmationDialog("Pause the assistant?", isPresented: $confirmPause, titleVisibility: .visible) {
                Button("Pause", role: .destructive) { autonomy(h, ["paused": true]) }
            } message: { Text("Every autonomous change stops for the whole household until a manager resumes it.") }
            .confirmationDialog("Delete your account?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete account", role: .destructive) { Task { do { try await Gateway.shared.call("DELETE", "/v1/me"); model.signOut() } catch { message = error.localizedDescription } } }
            } message: { Text("This permanently removes your profile, private notes and private memories. Shared household records stay.") }
        }
    }
    private func autonomy(_ h: HouseholdContext, _ body: [String: Any]) { Task { do { try await Gateway.shared.call("POST", "/v1/households/\(h.hid)/autonomy", body: body) } catch { message = error.localizedDescription } } }
    private func savePrefs(_ h: HouseholdContext) { Firestore.firestore().document("users/\(h.uid)").setData(["notificationPrefs": ["categories": prefs]], merge: true) }
    private func loadMemories(_ h: HouseholdContext) async { memories = (try? await Gateway.shared.call("GET", "/v1/households/\(h.hid)/memories"))?["items"] as? [[String: Any]] ?? [] }
}

// MARK: Conflicts

struct ConflictsView: View {
    @Environment(\.household) private var hOpt
    @Environment(AppModel.self) private var model
    @Query private var conflicts: [SyncConflict]
    var body: some View {
        if let h = hOpt {
            let mine = conflicts.filter { $0.householdId == h.hid }
            Screen(title: "Sync conflicts") {
                if mine.isEmpty { EmptyStateView(systemImage: "checkmark.circle", title: "No conflicts", message: "When the same item changes on two devices, you'll choose which version to keep here.") }
                ForEach(mine) { c in
                    HHCard {
                        Text(c.collection).font(HHFont.label).foregroundStyle(HH.inkSecondary)
                        Text("Your change: \(c.localSummary)").font(HHFont.body)
                        Text("On the server: \(c.remoteSummary)").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
                        HStack {
                            HHButton(title: "Keep theirs", kind: .secondary) { resolve(c, keepMine: false) }
                            if c.remoteVersion >= 0 { HHButton(title: "Keep mine") { resolve(c, keepMine: true) } }
                        }
                    }.padding(.vertical, 6)
                }
            }
        }
    }
    private func resolve(_ c: SyncConflict, keepMine: Bool) {
        let ctx = model.offline.context
        let opId = c.opId
        if let op = try? ctx.fetch(FetchDescriptor<OutboxOp>(predicate: #Predicate { $0.opId == opId })).first {
            if keepMine { op.baseVersion = c.remoteVersion; op.state = "pending"; op.attempts = 0 } else { ctx.delete(op) }
        }
        ctx.delete(c)
        try? ctx.save()
        SyncScheduler.kick()
    }
}
