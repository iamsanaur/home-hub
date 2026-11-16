import SwiftUI
import FirebaseFirestore

/// "Add several items": paste or type a list (one per line), check the preview, save everything at once.
/// Items already in the pantry (same name and unit) get the quantity added instead of a duplicate.
struct BulkPantrySheet: View {
    let h: HouseholdContext
    let existing: [Record]
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var location = ""
    @State private var saving = false
    @State private var error: String?

    private var locations: [String] {
        var seen = Set<String>(), out: [String] = []
        for l in existing.compactMap({ $0.s("location") }) + ["Pantry shelf"] where !l.isEmpty && seen.insert(l).inserted { out.append(l) }
        return Array(out.prefix(6))
    }
    private func match(_ l: ParsedPantryLine) -> Record? {
        existing.first { ($0.s("name") ?? "").trimmingCharacters(in: .whitespaces).caseInsensitiveCompare(l.name) == .orderedSame && $0.s("unit") == l.unit }
    }

    var body: some View {
        let raw = PantryParser.parse(text)
        let lines = PantryParser.mergeDuplicates(Array(raw.prefix(PantryParser.maxItems)))
        let good = lines.filter { $0.problem == nil }, bad = lines.filter { $0.problem != nil }
        let merges = good.filter { match($0) != nil }.count, news = good.count - merges
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.md) {
                    HHTextField(label: "Your list", text: $text, helper: "One item per line: quantity and unit are optional and can come before or after the name.", placeholder: "2 kg rice\nmilk 2 l\neggs x12\n- salt", multiline: true)
                    HStack {
                        HHButton(title: "Paste", kind: .secondary, systemImage: "doc.on.clipboard", fullWidth: false) { if let p = UIPasteboard.general.string { text = text.isEmpty ? p : text.trimmingCharacters(in: .newlines) + "\n" + p } }
                        if !text.isEmpty { HHButton(title: "Clear", kind: .tertiary, fullWidth: false) { text = "" } }
                    }
                    if raw.count > PantryParser.maxItems { Text("Only the first \(PantryParser.maxItems) lines are used. Add the rest in a second batch.").font(HHFont.caption).foregroundStyle(HH.warning) }
                    if !good.isEmpty {
                        Text("\(good.count) item\(good.count == 1 ? "" : "s") to add").font(HHFont.label)
                        GroupedList {
                            ForEach(Array(good.enumerated()), id: \.offset) { i, l in
                                if i > 0 { RowDivider() }
                                let m = match(l)
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(l.name).font(HHFont.cardTitle).foregroundStyle(HH.ink)
                                        Text("\(Dates.qty(l.quantity)) \(l.unit)" + (m.map { " · now \(Dates.qty(($0.d("quantity") ?? 0) + l.quantity)) \($0.s("unit") ?? "")" } ?? "")).font(HHFont.caption).foregroundStyle(HH.inkSecondary)
                                    }
                                    Spacer()
                                    StatusBadge(label: m != nil ? "Adds to existing" : "New", tone: m != nil ? .info : .success)
                                }.padding(.horizontal, Space.md).padding(.vertical, Space.xs)
                            }
                        }
                    }
                    if !bad.isEmpty {
                        Text("Couldn't read \(bad.count) line\(bad.count == 1 ? "" : "s") — they'll be skipped").font(HHFont.label).foregroundStyle(HH.warning)
                        ForEach(Array(bad.enumerated()), id: \.offset) { _, l in Label("“\(l.raw)” — \(l.problem ?? "")", systemImage: "exclamationmark.triangle").font(HHFont.caption).foregroundStyle(HH.inkSecondary) }
                    }
                    if !good.isEmpty {
                        Text("Storage location for new items").font(HHFont.label)
                        ChoiceChips(options: locations.map { ($0, $0) }, selection: Binding(get: { location.isEmpty ? (locations.first ?? "Pantry shelf") : location }, set: { location = $0 }))
                    }
                    if let error { Text(error).font(HHFont.bodyCompact).foregroundStyle(HH.danger) }
                    HHButton(title: good.isEmpty ? "Add items" : merges == 0 ? "Add \(news) item\(news == 1 ? "" : "s")" : news == 0 ? "Update \(merges) item\(merges == 1 ? "" : "s")" : "Add \(news), update \(merges)", loading: saving) { save(good) }
                        .disabled(good.isEmpty)
                }.padding(Space.lg)
            }
            .navigationTitle("Add several items").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private func save(_ good: [ParsedPantryLine]) {
        saving = true; error = nil
        let loc = location.isEmpty ? (locations.first ?? "Pantry shelf") : location
        Task {
            do {
                for l in good {
                    if let m = match(l) {
                        let next = (m.d("quantity") ?? 0) + l.quantity
                        try await Firestore.firestore().collection("households/\(h.hid)/pantryMovements").addDocument(data: ["householdId": h.hid, "createdBy": h.uid, "createdAt": FieldValue.serverTimestamp(),
                            "itemId": m.id, "name": m.s("name") ?? "", "kind": "restock", "delta": l.quantity, "unit": m.s("unit") ?? ""])
                        try await HouseholdWrites.update(h.hid, "pantryItems", id: m.id, uid: h.uid, ["quantity": next, "lowStock": m.d("minQuantity").map { next <= $0 } ?? false])
                    } else {
                        _ = try await HouseholdWrites.create(h.hid, "pantryItems", uid: h.uid, ["name": l.name, "nameKey": l.name.lowercased(), "quantity": l.quantity, "unit": l.unit,
                            "minQuantity": NSNull(), "lowStock": false, "location": loc, "expiresAt": NSNull()])
                    }
                }
                dismiss()
            } catch { self.error = "Couldn't save. Try again."; saving = false }
        }
    }
}
