import SwiftUI
import FirebaseFirestore

extension RecordSpec {
    static func assets(_ h: HouseholdContext) -> RecordSpec {
        RecordSpec(title: "Assets", collection: "assets", icon: "wrench.and.screwdriver", emptyTitle: "No assets yet", emptyMessage: "Add appliances, vehicles and big items so servicing and warranties can be tracked.",
                   fields: [.init(key: "name", label: "Asset", kind: .text),
                            .init(key: "category", label: "Category", kind: .choice(["Appliance", "Vehicle", "Electronics", "Furniture", "Other"].map { ($0, $0) })),
                            .init(key: "brand", label: "Brand", kind: .text, optional: true), .init(key: "model", label: "Model", kind: .text, optional: true), .init(key: "location", label: "Location", kind: .text, optional: true),
                            .init(key: "purchaseDate", label: "Purchased", kind: .date, optional: true), .init(key: "warrantyExpiresAt", label: "Warranty until", kind: .date, optional: true),
                            .init(key: "nextServiceAt", label: "Next service", kind: .date, optional: true)],
                   group: { $0.s("category") ?? "Other" },
                   subtitle: { r in [[r.s("brand"), r.s("model")].compactMap { $0 }.joined(separator: " ").nilIfEmpty, r.s("location"), r.t("warrantyExpiresAt").map { "warranty to \(Dates.short($0, tz: h.tz))" }, r.t("nextServiceAt").map { "service \(Dates.short($0, tz: h.tz))" }].compactMap { $0 }.joined(separator: " · ") },
                   badge: { r in (r.t("warrantyExpiresAt").map { $0 < .now } ?? false) ? ("Out of warranty", .neutral) : nil },
                   defaults: ["nextServiceAt": NSNull(), "serviceIntervalDays": NSNull()],
                   canRead: h.role.isAdultPlus || h.role == .child, canWrite: h.role.isAdultPlus, canDelete: h.role.isManager)
    }

    static func savings(_ h: HouseholdContext) -> RecordSpec {
        RecordSpec(title: "Savings goals", collection: "savingsGoals", icon: "banknote", emptyTitle: "No savings goals", emptyMessage: "Set a target and track what you have put aside. HomeHub only records it, it never moves money.",
                   fields: [.init(key: "name", label: "Goal", kind: .text), .init(key: "targetMinor", label: "Target", kind: .amount), .init(key: "savedMinor", label: "Saved so far", kind: .amount, optional: true),
                            .init(key: "targetDate", label: "Target date", kind: .date, optional: true)],
                   subtitle: { r in
                       let t = r.i("targetMinor") ?? 0, v = r.i("savedMinor") ?? 0
                       return ["\(Money.format(v, h.currency)) of \(Money.format(t, h.currency))" + (t > 0 ? " · \(min(100, v * 100 / t))%" : ""), r.t("targetDate").map { "by \(Dates.short($0, tz: h.tz))" }].compactMap { $0 }.joined(separator: " · ")
                   },
                   badge: { r in ((r.i("targetMinor") ?? 0) > 0 && (r.i("savedMinor") ?? 0) >= (r.i("targetMinor") ?? 0)) ? ("Reached", .success) : nil },
                   defaults: ["currency": h.currency, "savedMinor": 0, "targetDate": NSNull()],
                   canRead: h.canFinance, canWrite: h.canFinance, canDelete: h.role.isManager)
    }
}

private extension String { var nilIfEmpty: String? { isEmpty ? nil : self } }

/// Comments on one task, live. Adults and the assignee can read and add; comments can't be edited.
struct TaskCommentsSheet: View {
    let h: HouseholdContext
    let taskId: String, taskTitle: String
    @Environment(\.dismiss) private var dismiss
    @State private var q: LiveQuery<Record>?
    @State private var text = ""
    @State private var sending = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.md) {
                    let items = q?.items ?? []
                    if items.isEmpty { Text("No comments yet.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary) }
                    ForEach(items) { c in
                        VStack(alignment: .leading, spacing: 2) {
                            Text((c.s("source") == "agent" ? "Assistant" : h.name(c.s("authorUid")) ?? "Someone") + (c.t("createdAt").map { " · \(Dates.relative($0, tz: h.tz))" } ?? "")).font(HHFont.caption).foregroundStyle(HH.inkSecondary)
                            Text(c.s("body") ?? "").font(HHFont.body).foregroundStyle(HH.ink)
                        }
                    }
                    HHTextField(label: "Add a comment", text: $text, error: error, multiline: true)
                    HHButton(title: "Send", loading: sending) {
                        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !body.isEmpty else { return }
                        sending = true; error = nil
                        Task {
                            do {
                                _ = try await Firestore.firestore().collection("households/\(h.hid)/tasks/\(taskId)/comments").addDocument(data: ["householdId": h.hid, "authorUid": h.uid, "body": String(body.prefix(2000)), "createdAt": FieldValue.serverTimestamp()])
                                text = ""
                            } catch { self.error = "Couldn't send. Try again." }
                            sending = false
                        }
                    }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }.padding(Space.lg)
            }
            .navigationTitle(taskTitle).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { q = LiveQuery(Firestore.firestore().collection("households/\(h.hid)/tasks/\(taskId)/comments").order(by: "createdAt").limit(to: 100)) { Record(id: $0, data: $1) } }
        }
    }
}
