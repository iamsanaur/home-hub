import SwiftUI
import FirebaseFirestore

let paymentMethods: [(String, String)] = [("upi", "UPI"), ("card", "Card"), ("cash", "Cash"), ("bank_transfer", "Bank transfer"), ("wallet", "Wallet"), ("other", "Other")]

private struct FinanceLocked: View {
    var body: some View { EmptyStateView(systemImage: "lock", title: "Finance is private", message: "Your role doesn't include household finance. Ask an owner or administrator if you need access.") }
}

struct FinanceView: View {
    @Environment(\.household) private var hOpt
    @State private var month = Calendar.current.date(from: Calendar.current.dateComponents([.year, .month], from: .now))!
    @State private var txns: LiveQuery<Record>?
    @State private var budgets: LiveQuery<Record>?
    @State private var adding = false

    var body: some View {
        if let h = hOpt {
            if !h.canFinance { Screen(title: "Finance") { FinanceLocked() } }
            else {
                let all = txns?.items ?? []
                let own = all.filter { $0.s("currency") == h.currency }
                let spent = own.filter { $0.s("type") == "expense" }.reduce(Int64(0)) { $0 + ($1.i("amountMinor") ?? 0) }
                let income = own.filter { $0.s("type") == "income" }.reduce(Int64(0)) { $0 + ($1.i("amountMinor") ?? 0) }
                let bud = budgets?.items ?? []
                let overall = bud.first { $0.s("category") == "*" }?.i("limitMinor")
                let byCat = Dictionary(grouping: own.filter { $0.s("type") == "expense" }, by: { $0.s("category") ?? "Other" }).mapValues { $0.reduce(Int64(0)) { $0 + ($1.i("amountMinor") ?? 0) } }.sorted { $0.value > $1.value }
                Screen(title: "Finance", subtitle: month.formatted(.dateTime.month(.wide).year())) {
                    if case .loading = txns?.state ?? .loading { LoadingSkeleton() } else {
                        HHCard {
                            BudgetSummaryView(spent: spent, limit: overall, income: income, currency: h.currency)
                            HStack {
                                kpi("Income", Money.format(income, h.currency)); kpi("Spending", Money.format(spent, h.currency))
                                kpi(overall != nil ? "Remaining" : "Net", Money.format(overall.map { $0 - spent } ?? (income - spent), h.currency))
                            }.padding(.top, Space.xs)
                        }
                        if !byCat.isEmpty {
                            SectionHeader(title: "By category")
                            HHCard {
                                ForEach(byCat, id: \.key) { cat, amt in
                                    let limit = bud.first { $0.s("category") == cat }?.i("limitMinor")
                                    let pct = limit.map { Money.percent(amt, of: $0) } ?? Money.percent(amt, of: max(spent, 1))
                                    ProgressRow(label: cat, fraction: Double(pct) / 100, value: Money.format(amt, h.currency) + (limit.map { " of \(Money.format($0, h.currency))" } ?? " · \(pct)% of spend"),
                                                tone: limit != nil && pct > 100 ? .danger : (limit != nil && pct >= 85 ? .warning : .brand)).padding(.vertical, 4)
                                }
                            }
                        }
                        SectionHeader(title: "Transactions")
                        if all.isEmpty { EmptyStateView(systemImage: "list.bullet.rectangle", title: "No transactions this month", message: "Record income and expenses to see where the money goes.", actionTitle: "Add transaction") { adding = true } }
                        else {
                            GroupedList {
                                ForEach(Array(all.enumerated()), id: \.element.id) { i, x in
                                    if i > 0 { RowDivider() }
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(x.s("description") ?? x.s("category") ?? "").font(HHFont.cardTitle).foregroundStyle(HH.ink)
                                            Text("\(x.s("category") ?? "") · \(paymentMethods.first { $0.0 == x.s("paymentMethod") }?.1 ?? "")" + (x.t("occurredAt").map { " · \(Dates.short($0, tz: h.tz))" } ?? ""))
                                                .font(HHFont.caption).foregroundStyle(HH.inkSecondary)
                                        }
                                        Spacer()
                                        if x.b("locked") { Image(systemName: "lock").foregroundStyle(HH.inkTertiary).accessibilityLabel("Locked record") }
                                        Text((x.s("type") == "income" ? "+" : "−") + Money.format(x.i("amountMinor") ?? 0, x.s("currency") ?? h.currency))
                                            .font(HHFont.numeric).foregroundStyle(x.s("type") == "income" ? HH.success : HH.ink)
                                    }
                                    .padding(.horizontal, Space.md).padding(.vertical, Space.sm).frame(minHeight: 56)
                                }
                            }
                        }
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) { Button { month = Calendar.current.date(byAdding: .month, value: -1, to: month)! } label: { Image(systemName: "chevron.left") }.accessibilityLabel("Previous month") }
                    ToolbarItem(placement: .topBarTrailing) { Button { month = Calendar.current.date(byAdding: .month, value: 1, to: month)! } label: { Image(systemName: "chevron.right") }.accessibilityLabel("Next month").disabled(month >= Calendar.current.date(from: Calendar.current.dateComponents([.year, .month], from: .now))!) }
                    ToolbarItem(placement: .primaryAction) { Button { adding = true } label: { Image(systemName: "plus") }.accessibilityLabel("Add transaction") }
                }
                .sheet(isPresented: $adding) { AddTransaction(h: h).presentationDetents([.large]) }
                .task(id: month) {
                    let end = Calendar.current.date(byAdding: .month, value: 1, to: month)!
                    txns = LiveQuery(Firestore.firestore().collection("households/\(h.hid)/transactions").whereField("occurredAt", isGreaterThanOrEqualTo: Timestamp(date: month))
                        .whereField("occurredAt", isLessThan: Timestamp(date: end)).order(by: "occurredAt", descending: true)) { Record(id: $0, data: $1) }
                    let f = DateFormatter(); f.dateFormat = "yyyy-MM"
                    budgets = LiveQuery(Firestore.firestore().collection("households/\(h.hid)/budgets").whereField("period", isEqualTo: f.string(from: month))) { Record(id: $0, data: $1) }
                }
            }
        }
    }
    private func kpi(_ l: String, _ v: String) -> some View {
        VStack(alignment: .leading) { Text(l).font(HHFont.caption).foregroundStyle(HH.inkSecondary); Text(v).font(.subheadline.monospacedDigit().weight(.semibold)).foregroundStyle(HH.ink).minimumScaleFactor(0.7).lineLimit(1) }
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct AddTransaction: View {
    let h: HouseholdContext
    @Environment(\.dismiss) private var dismiss
    @State private var type = "expense"
    @State private var amount = ""
    @State private var category = "Groceries"
    @State private var method = "upi"
    @State private var desc = ""
    @State private var date = Date.now
    @State private var busy = false
    @State private var tried = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.md) {
                    Picker("Type", selection: $type) { Text("Expense").tag("expense"); Text("Income").tag("income") }.pickerStyle(.segmented)
                    HHTextField(label: "Amount (\(h.currency))", text: $amount, error: tried && Money.parse(amount, currency: h.currency) == nil ? "Enter an amount, e.g. 450 or 450.50" : nil, keyboard: .decimalPad)
                    Text("Category").font(HHFont.label)
                    ChoiceChips(options: (type == "income" ? ["Salary", "Business", "Interest", "Gift", "Other"] : ["Groceries", "Utilities", "Rent", "Transport", "Dining", "Health", "Education", "Household", "Repairs", "Other"]).map { ($0, $0) }, selection: $category)
                    Text("Paid with").font(HHFont.label)
                    ChoiceChips(options: paymentMethods, selection: $method)
                    HHTextField(label: "Description", text: $desc, optional: true)
                    DatePicker("Date", selection: $date, displayedComponents: .date)
                    if let error { Text(error).font(HHFont.bodyCompact).foregroundStyle(HH.danger) }
                    HHButton(title: "Save transaction", loading: busy) {
                        tried = true
                        guard let minor = Money.parse(amount, currency: h.currency), minor > 0 else { return }
                        busy = true
                        Task {
                            do {
                                try await HouseholdWrites.create(h.hid, "transactions", uid: h.uid, ["type": type, "amountMinor": minor, "currency": h.currency, "category": category,
                                    "description": desc.isEmpty ? NSNull() : desc, "paymentMethod": method, "occurredAt": Timestamp(date: date), "locked": false, "receiptPath": NSNull()])
                                dismiss()
                            } catch { self.error = "Couldn't save. Try again." }
                            busy = false
                        }
                    }
                }.padding(Space.lg)
            }
            .navigationTitle("Add transaction").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

struct BillsView: View {
    @Environment(\.household) private var hOpt
    @State private var bills: LiveQuery<Record>?
    @State private var selected: Record?
    var body: some View {
        if let h = hOpt {
            if !h.canFinance { Screen(title: "Bills") { FinanceLocked() } }
            else {
                let active = (bills?.items ?? []).filter { $0.data["active"] as? Bool ?? true }
                Screen(title: "Bills") {
                    if case .loading = bills?.state ?? .loading { LoadingSkeleton() }
                    else if active.isEmpty { EmptyStateView(systemImage: "doc.text", title: "No bills yet", message: "Add recurring bills during setup or from the assistant to get reminders before they're due.") }
                    ForEach(BillState.allCases, id: \.self) { state in
                        let rows = active.filter { BillState.of($0, tz: h.tz) == state }
                        if !rows.isEmpty {
                            SectionHeader(title: state.rawValue)
                            GroupedList { ForEach(Array(rows.enumerated()), id: \.element.id) { i, b in if i > 0 { RowDivider() }; Button { selected = b } label: { BillRowView(bill: b, ctx: h) }.buttonStyle(.plain) } }
                        }
                    }
                    Text("Payments are recorded only when you confirm them. HomeHub never pays bills.").font(HHFont.caption).foregroundStyle(HH.inkSecondary).padding(.top, Space.md)
                }
                .task(id: h.hid) { bills = LiveQuery(Firestore.firestore().collection("households/\(h.hid)/bills").order(by: "nextDueAt")) { Record(id: $0, data: $1) } }
                .sheet(item: $selected) { b in BillDetail(h: h, bill: b).presentationDetents([.large]) }
            }
        }
    }
}

private struct BillDetail: View {
    let h: HouseholdContext, bill: Record
    @Environment(\.dismiss) private var dismiss
    @State private var amount = ""
    @State private var method = "upi"
    @State private var confirming = false
    @State private var busy = false
    @State private var error: String?
    @State private var payments: LiveQuery<Record>?
    var body: some View {
        let currency = bill.s("currency") ?? h.currency
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.md) {
                    Text("\(Money.format(bill.i("amountMinor") ?? 0, currency))" + (bill.t("nextDueAt").map { " · due \(Dates.relative($0, tz: h.tz))" } ?? "")).font(HHFont.body)
                    Text("Record a payment").font(HHFont.label)
                    HHTextField(label: "Amount paid (\(currency))", text: $amount, error: Money.parse(amount, currency: currency) == nil ? "Enter the amount you paid." : nil, keyboard: .decimalPad)
                    ChoiceChips(options: paymentMethods, selection: $method)
                    if !confirming { HHButton(title: "I've paid this bill") { confirming = Money.parse(amount, currency: currency) != nil } }
                    else {
                        Text("Confirm: you paid \(Money.format(Money.parse(amount, currency: currency) ?? 0, currency)) for \(bill.s("name") ?? "this bill") today. This adds an expense and moves the next due date.")
                            .font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
                        HStack {
                            HHButton(title: "Cancel", kind: .secondary) { confirming = false }
                            HHButton(title: "Confirm payment", loading: busy) {
                                busy = true
                                Task {
                                    do {
                                        try await Gateway.shared.call("POST", "/v1/households/\(h.hid)/bills/\(bill.id)/payments", body: ["amountMinor": Money.parse(amount, currency: currency) ?? 0, "currency": currency,
                                            "paidAt": ISO8601DateFormatter().string(from: .now), "method": method, "idempotencyKey": "bill-\(bill.id)-\(UUID().uuidString)"])
                                        dismiss()
                                    } catch { self.error = error.localizedDescription }
                                    busy = false
                                }
                            }
                        }
                    }
                    if let error { Text(error).font(HHFont.bodyCompact).foregroundStyle(HH.danger) }
                    Text("Payment history").font(HHFont.label)
                    let ps = payments?.items ?? []
                    if ps.isEmpty { Text("No payments recorded yet.").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary) }
                    ForEach(ps) { p in HStack { Text(p.t("paidAt").map { Dates.short($0, tz: h.tz) } ?? "—").foregroundStyle(HH.inkSecondary); Spacer(); Text(Money.format(p.i("amountMinor") ?? 0, currency)).font(HHFont.numeric) } }
                }.padding(Space.lg)
            }
            .navigationTitle(bill.s("name") ?? "Bill").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .onAppear { amount = Money.toInput(bill.i("amountMinor") ?? 0, currency) }
            .task { payments = LiveQuery(Firestore.firestore().collection("households/\(h.hid)/billPayments").whereField("billId", isEqualTo: bill.id).order(by: "paidAt", descending: true).limit(to: 12)) { Record(id: $0, data: $1) } }
        }
    }
}
