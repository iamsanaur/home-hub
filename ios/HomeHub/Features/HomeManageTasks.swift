import SwiftUI
import SwiftData
import FirebaseFirestore

extension View {
    /// Pulls the household context for feature screens (always present inside MainTabs).
    func withHousehold<V: View>(@ViewBuilder _ content: @escaping (HouseholdContext) -> V) -> some View { HouseholdReader(content: content) }
}

struct HouseholdReader<V: View>: View {
    @Environment(\.household) private var h
    let content: (HouseholdContext) -> V
    var body: some View { if let h { content(h) } }
}

private func db() -> Firestore { Firestore.firestore() }

// MARK: Home

struct HomeView: View {
    @Environment(\.household) private var hOpt
    var body: some View { if let h = hOpt { HomeContent(h: h) } }
}

private struct HomeContent: View {
    let h: HouseholdContext
    @Environment(AppModel.self) private var model
    @Query(sort: \LocalTask.dueAt) private var allTasks: [LocalTask]
    @Query private var outbox: [OutboxOp]
    @State private var bills: LiveQuery<Record>?
    @State private var events: LiveQuery<Record>?
    @State private var low: LiveQuery<Record>?
    @State private var txns: LiveQuery<Record>?
    @State private var budgets: LiveQuery<Record>?

    var tasks: [TaskItem] { allTasks.filter { $0.householdId == h.hid }.map(\.model) }

    var body: some View {
        let now = Date.now
        let endToday = Dates.calendar(h.tz).date(byAdding: .day, value: 1, to: Dates.calendar(h.tz).startOfDay(for: now))!
        let open = tasks.filter { !$0.isDone }
        let overdue = open.filter { ($0.dueAt ?? .distantFuture) < now }
        let dueToday = open.filter { guard let d = $0.dueAt else { return false }; return d >= now && d < endToday }
        let billList = bills?.items ?? []
        let lowItems = low?.items ?? []
        let eventList = events?.items ?? []
        let spent = (txns?.items ?? []).filter { $0.s("type") == "expense" && $0.s("currency") == h.currency }.reduce(Int64(0)) { $0 + ($1.i("amountMinor") ?? 0) }
        let income = (txns?.items ?? []).filter { $0.s("type") == "income" && $0.s("currency") == h.currency }.reduce(Int64(0)) { $0 + ($1.i("amountMinor") ?? 0) }
        let limit = budgets?.items.first { $0.s("category") == "*" }?.i("limitMinor")
        let pending = outbox.filter { $0.householdId == h.hid && $0.state == "pending" }.count
        let summary = [overdue.isEmpty ? nil : "\(overdue.count) overdue", dueToday.isEmpty ? nil : "\(dueToday.count) due today",
                       billList.isEmpty ? nil : "\(billList.count) bill\(billList.count == 1 ? "" : "s") soon", eventList.isEmpty ? nil : "\(eventList.count) event\(eventList.count == 1 ? "" : "s")",
                       lowItems.isEmpty ? nil : "\(lowItems.count) running low"].compactMap { $0 }.joined(separator: " · ")

        Screen(title: "\(Dates.greeting(now, tz: h.tz)), \(h.me?.displayName.components(separatedBy: " ").first ?? "")",
               subtitle: Dates.long(now, tz: h.tz)) {
            Menu {
                ForEach(model.memberships.sorted { $0.value < $1.value }, id: \.key) { id, name in
                    Button { model.switchHousehold(id) } label: { if id == h.hid { Label(name, systemImage: "checkmark") } else { Text(name) } }
                }
            } label: { Label(h.household.name, systemImage: "chevron.up.chevron.down").font(HHFont.label).foregroundStyle(HH.brand) }
            .accessibilityLabel("Switch household, current \(h.household.name)")
            if pending > 0 { Label("\(pending) change\(pending == 1 ? "" : "s") waiting to sync", systemImage: "arrow.triangle.2.circlepath").font(HHFont.caption).foregroundStyle(HH.inkSecondary).padding(.top, 4) }

            HHCard {
                Text("Today").font(HHFont.label).foregroundStyle(HH.inkSecondary)
                Text(summary.isEmpty ? "Nothing urgent today." : summary).font(HHFont.sectionTitle).foregroundStyle(HH.ink)
                if let next = overdue.first ?? dueToday.first {
                    Text("Next up").font(HHFont.caption).foregroundStyle(HH.inkSecondary).padding(.top, Space.sm)
                    Text(next.title).font(HHFont.cardTitle).foregroundStyle(HH.ink)
                    HHButton(title: "Mark done") { model.offline.setTaskDone(hid: h.hid, uid: h.uid, id: next.id, done: true) }.padding(.top, Space.xs)
                } else {
                    NavigationLink { AIView(initialPrompt: "Prepare everything for next week.") } label: { Label("Ask HomeHub to plan the week", systemImage: "sparkles").frame(maxWidth: .infinity, minHeight: 48) }
                        .buttonStyle(HHButtonStyle(kind: .secondary)).padding(.top, Space.xs)
                }
            }
            .padding(.top, Space.md)

            NotificationPrompt()

            SectionHeaderLink(title: "Tasks due", action: "All tasks") { TasksView() }
            let shown = Array((overdue + dueToday).prefix(5))
            if shown.isEmpty { Text("No tasks due today.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary) }
            else { GroupedList { ForEach(Array(shown.enumerated()), id: \.element.id) { i, t in if i > 0 { RowDivider() }; TaskRowView(task: t, ctx: h) { model.offline.setTaskDone(hid: h.hid, uid: h.uid, id: t.id, done: $0) } } } }

            if h.canFinance {
                SectionHeaderLink(title: "Bills this week", action: "Bills") { BillsView() }
                if billList.isEmpty { Text("No bills due in the next 7 days.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary) }
                else { GroupedList { ForEach(Array(billList.prefix(4).enumerated()), id: \.element.id) { i, b in if i > 0 { RowDivider() }; NavigationLink { BillsView() } label: { BillRowView(bill: b, ctx: h) }.buttonStyle(.plain) } } }
            }
            SectionHeaderLink(title: "Coming up", action: "Calendar") { RecordListView(spec: .calendar(h)) }
            if eventList.isEmpty { Text("Nothing on the calendar for the next 3 days.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary) }
            else { GroupedList { ForEach(Array(eventList.prefix(4).enumerated()), id: \.element.id) { i, e in if i > 0 { RowDivider() }; HHListRow(title: e.s("title") ?? "Event", subtitle: e.t("startAt").map { Dates.relative($0, tz: h.tz) }, systemImage: "calendar") } } }

            SectionHeaderLink(title: "Shopping & pantry", action: "Shopping") { ShoppingView() }
            NavigationLink { PantryView() } label: {
                HHCard { HHListRow(title: lowItems.isEmpty ? "Pantry is stocked" : "\(lowItems.count) item\(lowItems.count == 1 ? "" : "s") running low", subtitle: lowItems.isEmpty ? nil : lowItems.prefix(4).compactMap { $0.s("name") }.joined(separator: ", "), systemImage: "refrigerator") }
            }.buttonStyle(.plain)

            if h.canFinance {
                SectionHeaderLink(title: "Budget", action: "Finance") { FinanceView() }
                NavigationLink { FinanceView() } label: { HHCard { BudgetSummaryView(spent: spent, limit: limit, income: income, currency: h.currency) } }.buttonStyle(.plain)
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { NavigationLink { NotificationsView() } label: { Image(systemName: "bell") }.accessibilityLabel("Notifications") }
            ToolbarItem(placement: .topBarTrailing) { NavigationLink { SettingsView() } label: { Image(systemName: "gearshape") }.accessibilityLabel("Settings") }
        }
        .task(id: h.hid) {
            let week = Timestamp(date: Date.now.addingTimeInterval(7 * 86400))
            let startDay = Dates.calendar(h.tz).startOfDay(for: .now)
            if h.canFinance {
                bills = LiveQuery(db().collection("households/\(h.hid)/bills").whereField("nextDueAt", isLessThanOrEqualTo: week).order(by: "nextDueAt")) { Record(id: $0, data: $1) }
                let monthStart = Dates.calendar(h.tz).date(from: Dates.calendar(h.tz).dateComponents([.year, .month], from: .now))!
                txns = LiveQuery(db().collection("households/\(h.hid)/transactions").whereField("occurredAt", isGreaterThanOrEqualTo: Timestamp(date: monthStart))) { Record(id: $0, data: $1) }
                budgets = LiveQuery(db().collection("households/\(h.hid)/budgets").whereField("period", isEqualTo: String(ISO8601DateFormatter().string(from: .now).prefix(7)))) { Record(id: $0, data: $1) }
            }
            var eq: FirebaseFirestore.Query = db().collection("households/\(h.hid)/events")
            if h.role == .child { eq = eq.whereField("visibility", isEqualTo: "household") }
            if h.role == .staff { eq = eq.whereField("staffVisible", isEqualTo: true) }
            events = LiveQuery(eq.whereField("startAt", isGreaterThanOrEqualTo: Timestamp(date: startDay)).whereField("startAt", isLessThan: Timestamp(date: startDay.addingTimeInterval(3 * 86400))).order(by: "startAt")) { Record(id: $0, data: $1) }
            low = LiveQuery(db().collection("households/\(h.hid)/pantryItems").whereField("lowStock", isEqualTo: true)) { Record(id: $0, data: $1) }
        }
    }
}

// MARK: Manage

struct ManageView: View {
    @Environment(\.household) private var hOpt
    var body: some View {
        if let h = hOpt {
            Screen(title: "Manage", subtitle: h.household.name) {
                group("Daily routines", [("Tasks", "Chores, errands and reminders", "checklist", AnyView(TasksView()), true),
                                         ("Cleaning", "Room-wise routines and deep cleans", "bubbles.and.sparkles", AnyView(RecordListView(spec: .cleaning(h))), true)])
                group("Shopping and pantry", [("Shopping lists", "What to buy, by category", "cart", AnyView(ShoppingView()), true),
                                              ("Pantry", "Stock, expiry and low items", "refrigerator", AnyView(PantryView()), true)])
                group("Food and meals", [("Meal planner", "Weekly menu and recipes", "fork.knife", AnyView(MealsView()), true)])
                group("Money and bills", [("Finance", "Spending, income and budgets", "wallet.bifold", AnyView(FinanceView()), h.canFinance),
                                          ("Bills", "Due dates and payment history", "doc.text", AnyView(BillsView()), h.canFinance)])
                group("Home care", [("Maintenance", "Repairs, servicing and warranties", "wrench.and.screwdriver", AnyView(RecordListView(spec: .maintenance(h))), h.role.isAdultPlus || h.role == .staff),
                                    ("Inventory", "Furniture, appliances and valuables", "sofa", AnyView(RecordListView(spec: .inventory(h))), h.role.isAdultPlus)])
                group("Household records", [("Calendar", "Events, birthdays and appointments", "calendar", AnyView(RecordListView(spec: .calendar(h))), true),
                                            ("Documents", "Agreements, insurance and warranties", "doc.on.doc", AnyView(RecordListView(spec: .documents(h))), h.role.isAdultPlus),
                                            ("Notes", "Shared and private notes", "note.text", AnyView(NotesView()), h.role != .staff)])
                group("Smart home and connections", [("Devices", "Lights, plugs, AC, locks and sensors", "lightbulb", AnyView(DevicesView()), h.role != .staff),
                                                     ("Automations", "When this happens, do that", "bolt", AnyView(AutomationsView()), h.role.isAdultPlus),
                                                     ("Connections", "Integrations, AI model, Alexa, activity and privacy", "point.3.connected.trianglepath.dotted", AnyView(ConnectionsView()), h.role.isAdultPlus)])
            }
        }
    }
    @ViewBuilder private func group(_ title: String, _ rows: [(String, String, String, AnyView, Bool)]) -> some View {
        let visible = rows.filter(\.4)
        if !visible.isEmpty {
            SectionHeader(title: title)
            GroupedList {
                ForEach(Array(visible.enumerated()), id: \.offset) { i, r in
                    if i > 0 { RowDivider() }
                    NavigationLink { r.3 } label: { HHListRow(title: r.0, subtitle: r.1, systemImage: r.2, trailing: AnyView(Image(systemName: "chevron.right").foregroundStyle(HH.inkTertiary))) }.buttonStyle(.plain)
                }
            }
        }
    }
}

// MARK: Tasks

struct TasksView: View {
    @Environment(\.household) private var hOpt
    var body: some View { if let h = hOpt { TasksContent(h: h) } }
}

private struct TasksContent: View {
    let h: HouseholdContext
    @Environment(AppModel.self) private var model
    @Query(sort: \LocalTask.dueAt) private var all: [LocalTask]
    @State private var filter = 0
    @State private var editing = false
    @State private var undo: TaskItem?

    var body: some View {
        let tasks = all.filter { $0.householdId == h.hid }.map(\.model)
        let endToday = Dates.calendar(h.tz).date(byAdding: .day, value: 1, to: Dates.calendar(h.tz).startOfDay(for: .now))!
        let shown: [TaskItem] = switch filter {
            case 0: tasks.filter { !$0.isDone && ($0.dueAt ?? .distantFuture) < endToday }
            case 1: tasks.filter { !$0.isDone && ($0.dueAt ?? .distantFuture) >= endToday }
            case 2: tasks.filter { $0.assigneeUid == h.uid && !$0.isDone }
            default: tasks
        }
        Screen(title: "Tasks", subtitle: "\(tasks.filter { !$0.isDone }.count) open") {
            Picker("Filter", selection: $filter) { Text("Today").tag(0); Text("Upcoming").tag(1); Text("Mine").tag(2); Text("All").tag(3) }
                .pickerStyle(.segmented).padding(.vertical, Space.xs)
            if shown.isEmpty {
                EmptyStateView(systemImage: "checklist", title: filter == 0 ? "Nothing due today" : "No tasks here", message: "Tasks you add — or the assistant creates — appear here.", actionTitle: "Add a task") { editing = true }
            } else {
                GroupedList {
                    ForEach(Array(shown.enumerated()), id: \.element.id) { i, t in
                        if i > 0 { RowDivider() }
                        TaskRowView(task: t, ctx: h) { done in
                            model.offline.setTaskDone(hid: h.hid, uid: h.uid, id: t.id, done: done)
                            if done { undo = t }
                        }
                    }
                }
            }
        }
        .overlay(alignment: .bottom) {
            if let u = undo {
                HStack { Text("Completed “\(u.title)”").font(HHFont.bodyCompact).lineLimit(1); Spacer(); Button("Undo") { model.offline.setTaskDone(hid: h.hid, uid: h.uid, id: u.id, done: false); undo = nil }.bold() }
                    .padding(Space.md).glassSurface(Capsule()).padding(Space.md)
                    .task(id: u.id) { try? await Task.sleep(for: .seconds(4)); if undo?.id == u.id { undo = nil } }
            }
        }
        .toolbar { if h.role.isAdultPlus || h.role == .child { ToolbarItem(placement: .primaryAction) { Button { editing = true } label: { Image(systemName: "plus") }.accessibilityLabel("New task") } } }
        .sheet(isPresented: $editing) { TaskEditor(h: h).presentationDetents([.large]) }
    }
}

private struct TaskEditor: View {
    let h: HouseholdContext
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var notes = ""
    @State private var category = ""
    @State private var priority: Priority = .normal
    @State private var assignee: String = ""
    @State private var hasDue = false
    @State private var due = Date.now.addingTimeInterval(3600)
    @State private var repeatFreq = "none"
    @State private var tried = false
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.md) {
                    HHTextField(label: "Title", text: $title, error: tried && title.isEmpty ? "Give the task a title." : nil)
                    HHTextField(label: "Notes", text: $notes, optional: true, multiline: true)
                    Text("Priority").font(HHFont.label)
                    ChoiceChips(options: Priority.allCases.map { ($0, $0.label) }, selection: $priority)
                    if h.role.isAdultPlus {
                        Text("Assign to").font(HHFont.label)
                        ChoiceChips(options: [("", "Anyone")] + h.members.map { ($0.id, $0.displayName.components(separatedBy: " ").first ?? $0.displayName) }, selection: $assignee)
                    }
                    Toggle("Due date", isOn: $hasDue).tint(HH.brand)
                    if hasDue {
                        DatePicker("Due", selection: $due).environment(\.timeZone, h.tz)
                        Text("Repeat").font(HHFont.label)
                        ChoiceChips(options: [("none", "Never"), ("daily", "Daily"), ("weekly", "Weekly"), ("monthly", "Monthly")], selection: $repeatFreq)
                    }
                    HHTextField(label: "Category", text: $category, optional: true, placeholder: "e.g. Kitchen, School")
                    HHButton(title: "Add task") {
                        tried = true
                        guard !title.trimmingCharacters(in: .whitespaces).isEmpty else { return }
                        model.offline.createTask(hid: h.hid, title: title, notes: notes.isEmpty ? nil : notes, priority: priority, dueAt: hasDue ? due : nil,
                                                 assigneeUid: h.role == .child ? h.uid : (assignee.isEmpty ? nil : assignee), category: category.isEmpty ? nil : category,
                                                 repeatFreq: hasDue && repeatFreq != "none" ? repeatFreq : nil)
                        dismiss()
                    }
                }
                .padding(Space.lg)
            }
            .navigationTitle("New task").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}
