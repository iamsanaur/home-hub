import SwiftUI
import SwiftData
import FirebaseFirestore

// MARK: Shopping

struct ShoppingView: View {
    @Environment(\.household) private var hOpt
    var body: some View { if let h = hOpt { ShoppingContent(h: h) } }
}

private struct ShoppingContent: View {
    let h: HouseholdContext
    @Environment(AppModel.self) private var model
    @Query(sort: \LocalGrocery.name) private var all: [LocalGrocery]
    @State private var lists: LiveQuery<Record>?
    @State private var selected: String?
    @State private var adding = false
    @State private var newList = false

    var body: some View {
        let ls = lists?.items ?? []
        let active = ls.first { $0.id == selected } ?? ls.first
        let items = all.filter { $0.householdId == h.hid && $0.listId == active?.id }.map(\.model)
        let toBuy = items.filter { !$0.purchased }
        let estimate = toBuy.compactMap(\.estimatedPriceMinor).reduce(0, +)
        let unpriced = toBuy.filter { $0.estimatedPriceMinor == nil }.count
        Screen(title: "Shopping", subtitle: active?.s("name")) {
            if case .loading = lists?.state ?? .loading { LoadingSkeleton() }
            else if ls.isEmpty {
                EmptyStateView(systemImage: "cart", title: "No shopping lists yet", message: "Create a list, or let the assistant build one from your pantry and meal plan.", actionTitle: "Create a list") { newList = true }
            } else {
                if ls.count > 1 { ChoiceChips(options: ls.map { ($0.id, $0.s("name") ?? "List") }, selection: Binding(get: { active?.id ?? "" }, set: { selected = $0 })).padding(.vertical, Space.xs) }
                Text("\(toBuy.count) to buy" + (estimate > 0 ? " · about \(Money.format(estimate, h.currency))" + (unpriced > 0 ? " (\(unpriced) without a price)" : "") : ""))
                    .font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
                ForEach(Dictionary(grouping: toBuy, by: \.category).sorted { $0.key < $1.key }, id: \.key) { cat, rows in
                    SectionHeader(title: cat)
                    GroupedList { ForEach(Array(rows.enumerated()), id: \.element.id) { i, it in if i > 0 { RowDivider() }; row(it) } }
                }
                let bought = items.filter(\.purchased)
                if !bought.isEmpty {
                    SectionHeader(title: "In the basket")
                    GroupedList { ForEach(Array(bought.enumerated()), id: \.element.id) { i, it in if i > 0 { RowDivider() }; row(it) } }
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) { Button { adding = true } label: { Image(systemName: "plus") }.accessibilityLabel("Add item").disabled(active == nil) }
            if h.role.isAdultPlus || h.role == .staff { ToolbarItem(placement: .secondaryAction) { Button("New list") { newList = true } } }
        }
        .sheet(isPresented: $adding) { if let a = active { AddGrocery(h: h, listId: a.id).presentationDetents([.medium, .large]) } }
        .sheet(isPresented: $newList) { NewList(h: h) { selected = $0 }.presentationDetents([.medium]) }
        .task(id: h.hid) { lists = LiveQuery(Firestore.firestore().collection("households/\(h.hid)/shoppingLists").whereField("archived", isEqualTo: false)) { Record(id: $0, data: $1) } }
        .onChange(of: active?.id) { _, id in if let id { model.offline.attachList(hid: h.hid, listId: id) } }
        .onAppear { if let id = active?.id { model.offline.attachList(hid: h.hid, listId: id) } }
    }

    private func row(_ it: GroceryItem) -> some View {
        Button { model.offline.setPurchased(hid: h.hid, uid: h.uid, id: it.id, purchased: !it.purchased) } label: {
            HStack(spacing: Space.sm) {
                Image(systemName: it.purchased ? "checkmark.square.fill" : "square").font(.title3).foregroundStyle(it.purchased ? HH.success : HH.inkSecondary).frame(width: 44, height: 44)
                VStack(alignment: .leading) {
                    Text(it.name).font(HHFont.cardTitle).foregroundStyle(it.purchased ? HH.inkTertiary : HH.ink).strikethrough(it.purchased)
                    Text("\(Dates.qty(it.quantity)) \(it.unit)").font(HHFont.caption).foregroundStyle(HH.inkSecondary)
                }
                Spacer()
                if it.pendingSync { Image(systemName: "arrow.triangle.2.circlepath").foregroundStyle(HH.inkTertiary).accessibilityLabel("Waiting to sync") }
                if let p = it.actualPriceMinor ?? it.estimatedPriceMinor { Text((it.actualPriceMinor == nil ? "≈ " : "") + Money.format(p, h.currency)).font(.subheadline.monospacedDigit()).foregroundStyle(HH.inkSecondary) }
            }
            .padding(.trailing, Space.md).frame(minHeight: 56).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(it.purchased ? "Purchased" : "Not purchased")
    }
}

private struct AddGrocery: View {
    let h: HouseholdContext, listId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var qty = "1"
    @State private var unit = "pcs"
    @State private var cat = "Other"
    @State private var price = ""
    @State private var tried = false
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.md) {
                    HHTextField(label: "Item", text: $name, error: tried && name.isEmpty ? "What do you need?" : nil)
                    HHTextField(label: "Quantity", text: $qty, error: tried && Double(qty) == nil ? "Enter a quantity above 0." : nil, keyboard: .decimalPad)
                    ChoiceChips(options: ["pcs", "kg", "g", "l", "ml", "pack", "dozen", "bunch"].map { ($0, $0) }, selection: $unit)
                    ChoiceChips(options: ["Vegetables", "Fruit", "Dairy", "Staples", "Snacks", "Household", "Other"].map { ($0, $0) }, selection: $cat)
                    HHTextField(label: "Estimated price (\(h.currency))", text: $price, optional: true, helper: "Used for list estimates. Leave empty if you don't know.",
                                error: !price.isEmpty && Money.parse(price, currency: h.currency) == nil ? "Not a valid amount." : nil, keyboard: .decimalPad)
                    HHButton(title: "Add to list") {
                        tried = true
                        guard !name.isEmpty, let q = Double(qty), q > 0, price.isEmpty || Money.parse(price, currency: h.currency) != nil else { return }
                        model.offline.addGrocery(hid: h.hid, listId: listId, name: name, quantity: q, unit: unit, category: cat, estimatedPriceMinor: price.isEmpty ? nil : Money.parse(price, currency: h.currency))
                        dismiss()
                    }
                }.padding(Space.lg)
            }
            .navigationTitle("Add item").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

private struct NewList: View {
    let h: HouseholdContext, created: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var busy = false
    var body: some View {
        NavigationStack {
            VStack(spacing: Space.md) {
                HHTextField(label: "List name", text: $name, placeholder: "e.g. Weekly groceries")
                HHButton(title: "Create list", loading: busy) {
                    guard !name.isEmpty else { return }
                    busy = true
                    Task {
                        if let id = try? await HouseholdWrites.create(h.hid, "shoppingLists", uid: h.uid, ["name": name, "store": NSNull(), "archived": false, "itemCount": 0, "purchasedCount": 0]) { created(id); dismiss() }
                        busy = false
                    }
                }
                Spacer()
            }
            .padding(Space.lg).navigationTitle("New list").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

// MARK: Pantry

struct PantryView: View {
    @Environment(\.household) private var hOpt
    @State private var q: LiveQuery<Record>?
    @State private var editing: Record?
    var body: some View {
        if let h = hOpt {
            let items = q?.items ?? []
            let soon = Date.now.addingTimeInterval(3 * 86400)
            Screen(title: "Pantry") {
                if case .loading = q?.state ?? .loading { LoadingSkeleton() }
                else if items.isEmpty { EmptyStateView(systemImage: "refrigerator", title: "Pantry is empty", message: "Track staples with a minimum level and HomeHub will tell you when they run low.") }
                let low = items.filter { $0.b("lowStock") }
                if !low.isEmpty {
                    HHCard {
                        Text("\(low.count) running low").font(HHFont.cardTitle)
                        Text(low.compactMap { $0.s("name") }.joined(separator: ", ")).font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
                        NavigationLink { AIView(initialPrompt: "Add our low-stock pantry items to the shopping list.") } label: { Label("Add them to a shopping list", systemImage: "sparkles").frame(maxWidth: .infinity, minHeight: 44) }
                            .buttonStyle(HHButtonStyle(kind: .secondary))
                    }.padding(.top, Space.sm)
                }
                ForEach(Dictionary(grouping: items, by: { $0.s("location") ?? "Other" }).sorted { $0.key < $1.key }, id: \.key) { loc, rows in
                    SectionHeader(title: loc)
                    GroupedList {
                        ForEach(Array(rows.enumerated()), id: \.element.id) { i, r in
                            if i > 0 { RowDivider() }
                            Button { editing = r } label: {
                                HHListRow(title: r.s("name") ?? "", subtitle: "\(Dates.qty(r.d("quantity") ?? 0)) \(r.s("unit") ?? "")" + (r.d("minQuantity").map { " · min \(Dates.qty($0))" } ?? "") + (r.t("expiresAt").map { " · expires \(Dates.short($0, tz: h.tz))" } ?? ""),
                                          trailing: AnyView(Group {
                                              if let e = r.t("expiresAt"), e < soon { StatusBadge(label: "Expiring", tone: .warning, systemImage: "exclamationmark.triangle") }
                                              else if r.b("lowStock") { StatusBadge(label: "Low", tone: .warning) }
                                          }))
                            }.buttonStyle(.plain).disabled(!(h.role.isAdultPlus || h.role == .staff))
                        }
                    }
                }
            }
            .task(id: h.hid) { q = LiveQuery(Firestore.firestore().collection("households/\(h.hid)/pantryItems").order(by: "name")) { Record(id: $0, data: $1) } }
            .sheet(item: $editing) { r in PantryAdjust(h: h, item: r).presentationDetents([.medium]) }
        }
    }
}

private struct PantryAdjust: View {
    let h: HouseholdContext, item: Record
    @Environment(\.dismiss) private var dismiss
    @State private var amount = ""
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Space.md) {
                Text("In stock: \(Dates.qty(item.d("quantity") ?? 0)) \(item.s("unit") ?? "")").font(HHFont.body)
                HHTextField(label: "Amount (\(item.s("unit") ?? ""))", text: $amount, keyboard: .decimalPad)
                HStack(spacing: Space.xs) {
                    ForEach([("Used", "consume"), ("Restocked", "restock"), ("Wasted", "waste")], id: \.1) { label, kind in
                        HHButton(title: label, kind: kind == "restock" ? .primary : .secondary, loading: busy) { apply(kind) }.disabled(Double(amount) == nil)
                    }
                }
                if let error { Text(error).font(HHFont.bodyCompact).foregroundStyle(HH.danger) }
                Text("Every change is recorded in the stock history, including waste.").font(HHFont.caption).foregroundStyle(HH.inkSecondary)
                Spacer()
            }
            .padding(Space.lg).navigationTitle(item.s("name") ?? "Item").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
    }
    private func apply(_ kind: String) {
        guard let d = Double(amount), d > 0 else { return }
        let signed = kind == "restock" ? d : -d
        busy = true
        Task {
            do {
                try await Firestore.firestore().collection("households/\(h.hid)/pantryMovements").addDocument(data: ["householdId": h.hid, "createdBy": h.uid, "createdAt": FieldValue.serverTimestamp(),
                    "itemId": item.id, "name": item.s("name") ?? "", "kind": kind, "delta": signed, "unit": item.s("unit") ?? ""])
                let next = max(0, (item.d("quantity") ?? 0) + signed)
                try await HouseholdWrites.update(h.hid, "pantryItems", id: item.id, uid: h.uid, ["quantity": next, "lowStock": item.d("minQuantity").map { next <= $0 } ?? false])
                dismiss()
            } catch { self.error = "Couldn't update. Try again." }
            busy = false
        }
    }
}

// MARK: Meals

struct MealsView: View {
    @Environment(\.household) private var hOpt
    @State private var weekStart = MealsView.monday(.now)
    @State private var plan: LiveDoc?
    @State private var generating = false
    @State private var message: String?
    static func monday(_ d: Date) -> Date { var c = Calendar(identifier: .iso8601); c.timeZone = .current; return c.date(from: c.dateComponents([.yearForWeekOfYear, .weekOfYear], from: d))! }
    var key: String { let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.calendar = Calendar(identifier: .gregorian); return f.string(from: weekStart) }

    var body: some View {
        if let h = hOpt {
            let entries = (plan?.data?["entries"] as? [[String: Any]]) ?? []
            Screen(title: "Meals", subtitle: "Week of \(weekStart.formatted(date: .abbreviated, time: .omitted))") {
                if plan?.loaded == true && plan?.data == nil {
                    NavigationLink { AIView(initialPrompt: "Plan meals for the week of \(key).") } label: {
                        EmptyStateView(systemImage: "fork.knife", title: "No plan for this week", message: "Let the assistant draft a week from your recorded preferences and pantry.")
                    }.buttonStyle(.plain)
                }
                ForEach(0..<7, id: \.self) { off in
                    let day = Calendar.current.date(byAdding: .day, value: off, to: weekStart)!
                    let dayKey: String = { let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f.string(from: day) }()
                    SectionHeader(title: day.formatted(.dateTime.weekday(.wide).day()))
                    GroupedList {
                        ForEach(Array(["breakfast", "lunch", "dinner", "snack"].enumerated()), id: \.offset) { i, slot in
                            if i > 0 { RowDivider() }
                            let e = entries.first { $0["date"] as? String == dayKey && $0["slot"] as? String == slot }
                            HHListRow(title: e?["title"] as? String ?? "—", subtitle: slot.capitalized + ((e?["servings"] as? Int).map { " · \($0) servings" } ?? ""))
                        }
                    }
                }
                if plan?.data != nil && h.role.isAdultPlus {
                    HHButton(title: "Generate shopping list", loading: generating) {
                        generating = true
                        Task {
                            do {
                                let r = try await Gateway.shared.call("POST", "/v1/households/\(h.hid)/meal-plans/\(key)/shopping-list")
                                let est = r["estimate"] as? [String: Any]
                                message = "Added \((r["items"] as? [Any])?.count ?? 0) items · about \(Money.format((est?["totalMinor"] as? NSNumber)?.int64Value ?? 0, h.currency))"
                            } catch { message = error.localizedDescription }
                            generating = false
                        }
                    }.padding(.top, Space.lg)
                    Text("Ingredients already in your pantry are left off. Costs use only prices you've recorded.").font(HHFont.caption).foregroundStyle(HH.inkSecondary)
                    if let message { Text(message).font(HHFont.bodyCompact).foregroundStyle(HH.ink) }
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button { weekStart = Calendar.current.date(byAdding: .day, value: -7, to: weekStart)! } label: { Image(systemName: "chevron.left") }.accessibilityLabel("Previous week") }
                ToolbarItem(placement: .topBarTrailing) { Button { weekStart = Calendar.current.date(byAdding: .day, value: 7, to: weekStart)! } label: { Image(systemName: "chevron.right") }.accessibilityLabel("Next week") }
            }
            .task(id: key) { plan = LiveDoc(Firestore.firestore().document("households/\(h.hid)/mealPlans/\(key)")) }
        }
    }
}
