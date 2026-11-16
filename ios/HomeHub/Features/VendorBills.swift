import SwiftUI

private let weekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
private let vendorUnits: [(String, String)] = [("l", "Liters"), ("copies", "Copies"), ("days", "Days"), ("cans", "Cans"), ("meals", "Meals")]
private func trimQty(_ q: Double) -> String { q.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(q)) : String(q) }

/// Add form for a bill charged per delivery (milk, newspaper, maid, water cans, tiffin).
struct AddVendorBillForm: View {
    let h: HouseholdContext
    let onDone: () -> Void
    @State private var name = ""
    @State private var vendor = ""
    @State private var unit = "l"
    @State private var rate = ""
    @State private var qty = "1"
    @State private var days: Set<Int> = [1, 2, 3, 4, 5, 6, 7]
    @State private var dueDay = "5"
    @State private var tried = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        let rateMinor = Money.parse(rate, currency: h.currency).flatMap { $0 > 0 ? $0 : nil }
        let q = Double(qty.replacingOccurrences(of: ",", with: ".")).flatMap { $0 >= 0 ? $0 : nil }
        let due = Int(dueDay).flatMap { (1...28).contains($0) ? $0 : nil }
        VStack(alignment: .leading, spacing: Space.md) {
            HHTextField(label: "Bill name", text: $name, error: tried && name.trimmingCharacters(in: .whitespaces).isEmpty ? "Name the bill." : nil, placeholder: "e.g. Milk")
            HHTextField(label: "Vendor (optional)", text: $vendor, optional: true, placeholder: "e.g. Ramesh")
            Text("Charged per").font(HHFont.label)
            ChoiceChips(options: vendorUnits, selection: $unit)
            HHTextField(label: "Price per \(unit) (\(h.currency))", text: $rate, error: tried && rateMinor == nil ? "Enter the price for one \(unit)." : nil, keyboard: .decimalPad)
            HHTextField(label: "Usual quantity per delivery", text: $qty, error: tried && q == nil ? "Enter a number." : nil, keyboard: .decimalPad)
            Text("Delivery days").font(HHFont.label)
            HStack(spacing: 4) {
                ForEach(0..<7, id: \.self) { i in
                    let on = days.contains(i + 1)
                    Button { if on && days.count > 1 { days.remove(i + 1) } else { days.insert(i + 1) } } label: {
                        Text(weekdayLabels[i]).font(HHFont.caption).frame(maxWidth: .infinity, minHeight: 40)
                            .background(on ? HH.brand : HH.surfaceSubtle, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .foregroundStyle(on ? Color.white : HH.ink)
                    }.buttonStyle(.plain).accessibilityLabel("\(weekdayLabels[i]) \(on ? "delivered" : "not delivered")")
                }
            }
            HHTextField(label: "Pay on day of the next month (1–28)", text: $dueDay, error: tried && due == nil ? "Use 1 to 28." : nil, keyboard: .numberPad)
            if let error { Text(error).font(HHFont.bodyCompact).foregroundStyle(HH.danger) }
            HHButton(title: "Add bill", loading: busy) {
                tried = true
                guard let rateMinor, let q, let due, !name.trimmingCharacters(in: .whitespaces).isEmpty else { return }
                busy = true
                var body: [String: Any] = ["name": name.trimmingCharacters(in: .whitespaces), "unit": unit, "rateMinor": rateMinor, "defaultQuantity": q, "dueDay": due, "weekdays": days.sorted()]
                if !vendor.trimmingCharacters(in: .whitespaces).isEmpty { body["vendor"] = vendor.trimmingCharacters(in: .whitespaces) }
                Task {
                    do { try await Gateway.shared.call("POST", "/v1/households/\(h.hid)/vendor-bills", body: body); onDone() }
                    catch { self.error = error.localizedDescription; busy = false }
                }
            }
        }
    }
}

/// The month of a pay-per-delivery bill: tap a day to mark "didn't come" or change the quantity. `onTotal` reports the
/// month's total (minor units) so "I've paid" can prefill it.
struct VendorLedgerSection: View {
    let h: HouseholdContext
    let bill: Record
    let onTotal: (Int64) -> Void
    @State private var month: String?
    @State private var ledger: [String: Any]?
    @State private var error: String?
    @State private var picked: String?
    @State private var custom = ""
    @State private var busy = false
    @State private var newRate = ""
    private var meter: [String: Any] { bill.data["meter"] as? [String: Any] ?? [:] }
    private var unit: String { ((ledger?["bill"] as? [String: Any])?["unit"] as? String) ?? (meter["unit"] as? String) ?? "" }
    private var currency: String { bill.s("currency") ?? h.currency }
    private var rateMinor: Int64 { ((meter["rateMinor"] as? NSNumber)?.int64Value) ?? 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text("Deliveries").font(HHFont.label)
            if let l = ledger, let days = l["days"] as? [[String: Any]], let first = days.first?["date"] as? String {
                let editable = l["editable"] as? Bool ?? false
                let ym = l["month"] as? String ?? first.prefix(7).description
                HStack {
                    Button { shift(ym, -1) } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44) }.accessibilityLabel("Previous month")
                    Spacer()
                    Text(title(ym) + ((l["paid"] as? Bool ?? false) ? " · paid" : "")).font(HHFont.label)
                    Spacer()
                    Button { shift(ym, 1) } label: { Image(systemName: "chevron.right").frame(width: 44, height: 44) }.accessibilityLabel("Next month")
                }
                let lead = (days.first?["weekday"] as? Int ?? 1) - 1
                let cells: [[String: Any]?] = Array(repeating: nil, count: lead) + days.map { Optional($0) }
                ForEach(Array(stride(from: 0, to: cells.count, by: 7)), id: \.self) { start in
                    HStack(spacing: 4) {
                        ForEach(0..<7, id: \.self) { i in
                            if let d = start + i < cells.count ? cells[start + i] : nil { cell(d, editable) } else { Color.clear.frame(maxWidth: .infinity, minHeight: 44) }
                        }
                    }
                }
                if let date = picked { editor(date) }
                else { Text(editable ? "Tap a day to mark it as not delivered or change the quantity." : "This month is closed.").font(HHFont.caption).foregroundStyle(HH.inkSecondary) }
                if let t = l["totals"] as? [String: Any] {
                    let delivered = t["deliveredDays"] as? Int ?? 0, skipped = t["skippedDays"] as? Int ?? 0, planned = t["plannedDays"] as? Int ?? 0
                    let q = (t["quantity"] as? NSNumber)?.doubleValue ?? 0, total = (t["totalMinor"] as? NSNumber)?.int64Value ?? 0
                    Text("\(delivered + planned) days delivered · \(skipped) skipped · \(trimQty(q)) \(unit) × \(Money.format(rateMinor, currency)) = \(Money.format(total, currency))").font(HHFont.numeric)
                }
                priceChange(editable)
            } else { Text(error ?? "Loading…").font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary) }
        }
        .task(id: month ?? "") { await load() }
    }

    private func title(_ ym: String) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM"; f.timeZone = TimeZone(identifier: "UTC")
        guard let d = f.date(from: ym) else { return ym }
        let o = DateFormatter(); o.dateFormat = "LLLL yyyy"; o.timeZone = TimeZone(identifier: "UTC"); return o.string(from: d)
    }
    private func shift(_ ym: String, _ by: Int) {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM"; f.timeZone = TimeZone(identifier: "UTC")
        guard let d = f.date(from: ym), let n = Calendar(identifier: .gregorian).date(byAdding: .month, value: by, to: d) else { return }
        month = f.string(from: n)
    }
    private func load() async {
        do {
            let l = try await Gateway.shared.call("GET", "/v1/households/\(h.hid)/vendor-bills/\(bill.id)/ledger" + (month.map { "?month=\($0)" } ?? ""))
            ledger = l; error = nil
            if month == nil { month = l["month"] as? String }
            if let t = (l["totals"] as? [String: Any])?["totalMinor"] as? NSNumber { onTotal(t.int64Value) }
        } catch { self.error = error.localizedDescription }
    }

    private func cell(_ d: [String: Any], _ editable: Bool) -> some View {
        let date = d["date"] as? String ?? "", status = d["status"] as? String ?? "none", q = (d["quantity"] as? NSNumber)?.doubleValue ?? 0
        let bg: Color = switch status { case "skipped": HH.danger.opacity(0.18); case "extra": HH.brand.opacity(0.22); case "delivered": HH.brand.opacity(0.08); default: HH.surfaceSubtle }
        let day = String(Int(date.suffix(2)) ?? 0)
        let desc = switch status { case "skipped": "not delivered"; case "extra": "\(trimQty(q)) \(unit), changed"; case "delivered": "\(trimQty(q)) \(unit) delivered"; case "planned": "planned \(trimQty(q)) \(unit)"; default: "no delivery" }
        return Button { if editable { picked = date; custom = trimQty(q) } } label: {
            VStack(spacing: 0) {
                Text(day).font(HHFont.caption).foregroundStyle(HH.ink)
                if status != "none" { Text(status == "skipped" ? "–" : trimQty(q)).font(HHFont.caption).foregroundStyle(status == "skipped" ? HH.danger : HH.inkSecondary) }
            }.frame(maxWidth: .infinity, minHeight: 44).background(bg, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }.buttonStyle(.plain).disabled(!editable).accessibilityLabel("\(day), \(desc)")
    }

    private func editor(_ date: String) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(date).font(HHFont.label)
            HStack {
                HHButton(title: "Didn't come", kind: .secondary, loading: busy) { save(date, 0) }
                HHButton(title: "Normal", kind: .secondary) { save(date, nil) }
            }
            HStack(alignment: .bottom) {
                HHTextField(label: "Quantity (\(unit))", text: $custom, keyboard: .decimalPad)
                HHButton(title: "Set", fullWidth: false) { if let v = Double(custom.replacingOccurrences(of: ",", with: ".")), v >= 0 { save(date, v) } }
            }
        }
    }

    private func save(_ date: String, _ q: Double?) {
        busy = true
        Task {
            do {
                try await Gateway.shared.call("PUT", "/v1/households/\(h.hid)/vendor-bills/\(bill.id)/deliveries", body: ["entries": [["date": date, "quantity": q as Any? ?? NSNull()]]])
                picked = nil; await load()
            } catch { self.error = error.localizedDescription }
            busy = false
        }
    }

    @ViewBuilder private func priceChange(_ editable: Bool) -> some View {
        let minor = Money.parse(newRate, currency: currency).flatMap { $0 > 0 ? $0 : nil }
        HHTextField(label: "Change price per \(unit) (\(currency))", text: $newRate, helper: "Takes effect next month unless you apply it to this month.", keyboard: .decimalPad)
        if let minor {
            HStack {
                HHButton(title: "From next month", kind: .secondary) { reprice(minor, false) }
                HHButton(title: "This month too") { reprice(minor, true) }.disabled(!editable)
            }
        }
    }
    private func reprice(_ minor: Int64, _ thisMonth: Bool) {
        Task {
            do { try await Gateway.shared.call("PATCH", "/v1/households/\(h.hid)/vendor-bills/\(bill.id)", body: ["rateMinor": minor, "applyToCurrentMonth": thisMonth]); newRate = ""; await load() }
            catch { self.error = error.localizedDescription }
        }
    }
}
