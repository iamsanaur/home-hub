import SwiftUI

/// Standard scrolling screen: solid canvas, readable max width.
struct Screen<Content: View>: View {
    let title: String
    var subtitle: String? = nil
    @ViewBuilder var content: Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let subtitle { Text(subtitle).font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary).padding(.bottom, Space.xs) }
                content
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(.horizontal, Space.md).padding(.bottom, Space.xxxl)
            .frame(maxWidth: .infinity)
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .background(HH.canvas)
        .navigationTitle(title)
    }
}

struct TaskRowView: View {
    let task: TaskItem
    let ctx: HouseholdContext
    let onToggle: (Bool) -> Void
    var overdue: Bool { !task.isDone && (task.dueAt.map { $0 < .now } ?? false) }
    var body: some View {
        HStack(spacing: Space.sm) {
            Button { onToggle(!task.isDone) } label: {
                Image(systemName: task.isDone ? "checkmark.square.fill" : "square").font(.title3).foregroundStyle(task.isDone ? HH.success : HH.inkSecondary).frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Complete \(task.title)").accessibilityValue(task.isDone ? "Done" : "Not done")
            VStack(alignment: .leading, spacing: 2) {
                Text(task.title).font(HHFont.cardTitle).foregroundStyle(task.isDone ? HH.inkTertiary : HH.ink).strikethrough(task.isDone)
                HStack(spacing: 6) {
                    if let due = task.dueAt {
                        Label(overdue ? "Overdue · \(Dates.relative(due, tz: ctx.tz))" : Dates.relative(due, tz: ctx.tz), systemImage: overdue ? "exclamationmark.triangle" : "clock")
                            .foregroundStyle(overdue ? HH.danger : HH.inkSecondary)
                    }
                    if task.recurring { Image(systemName: "repeat").foregroundStyle(HH.inkTertiary).accessibilityLabel("Repeats") }
                    if let n = ctx.name(task.assigneeUid) { Text("· \(n)").foregroundStyle(HH.inkSecondary) }
                }
                .font(HHFont.caption).lineLimit(2)
            }
            Spacer(minLength: 0)
            if task.pendingSync { Image(systemName: "arrow.triangle.2.circlepath").foregroundStyle(HH.inkTertiary).accessibilityLabel("Waiting to sync") }
            PriorityIndicator(priority: task.priority)
        }
        .padding(.trailing, Space.md).padding(.vertical, 6).frame(minHeight: 64)
    }
}

enum BillState: String, CaseIterable {
    case overdue = "Overdue", dueToday = "Due today", upcoming = "Upcoming", needsAttention = "Needs attention", paid = "Paid"
    var tone: Tone { switch self { case .overdue: .danger; case .dueToday, .needsAttention: .warning; case .paid: .success; case .upcoming: .neutral } }
    static func of(_ r: Record, tz: TimeZone) -> BillState {
        guard let due = r.t("nextDueAt"), (r.i("amountMinor") ?? 0) > 0 else { return .needsAttention }
        if (r.data["recurrence"] == nil || r.data["recurrence"] is NSNull) && r.t("lastPaidAt") != nil { return .paid }
        let cal = Dates.calendar(tz)
        if cal.isDate(due, inSameDayAs: .now) { return .dueToday }
        return due < cal.startOfDay(for: .now) ? .overdue : .upcoming
    }
}

struct BillRowView: View {
    let bill: Record
    let ctx: HouseholdContext
    var body: some View {
        let state = BillState.of(bill, tz: ctx.tz)
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(bill.s("name") ?? "Bill").font(HHFont.cardTitle).foregroundStyle(HH.ink)
                Text((bill.t("nextDueAt").map { "Due \(Dates.short($0, tz: ctx.tz))" } ?? "No due date") + ((bill.data.map("recurrence")?.str("freq")).map { " · \($0.capitalized)" } ?? ""))
                    .font(HHFont.caption).foregroundStyle(HH.inkSecondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Text(Money.format(bill.i("amountMinor") ?? 0, bill.s("currency") ?? ctx.currency)).font(HHFont.numeric).foregroundStyle(HH.ink)
                StatusBadge(label: state.rawValue, tone: state.tone, systemImage: state == .overdue ? "exclamationmark.triangle" : (state == .paid ? "checkmark.circle" : nil))
            }
        }
        .padding(.horizontal, Space.md).padding(.vertical, Space.sm).frame(minHeight: 64)
    }
}

struct BudgetSummaryView: View {
    let spent: Int64, limit: Int64?, income: Int64, currency: String
    var body: some View {
        let pct = limit.map { Money.percent(spent, of: $0) }
        VStack(alignment: .leading, spacing: Space.xs) {
            Text("Spent this month").font(HHFont.label).foregroundStyle(HH.inkSecondary)
            HStack(alignment: .firstTextBaseline) {
                Text(Money.format(spent, currency)).font(HHFont.kpi).foregroundStyle(HH.ink).minimumScaleFactor(0.6).lineLimit(1)
                if let limit { Text("of \(Money.format(limit, currency))").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary) }
            }
            if let pct {
                ProgressRow(label: pct > 100 ? "Over budget" : (pct >= 85 ? "Close to budget" : "Within budget"), fraction: Double(pct) / 100, value: "\(pct)%",
                            tone: pct > 100 ? .danger : (pct >= 85 ? .warning : .brand))
            }
            if income > 0 { Text("Income \(Money.format(income, currency))").font(HHFont.caption).foregroundStyle(HH.inkSecondary) }
        }
        .accessibilityElement(children: .combine)
    }
}

enum AgentState: String {
    case executing, awaitingApproval = "awaiting_approval", completed, partial = "partially_completed", failed, cancelled, local, suggested
    var label: String {
        switch self {
        case .executing: "Working…"; case .awaitingApproval: "Awaiting approval"; case .completed: "Completed · verified"; case .partial: "Partially completed"
        case .failed: "Failed"; case .cancelled: "Cancelled"; case .local: "Done on this phone"; case .suggested: "Suggestion"
        }
    }
    var tone: Tone { switch self { case .executing: .brand; case .awaitingApproval, .partial: .warning; case .completed, .local: .success; case .failed: .danger; case .cancelled: .neutral; case .suggested: .info } }
    var icon: String? { switch self { case .completed, .local: "checkmark.seal"; case .awaitingApproval: "hourglass"; case .failed: "exclamationmark.triangle"; case .suggested: "lightbulb"; default: nil } }
}

struct AgentStatusView: View {
    let state: AgentState
    var body: some View {
        HStack(spacing: 6) {
            if state == .executing { ProgressView().controlSize(.mini).tint(HH.brand) }
            StatusBadge(label: state.label, tone: state.tone, systemImage: state.icon)
        }
    }
}

struct ToolStep: Identifiable { let id = UUID(); let name: String; var done: Bool; var ok: Bool }

/// Tool calls, shortened: one summary line ("Used 6 tools", or the tool running right now) that expands to
/// each tool once with a count, instead of one row per call. Entries can be removed; that only tidies the
/// display and never undoes what the assistant did.
struct ActivityTimeline: View {
    let steps: [ToolStep]
    var onRemove: ((String) -> Void)? = nil
    var onClear: (() -> Void)? = nil
    @State private var expanded = false

    private func pretty(_ n: String) -> String {
        let t = n.replacingOccurrences(of: "mcp__homehub__", with: "").replacingOccurrences(of: "_", with: " ")
        return t.prefix(1).uppercased() + t.dropFirst()
    }

    var body: some View {
        let running = steps.last { !$0.done }
        let failed = steps.filter { $0.done && !$0.ok }.count
        let summary = running.map { "Working · \(pretty($0.name))…" }
            ?? "Used \(steps.count) tool\(steps.count == 1 ? "" : "s")" + (failed > 0 ? " · \(failed) failed" : "")
        let names = steps.reduce(into: [String]()) { if !$0.contains($1.name) { $0.append($1.name) } }
        VStack(alignment: .leading, spacing: 4) {
            Button { withAnimation(.snappy) { expanded.toggle() } } label: {
                HStack(spacing: Space.xs) {
                    Circle().fill(running != nil ? HH.brand : (failed > 0 ? HH.danger : HH.success)).frame(width: 8, height: 8)
                    Text(summary).font(HHFont.caption).foregroundStyle(HH.inkSecondary).lineLimit(1)
                    Spacer()
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption).foregroundStyle(HH.inkTertiary)
                }
                .frame(minHeight: 36).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(summary).accessibilityHint(expanded ? "Hide tool details" : "Show tool details")
            if expanded {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(names, id: \.self) { name in
                        let calls = steps.filter { $0.name == name }
                        let anyRunning = calls.contains { !$0.done }
                        let bad = calls.filter { $0.done && !$0.ok }.count
                        HStack(spacing: Space.xs) {
                            Text(pretty(name) + (calls.count > 1 ? " ×\(calls.count)" : "")).font(HHFont.caption).foregroundStyle(HH.inkSecondary)
                            Spacer()
                            Text(anyRunning ? "running" : (bad > 0 ? (calls.count > 1 ? "\(bad) failed" : "failed") : "done")).font(HHFont.caption)
                                .foregroundStyle(anyRunning ? HH.brand : (bad > 0 ? HH.danger : HH.success))
                            if let onRemove, !anyRunning {
                                Button { onRemove(name) } label: { Image(systemName: "xmark").font(.caption.weight(.semibold)).foregroundStyle(HH.inkTertiary).frame(width: 36, height: 36) }
                                    .accessibilityLabel("Remove \(pretty(name))")
                            }
                        }
                    }
                    if let onClear, running == nil {
                        Button("Clear all", action: onClear).font(HHFont.label).foregroundStyle(HH.brand).frame(minHeight: 40)
                    }
                }.padding(.leading, Space.sm)
            }
        }
    }
}

/// Approval card (design.md §11): exact action, parameters, cost, recipient, date, data shared, consequences.
struct ApprovalCardView: View {
    let approval: Approval
    let ctx: HouseholdContext
    var busy = false
    let decide: (Bool) -> Void
    var body: some View {
        HHCard {
            HStack {
                Label(approval.agentId != nil ? "Requested by HomeHub assistant" : "Requested by a household member", systemImage: "sparkles").font(HHFont.caption).foregroundStyle(HH.inkSecondary)
                Spacer()
                AgentStatusView(state: .awaitingApproval)
            }
            Text(approval.title.prefix(1).uppercased() + approval.title.dropFirst()).font(HHFont.cardTitle).foregroundStyle(HH.ink)
            Text(approval.rationale).font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
            VStack(alignment: .leading, spacing: 4) {
                detail("Action", approval.actionLabel)
                if let c = approval.estimatedCostMinor { detail("Estimated cost", Money.format(c, approval.currency ?? ctx.currency)) }
                if let r = approval.recipient { detail("Recipient", r) }
                if let d = approval.relevantDate { detail("Date", d) }
                if let s = approval.dataShared { detail("Data shared", s) }
                if let c = approval.consequences { detail("Consequences", c) }
                if let p = paramSummary { detail("Details", p) }
                if let e = approval.expiresAt { detail("Expires", Dates.relative(e, tz: ctx.tz)) }
            }
            .padding(Space.sm).frame(maxWidth: .infinity, alignment: .leading).background(HH.surfaceSubtle, in: RoundedRectangle(cornerRadius: Radius.input))
            if approval.manualCompletion { Text("HomeHub can't do this externally. Approving records your decision; a person completes it.").font(HHFont.caption).foregroundStyle(HH.inkSecondary) }
            if ctx.role.isAdultPlus {
                HStack(spacing: Space.sm) {
                    HHButton(title: "Reject", kind: .secondary) { decide(false) }.disabled(busy)
                    HHButton(title: "Approve", loading: busy) { decide(true) }
                }
                .padding(.top, Space.xs)
            }
        }
    }
    private func detail(_ k: String, _ v: String) -> some View {
        HStack(alignment: .top) { Text(k).font(HHFont.caption).foregroundStyle(HH.inkSecondary).frame(width: 110, alignment: .leading); Text(v).font(HHFont.bodyCompact).foregroundStyle(HH.ink) }
    }
    private var paramSummary: String? {
        let p = approval.action == "agent_tool_call" ? (approval.params["args"] as? [String: Any] ?? [:]) : approval.params
        let s = p.filter { $0.key != "idempotency_key" && !($0.value is NSNull) }.sorted { $0.key < $1.key }.prefix(6).map { k, v -> String in
            if k.hasSuffix("Minor"), let n = (v as? NSNumber)?.int64Value { return "\(k): \(Money.format(n, approval.currency ?? ctx.currency))" }
            if let a = v as? [Any] { return "\(k): \(a.count) item\(a.count == 1 ? "" : "s")" }
            return "\(k): \(String(describing: v).prefix(60))"
        }.joined(separator: " · ")
        return s.isEmpty ? nil : s
    }
}
