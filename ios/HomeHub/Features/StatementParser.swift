import Foundation

/// Reads the text of a UPI-app or bank statement (PhonePe, Google Pay, Paytm, or a bank's PDF) into payment rows.
///
/// Pure and offline: it gets the lines of text that PDF extraction produced and returns rows. Keep this in step with
/// android/.../spend/StatementParser.kt — both are tested against shared/statement-fixtures/fixtures.json.
///
/// A statement is a list of dated entries: every line that starts with a date opens an entry and the lines after it
/// (until the next date) belong to it. Amount, direction, merchant, UPI reference and time are picked out of the
/// entry. Entries that aren't completed payments (failed, no amount) are dropped, and one whose direction can't be
/// established is skipped rather than guessed — money in versus money out must never be a coin toss.
enum StatementApp: String {
    case phonepe, gpay, paytm, bank, other
    var label: String {
        switch self { case .phonepe: "PhonePe"; case .gpay: "Google Pay"; case .paytm: "Paytm"; case .bank: "Bank statement"; case .other: "Statement" }
    }
}

struct StatementRow: Equatable {
    var occurredAt: String      // ISO-8601 with offset
    var timeKnown: Bool
    var amountMinor: Int64
    var direction: String       // "debit" | "credit"
    var merchant: String?
    var upiRef: String?
    var accountLast4: String?
    var method = "upi"

    var json: [String: Any] {
        var d: [String: Any] = ["occurredAt": occurredAt, "timeKnown": timeKnown, "amountMinor": amountMinor, "direction": direction, "method": method]
        if let merchant { d["merchant"] = merchant }
        if let upiRef { d["upiRef"] = upiRef }
        if let accountLast4 { d["accountLast4"] = accountLast4 }
        return d
    }
}

struct StatementParse { let app: StatementApp; let rows: [StatementRow]; let skipped: Int }

private struct Rx {
    let re: NSRegularExpression
    init(_ pattern: String, _ options: NSRegularExpression.Options = []) { re = try! NSRegularExpression(pattern: pattern, options: options) }
    /// Capture groups of the first match (index 0 is the whole match); missing groups are "".
    func first(_ s: String) -> [String]? {
        let ns = s as NSString
        guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<m.numberOfRanges).map { let r = m.range(at: $0); return r.location == NSNotFound ? "" : ns.substring(with: r) }
    }
    func test(_ s: String) -> Bool { first(s) != nil }
    func all(_ s: String) -> [String] {
        let ns = s as NSString
        return re.matches(in: s, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range) }
    }
}

enum StatementParser {
    private static let months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

    // Nov 17, 2026 · 17Nov, 2026 / 17 Nov 2026 / 17-Nov-26 · 17/11/26 / 17-11-2026
    private static let dateA = Rx(#"^\s*([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})"#)
    private static let dateB = Rx(#"^\s*(\d{1,2})(?:st|nd|rd|th)?[\s-]*([A-Za-z]{3,9})\.?,?[\s-]*(\d{2,4})"#)
    private static let dateC = Rx(#"^\s*(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})"#)
    private static let time = Rx(#"\b(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?"#)
    private static let amount = Rx(#"([+-])?\s*(?:₹|\bRs\.?|\bINR)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)"#, .caseInsensitive)
    private static let decimal = Rx(#"(?<![\d.,])\d{1,3}(?:,\d{2,3})*\.\d{2}(?![\d.])|(?<![\d.,])\d+\.\d{2}(?![\d.])"#)
    private static let refLabelled = Rx(#"(?:UTR(?:\s*No\.?)?|UPI\s*Ref(?:erence)?(?:\s*(?:No|Number)\.?)?|UPI\s*Transaction\s*ID|RRN)\s*[:#]?\s*(\d{12})\b"#, .caseInsensitive)
    private static let refAny = Rx(#"\b(\d{12})\b"#)
    private static let account = Rx(#"(?:Paid\s+(?:by|from)|Debited\s+from|Credited\s+to|Account|A/c)[^0-9\n]{0,40}(\d{4})\b"#, .caseInsensitive)
    private static let failed = Rx(#"\b(failed|declined|cancelled|canceled|pending|unsuccessful)\b"#, .caseInsensitive)
    private static let explicit = Rx(#"\b(DEBIT|CREDIT)\b"#)
    private static let debitWords = Rx(#"\b(paid to|payment to|sent to|money sent|bill paid|paid for)\b"#, .caseInsensitive)
    private static let creditWords = Rx(#"\b(received from|money received|refund|cashback)\b"#, .caseInsensitive)
    private static let merchant = Rx(
        #"(?:Paid to|Received from|Payment to|Sent to|Money sent to|Refund from)\s+([^\n]+?)(?=\s+(?:DEBIT|CREDIT)\b|\s*(?:₹|Rs\.?\s?\d|INR\s?\d)|\s+[+-]\s*(?:₹|Rs|INR)|\s+(?:Transaction\s+ID|UTR|UPI)\b|\n|$)"#,
        .caseInsensitive)
    private static let opening = Rx(#"opening\s+balance\D{0,20}([0-9][0-9,]*\.\d{2})"#, .caseInsensitive)
    private static let ws = Rx(#"\s+"#)

    private struct Entry { let y: Int, m: Int, d: Int; var lines: [String] }
    private struct BankItem { let e: Entry; let amount: Int64?; let balance: Int64?; let upi: Bool }

    static func parse(_ raw: [String], zone: TimeZone) -> StatementParse {
        let lines = raw.map { clean($0) }.filter { !$0.isEmpty }
        let head = lines.prefix(60).joined(separator: " ")
        let declared: StatementApp =
            Rx("phonepe", .caseInsensitive).test(head) ? .phonepe
            : Rx(#"google\s*pay|gpay"#, .caseInsensitive).test(head) ? .gpay
            : Rx("paytm", .caseInsensitive).test(head) ? .paytm
            : (Rx("narration|particulars|withdrawal|description|debit", .caseInsensitive).test(head) && Rx("balance", .caseInsensitive).test(head)) ? .bank
            : .other
        let entries = makeEntries(lines)
        if declared == .bank { return bank(entries, all: lines, zone: zone) }

        var rows: [StatementRow] = []; var skipped = 0
        for e in entries {
            let text = e.lines.joined(separator: "\n")
            if failed.test(text) { continue }
            guard let amt = amount.first(text) else { continue }
            var dir: String?
            if let x = explicit.first(text) { dir = x[1] == "DEBIT" ? "debit" : "credit" }
            else if !amt[1].isEmpty { dir = amt[1] == "-" ? "debit" : "credit" }
            else {
                let d = debitWords.test(text), c = creditWords.test(text)
                if d != c { dir = d ? "debit" : "credit" }
            }
            guard let direction = dir else { skipped += 1; continue }
            guard let minor = minor(amt[2]), minor > 0 else { continue }
            let t = time.first(text).flatMap(clock)
            rows.append(StatementRow(
                occurredAt: iso(e, t, zone), timeKnown: t != nil, amountMinor: minor, direction: direction,
                merchant: merchant.first(text).flatMap { tidy($0[1]) },
                upiRef: (refLabelled.first(text) ?? refAny.first(text))?[1],
                accountLast4: account.first(text)?[1]))
        }
        return StatementParse(app: declared, rows: rows, skipped: skipped)
    }

    // MARK: bank statements — direction comes from the running balance, because plain text loses the column

    private static func bank(_ entries: [Entry], all: [String], zone: TimeZone) -> StatementParse {
        let items: [BankItem] = entries.map { e in
            let text = e.lines.joined(separator: " ")
            let nums = decimal.all(text)
            return BankItem(e: e, amount: nums.count >= 2 ? minor(nums[nums.count - 2]) : nil, balance: nums.last.flatMap { minor($0) },
                            upi: Rx(#"\bUPI\b"#, .caseInsensitive).test(text))
        }
        let openingBalance = all.lazy.compactMap { opening.first($0)?[1] }.compactMap { minor($0) }.first
        var rows: [StatementRow] = []; var skipped = 0
        for (i, b) in items.enumerated() {
            guard b.upi, let amt = b.amount, amt > 0 else { continue }
            let text = b.e.lines.joined(separator: " ")
            let before = i > 0 ? items[i - 1].balance : openingBalance   // when sorted oldest first
            let after = i + 1 < items.count ? items[i + 1].balance : nil // when sorted newest first
            var dir: String?
            if let bal = b.balance {
                let neighbours = [before, after].compactMap { $0 }
                let outs = neighbours.contains { $0 - amt == bal }, ins = neighbours.contains { $0 + amt == bal }
                if outs != ins { dir = outs ? "debit" : "credit" }
            }
            if dir == nil {
                let dr = Rx(#"UPI[-/ ]DR\b|/DR/|\bDEBIT\b"#, .caseInsensitive).test(text)
                let cr = Rx(#"UPI[-/ ]CR\b|/CR/|\bCREDIT\b"#, .caseInsensitive).test(text)
                if dr != cr { dir = dr ? "debit" : "credit" }
            }
            guard let direction = dir else { skipped += 1; continue }
            rows.append(StatementRow(occurredAt: iso(b.e, nil, zone), timeKnown: false, amountMinor: amt, direction: direction,
                                     merchant: bankMerchant(text), upiRef: refAny.first(text)?[1], accountLast4: nil))
        }
        return StatementParse(app: .bank, rows: rows, skipped: skipped)
    }

    private static func bankMerchant(_ text: String) -> String? {
        if let m = Rx(#"UPI/(?:DR|CR)/\d{12}/([^/]+)/"#, .caseInsensitive).first(text) { return tidy(m[1]) }                 // SBI
        if let m = Rx(#"UPI-([^-]+)-[^-\s]*@[^-\s]*-"#, .caseInsensitive).first(text) { return tidy(m[1]) }                  // HDFC
        if let m = Rx(#"UPI/([A-Za-z][^/]*)/\d{12}"#, .caseInsensitive).first(text) { return tidy(m[1]) }                     // Kotak
        if let m = Rx(#"([\w.\-]+)@[A-Za-z]+"#).first(text) { return tidy(m[1]) }
        return nil
    }

    // MARK: helpers

    private static func clean(_ s: String) -> String {
        let ns = s as NSString
        return ws.re.stringByReplacingMatches(in: s, range: NSRange(location: 0, length: ns.length), withTemplate: " ").trimmingCharacters(in: .whitespaces)
    }

    private static func makeEntries(_ lines: [String]) -> [Entry] {
        var out: [Entry] = []
        for line in lines {
            if let d = dateAtStart(line) { out.append(Entry(y: d.0, m: d.1, d: d.2, lines: [line])) }
            else if !out.isEmpty { out[out.count - 1].lines.append(line) }
        }
        return out
    }

    private static func dateAtStart(_ line: String) -> (Int, Int, Int)? {
        if let m = dateA.first(line), let mo = month(m[1]), let y = Int(m[3]), let d = Int(m[2]), valid(y, mo, d) { return (y, mo, d) }
        if let m = dateB.first(line), let mo = month(m[2]), let d = Int(m[1]), let y = year(m[3]), valid(y, mo, d) { return (y, mo, d) }
        if let m = dateC.first(line), let d = Int(m[1]), let mo = Int(m[2]), let y = year(m[3]), valid(y, mo, d) { return (y, mo, d) }   // day first, as in India
        return nil
    }

    private static func month(_ name: String) -> Int? {
        guard name.count <= 9, let i = months.firstIndex(of: String(name.lowercased().prefix(3))) else { return nil }
        return i + 1
    }
    private static func year(_ s: String) -> Int? { s.count == 2 ? Int(s).map { 2000 + $0 } : Int(s) }
    private static func valid(_ y: Int, _ m: Int, _ d: Int) -> Bool {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "UTC")!
        guard let date = cal.date(from: DateComponents(year: y, month: m, day: d)) else { return false }
        let c = cal.dateComponents([.year, .month, .day], from: date)
        return c.year == y && c.month == m && c.day == d
    }

    private static func clock(_ m: [String]) -> (Int, Int)? {
        guard var h = Int(m[1]), let min = Int(m[2]) else { return nil }
        let ap = m[3].lowercased()
        if !ap.isEmpty { h = (h % 12) + (ap == "pm" ? 12 : 0) }
        return (0...23).contains(h) && (0...59).contains(min) ? (h, min) : nil
    }

    private static func iso(_ e: Entry, _ t: (Int, Int)?, _ zone: TimeZone) -> String {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = zone
        let date = cal.date(from: DateComponents(year: e.y, month: e.m, day: e.d, hour: t?.0 ?? 12, minute: t?.1 ?? 0)) ?? Date()
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = zone; f.dateFormat = "yyyy-MM-dd'T'HH:mm:ssXXX"
        return f.string(from: date)
    }

    /// "1,234.5" → 123450 paise, no floating point.
    static func minor(_ s: String) -> Int64? {
        let parts = s.replacingOccurrences(of: ",", with: "").split(separator: ".", omittingEmptySubsequences: false)
        guard let whole = Int64(parts[0]) else { return nil }
        let frac = String(((parts.count > 1 ? String(parts[1]) : "") + "00").prefix(2))
        guard let paise = Int64(frac) else { return nil }
        return whole * 100 + paise
    }

    /// Trims, drops trailing punctuation, and title-cases names the statement printed in capitals.
    private static func tidy(_ raw: String) -> String? {
        var s = raw.trimmingCharacters(in: .whitespaces)
        while let l = s.last, "-,.: ".contains(l) { s.removeLast() }
        s = clean(s)
        if s.count < 2 { return nil }
        if s.contains(where: { $0.isLowercase }) { return s }
        return s.lowercased().split(separator: " ").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }
}
