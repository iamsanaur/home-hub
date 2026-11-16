import SwiftUI
import FirebaseFirestore

struct LiveRun {
    let prompt: String
    var state: AgentState = .executing
    var text = ""
    var steps: [ToolStep] = []
    var notes: [String] = []
    var verified: [String] = []
    var approvalIds: [String] = []
    var error: String?
    var onDevice = false
}

/// Drives Hermes Mobile for the AI screen.
@MainActor @Observable
final class AgentSession {
    var sessionId: String?
    var live: LiveRun?
    private var task: Task<Void, Never>?

    func newConversation() { task?.cancel(); sessionId = nil; live = nil }
    func stop() { task?.cancel() }

    func send(_ h: HouseholdContext, offline: OfflineStore, prompt: String) {
        guard task == nil || task!.isCancelled || live?.state != .executing, !prompt.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        live = LiveRun(prompt: prompt)
        task = Task {
            // 1) Zero-model path: handled on the phone, works offline, costs no tokens.
            if let intent = OfflineIntents.parse(prompt) {
                live?.text = await handleLocally(h, offline, intent); live?.state = .local; live?.onDevice = true; return
            }
            // 2) Hermes Mobile: loop on this phone; model via HomeHub proxy; tools via HomeHub MCP.
            do {
                let outcome = try await HermesMobile.shared.run(hid: h.hid, message: prompt, sessionId: sessionId, history: []) { [weak self] e in
                    Task { @MainActor in self?.apply(e) }
                }
                sessionId = outcome.sessionId ?? sessionId
                if Task.isCancelled { live?.state = .cancelled; return }
                live?.state = outcome.state == "deterministic" ? .completed : (AgentState(rawValue: outcome.state) ?? .failed)
                if !outcome.text.isEmpty { live?.text = outcome.text }
                live?.verified = outcome.verifiedActions; live?.approvalIds = outcome.approvalIds; live?.error = outcome.error
            } catch let e as GatewayError {
                live?.state = .failed
                live?.error = e.code == "network" ? "You're offline. I can still add items to your list, add tasks, mark tasks done and show today's tasks." : e.message
            } catch {
                live?.state = Task.isCancelled ? .cancelled : .failed
                live?.error = error.localizedDescription
            }
        }
    }

    private func apply(_ e: AgentEvent) {
        switch e {
        case .delta(let d): live?.text += d
        case .toolStarted(let n): live?.steps.append(ToolStep(name: n, done: false, ok: true))
        case .toolFinished(let n, let ok): if let i = live?.steps.lastIndex(where: { $0.name == n && !$0.done }) { live?.steps[i].done = true; live?.steps[i].ok = ok }
        case .note(let n): live?.notes.append(n)
        }
    }

    private func handleLocally(_ h: HouseholdContext, _ offline: OfflineStore, _ intent: OfflineIntent) async -> String {
        switch intent {
        case .addToList(let item, let q, let unit):
            guard let list = try? await Firestore.firestore().collection("households/\(h.hid)/shoppingLists").whereField("archived", isEqualTo: false).limit(to: 1).getDocuments().documents.first else {
                return "There's no shopping list yet. Create one in Shopping first."
            }
            offline.addGrocery(hid: h.hid, listId: list.documentID, name: item, quantity: q, unit: unit, category: "Other", estimatedPriceMinor: nil)
            return "Added \(Dates.qty(q)) \(unit) \(item) to “\(list.data()["name"] as? String ?? "your list")”."
        case .addTask(let title):
            offline.createTask(hid: h.hid, title: title, notes: nil, priority: .normal, dueAt: nil, assigneeUid: h.uid, category: nil, repeatFreq: nil)
            return "Added task “\(title)” for you."
        case .completeTask(let query):
            let open = ((try? offline.context.fetch(.init(predicate: #Predicate<LocalTask> { $0.status != "done" }))) ?? []).filter { $0.householdId == h.hid }
            guard let m = open.first(where: { $0.title.caseInsensitiveCompare(query) == .orderedSame }) ?? open.first(where: { $0.title.localizedCaseInsensitiveContains(query) }) else { return "I couldn't find an open task called “\(query)”." }
            offline.setTaskDone(hid: h.hid, uid: h.uid, id: m.id, done: true)
            return "Marked “\(m.title)” done."
        case .dueToday:
            let end = Dates.calendar(h.tz).date(byAdding: .day, value: 1, to: Dates.calendar(h.tz).startOfDay(for: .now))!
            let due = ((try? offline.context.fetch(.init(predicate: #Predicate<LocalTask> { $0.status != "done" }))) ?? []).filter { $0.householdId == h.hid && ($0.dueAt ?? .distantFuture) < end }
            return due.isEmpty ? "Nothing due today." : "Due today:\n" + due.map { "• \($0.title)" }.joined(separator: "\n")
        }
    }
}

private let suggestions = ["Prepare everything for next week.", "Prepare the house for guests on Saturday.", "Are we over budget this month?",
                           "What's running low in the pantry?", "The bedroom AC isn't cooling — sort it out.", "Plan dinners for this week."]

struct AIView: View {
    var initialPrompt: String? = nil
    @Environment(\.household) private var hOpt
    @Environment(AppModel.self) private var model
    @State private var session = AgentSession()
    @State private var input = ""
    @FocusState private var focused: Bool

    var body: some View {
        if let h = hOpt {
            let power = HermesMobile.shared.power.snapshot()
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: Space.sm) {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: Space.xs) {
                                if h.household.paused { StatusBadge(label: "Agent paused", tone: .warning, systemImage: "pause.circle") }
                                else { StatusBadge(label: "\(autonomyModes.first { $0.0 == h.household.autonomyMode }?.1.components(separatedBy: " (").first ?? "Routine") mode", tone: .brand) }
                                StatusBadge(label: "Runs on this phone", tone: .neutral, systemImage: "iphone")
                                if power.mode == .saver { StatusBadge(label: "Battery saver: lighter plans", tone: .warning) }
                            }
                        }
                        if h.role == .staff {
                            HHCard { Text("The assistant isn't available for staff accounts. Your assigned work is in Manage.").font(HHFont.body).foregroundStyle(HH.inkSecondary) }
                        } else if session.live == nil {
                            Image(systemName: "sparkles").font(.title).foregroundStyle(HH.brand).padding(.top, Space.lg)
                            Text("What can I take off your plate?").font(HHFont.sectionTitle).foregroundStyle(HH.ink)
                            Text("I plan and organise household work. Purchases, payments and bookings always wait for your approval.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
                            ForEach(suggestions, id: \.self) { s in
                                Button { input = s; focused = true } label: {
                                    Text(s).font(HHFont.bodyCompact).foregroundStyle(HH.ink).padding(.horizontal, 14).frame(minHeight: 44)
                                        .background(HH.surface, in: Capsule()).overlay(Capsule().stroke(HH.border))
                                }.buttonStyle(.plain)
                            }
                        }
                        if let live = session.live { LiveRunView(live: live, h: h) { session.send(h, offline: model.offline, prompt: live.prompt) }.id("live") }
                    }
                    .frame(maxWidth: 720, alignment: .leading).padding(.horizontal, Space.md).padding(.bottom, 120).frame(maxWidth: .infinity)
                }
                .scrollEdgeEffectStyle(.soft, for: .bottom)
                .background(HH.canvas)
                .onChange(of: session.live?.text) { _, _ in withAnimation { proxy.scrollTo("live", anchor: .bottom) } }
            }
            .navigationTitle("Assistant")
            .toolbar { ToolbarItem(placement: .primaryAction) { Button("New") { session.newConversation(); input = "" } } }
            .safeAreaInset(edge: .bottom) {
                if h.role != .staff {
                    // Functional layer: the composer is a Liquid Glass control; text sits on an opaque inner field.
                    HStack(alignment: .bottom, spacing: Space.xs) {
                        TextField("Ask HomeHub…", text: $input, axis: .vertical)
                            .lineLimit(1...5).focused($focused).font(HHFont.body)
                            .padding(Space.sm).background(HH.surface, in: RoundedRectangle(cornerRadius: Radius.input))
                            .accessibilityLabel("Message the assistant")
                            .disabled(session.live?.state == .executing)
                        if session.live?.state == .executing {
                            Button { session.stop() } label: { Image(systemName: "stop.circle.fill").font(.title2).foregroundStyle(HH.danger) }.frame(width: 44, height: 44).accessibilityLabel("Stop")
                        } else {
                            Button { session.send(h, offline: model.offline, prompt: input); input = ""; focused = false } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                                .frame(width: 44, height: 44).disabled(input.trimmingCharacters(in: .whitespaces).isEmpty).accessibilityLabel("Send")
                        }
                    }
                    .padding(Space.xs)
                    .glassSurface(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
                    .padding(.horizontal, Space.sm).padding(.bottom, Space.xs)
                }
            }
            .onAppear { if let p = initialPrompt, session.live == nil, input.isEmpty { input = p } }
        }
    }
}

private struct LiveRunView: View {
    let live: LiveRun, h: HouseholdContext, retry: () -> Void
    @State private var approvals: [String: LiveDoc] = [:]
    @State private var busy: String?
    var body: some View {
        VStack(alignment: .trailing, spacing: Space.sm) {
            Text(live.prompt).font(HHFont.body).foregroundStyle(HH.ink).padding(Space.sm).background(HH.brandTint, in: RoundedRectangle(cornerRadius: Radius.card))
            HHCard {
                HStack { Text("HomeHub").font(HHFont.label).foregroundStyle(HH.inkSecondary); Spacer(); AgentStatusView(state: live.state) }
                if live.onDevice { Text("Handled on your phone · no AI used").font(HHFont.caption).foregroundStyle(HH.inkTertiary) }
                ForEach(live.notes, id: \.self) { Text($0).font(HHFont.caption).foregroundStyle(HH.inkSecondary) }
                if !live.steps.isEmpty { Text("Tool activity").font(HHFont.caption).foregroundStyle(HH.inkSecondary); ActivityTimeline(steps: live.steps) }
                if !live.text.isEmpty { Text(live.text.trimmingCharacters(in: .whitespacesAndNewlines)).font(HHFont.body).foregroundStyle(HH.ink).accessibilityAddTraits(.updatesFrequently) }
                if !live.verified.isEmpty {
                    Text("Verified in HomeHub").font(HHFont.label).foregroundStyle(HH.success).padding(.top, Space.xs)
                    ForEach(Array(Set(live.verified)).sorted(), id: \.self) { a in
                        Label("\(a.replacingOccurrences(of: ".", with: " ").replacingOccurrences(of: "_", with: " ")) (\(live.verified.filter { $0 == a }.count))", systemImage: "checkmark.seal").font(HHFont.caption).foregroundStyle(HH.inkSecondary)
                    }
                }
                if let e = live.error {
                    Text(e).font(HHFont.bodyCompact).foregroundStyle(live.state == .failed ? HH.danger : HH.inkSecondary)
                    if live.state == .failed { HHButton(title: "Try again", kind: .secondary, systemImage: "arrow.clockwise", fullWidth: false, action: retry) }
                }
            }
            ForEach(live.approvalIds, id: \.self) { id in
                if let data = approvals[id]?.data {
                    let a = Approval(id: id, data)
                    if a.status == "pending" {
                        ApprovalCardView(approval: a, ctx: h, busy: busy == id) { approve in
                            busy = id
                            Task { _ = try? await Gateway.shared.call("POST", "/v1/households/\(h.hid)/approvals/\(id)/decision", body: ["decision": approve ? "approve" : "reject"]); busy = nil }
                        }
                    } else {
                        HHCard { HStack { Text(a.title.capitalized).font(HHFont.cardTitle); Spacer()
                            StatusBadge(label: ["executed": "Done · verified", "approved": "Approved · needs a person", "rejected": "Rejected", "expired": "Expired"][a.status] ?? a.status,
                                        tone: a.status == "executed" ? .success : .neutral) } }
                    }
                }
            }
        }
        .onChange(of: live.approvalIds) { _, ids in for id in ids where approvals[id] == nil { approvals[id] = LiveDoc(Firestore.firestore().document("households/\(h.hid)/approvals/\(id)")) } }
    }
}
