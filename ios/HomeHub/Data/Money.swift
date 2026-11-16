import Foundation

/// Money = integer minor units + ISO 4217 code. Parsing/formatting via Decimal; Double is never used for amounts.
enum Money {
    private static let overrides: [String: Int] = ["JPY": 0, "KRW": 0, "VND": 0, "CLP": 0, "ISK": 0, "UGX": 0, "XAF": 0, "XOF": 0, "PYG": 0, "RWF": 0,
                                                    "BHD": 3, "KWD": 3, "OMR": 3, "JOD": 3, "TND": 3, "LYD": 3, "IQD": 3]
    static func exponent(_ currency: String) -> Int { overrides[currency] ?? 2 }

    /// "1,234.50" → 123450 (INR). nil when not a valid amount for the currency.
    static func parse(_ text: String, currency: String) -> Int64? {
        let cleaned = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: "").replacingOccurrences(of: " ", with: "")
        guard cleaned.range(of: #"^\d+(\.\d+)?$"#, options: .regularExpression) != nil else { return nil }
        let parts = cleaned.split(separator: ".", omittingEmptySubsequences: false)
        let exp = exponent(currency)
        let frac = parts.count > 1 ? String(parts[1]) : ""
        guard frac.count <= exp, let whole = Int64(parts[0]) else { return nil }
        let fracValue = Int64(frac.padding(toLength: exp, withPad: "0", startingAt: 0)) ?? 0
        var scale: Int64 = 1
        for _ in 0..<exp { scale *= 10 }
        let (m, o1) = whole.multipliedReportingOverflow(by: scale)
        let (r, o2) = m.addingReportingOverflow(fracValue)
        return (o1 || o2) ? nil : r
    }

    static func format(_ minor: Int64, _ currency: String, locale: Locale = .current) -> String {
        let value = Decimal(minor) / pow(Decimal(10), exponent(currency))
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = currency
        f.locale = locale
        f.minimumFractionDigits = exponent(currency)
        f.maximumFractionDigits = exponent(currency)
        return f.string(from: value as NSDecimalNumber) ?? "\(currency) \(value)"
    }

    static func toInput(_ minor: Int64, _ currency: String) -> String {
        let value = Decimal(minor) / pow(Decimal(10), exponent(currency))
        return NSDecimalNumber(decimal: value).stringValue
    }

    static func percent(_ part: Int64, of whole: Int64) -> Int { whole <= 0 ? 0 : Int((part * 100) / whole) }
}
