import Foundation

/// One line of a pasted pantry list, read into an item. `problem` is set when the line couldn't be read.
struct ParsedPantryLine: Equatable {
    let raw: String, name: String, quantity: Double, unit: String, problem: String?
}

/// Reads a pasted shopping/pantry list on the phone (no AI, no network). Same rules and test lines as the Android app
/// (PantryParser.kt): "2 kg rice", "rice 2kg", "rice - 2 kg", "eggs x12", "½ kg sugar", "- salt" (quantity 1), bullets, numbering.
enum PantryParser {
    static let maxItems = 100
    static let units = ["pcs", "kg", "g", "l", "ml", "pack", "dozen", "bunch"]

    private static let unitWords: [String: String] = [
        "kg": "kg", "kgs": "kg", "kilo": "kg", "kilos": "kg", "kilogram": "kg", "kilograms": "kg",
        "g": "g", "gm": "g", "gms": "g", "gram": "g", "grams": "g", "gr": "g",
        "l": "l", "lt": "l", "ltr": "l", "ltrs": "l", "litre": "l", "litres": "l", "liter": "l", "liters": "l",
        "ml": "ml", "millilitre": "ml", "milliliter": "ml", "millilitres": "ml", "milliliters": "ml",
        "pc": "pcs", "pcs": "pcs", "piece": "pcs", "pieces": "pcs", "no": "pcs", "nos": "pcs", "unit": "pcs", "units": "pcs",
        "bottle": "pcs", "bottles": "pcs", "can": "pcs", "cans": "pcs", "tin": "pcs", "tins": "pcs", "box": "pcs", "boxes": "pcs",
        "pack": "pack", "packs": "pack", "packet": "pack", "packets": "pack", "pkt": "pack", "pkts": "pack",
        "dozen": "dozen", "doz": "dozen", "dz": "dozen",
        "bunch": "bunch", "bunches": "bunch",
    ]
    private static let unitAlt = unitWords.keys.sorted { $0.count > $1.count }.joined(separator: "|")
    private static let num = #"(?:\d+\s*/\s*\d+|\d+(?:[.,]\d+)?|[½¼¾])"#
    private static func rx(_ p: String) -> NSRegularExpression { try! NSRegularExpression(pattern: p, options: [.caseInsensitive]) }
    private static let start = rx(#"^(\#(num))\s*(\#(unitAlt))?\b\.?\s*(?:of\s+|x\s+|×\s*)?(.+)$"#)
    private static let end = rx(#"^(.+?)[\s,:\-–—|]*\(?(?:x\s*|×\s*)?(\#(num))[\s,]*(\#(unitAlt))?\)?$"#)
    private static let onlyQuantity = rx(#"^(\#(num))\s*(\#(unitAlt))?\.?$"#)
    private static let bullet = rx(#"^\s*(?:[-*•·–—]+|\d+[.)](?=\s+\D))\s*"#)
    private static let thousands = rx(#"^\d+,\d{3}$"#)

    private static func groups(_ r: NSRegularExpression, _ s: String) -> [String]? {
        let ns = s as NSString
        guard let m = r.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)), m.range.length == ns.length else { return nil }
        return (0..<m.numberOfRanges).map { m.range(at: $0).location == NSNotFound ? "" : ns.substring(with: m.range(at: $0)) }
    }

    private static func number(_ s: String) -> Double? {
        let t = s.trimmingCharacters(in: .whitespaces)
        switch t {
        case "½": return 0.5
        case "¼": return 0.25
        case "¾": return 0.75
        default: break
        }
        if t.contains("/") {
            let p = t.split(separator: "/", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            guard p.count == 2, let a = Double(p[0]), let b = Double(p[1]), b != 0 else { return nil }
            return a / b
        }
        if groups(thousands, t) != nil { return Double(t.replacingOccurrences(of: ",", with: "")) }
        return Double(t.replacingOccurrences(of: ",", with: "."))
    }

    private static func tidy(_ name: String) -> String {
        let collapsed = name.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        let n = collapsed.trimmingCharacters(in: CharacterSet(charactersIn: ",:;-–—|.() ")).trimmingCharacters(in: .whitespaces)
        guard let f = n.first else { return n }
        return f.uppercased() + n.dropFirst()
    }

    static func parse(_ text: String) -> [ParsedPantryLine] {
        text.split(whereSeparator: { $0 == "\n" || $0 == ";" }).map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("#") }.prefix(maxItems + 1).map(parseLine)
    }

    static func parseLine(_ raw: String) -> ParsedPantryLine {
        let ns = raw as NSString
        let line = bullet.stringByReplacingMatches(in: raw, range: NSRange(location: 0, length: ns.length), withTemplate: "").trimmingCharacters(in: .whitespaces)
        if groups(onlyQuantity, line) != nil { return ParsedPantryLine(raw: raw, name: "", quantity: 1, unit: "pcs", problem: "No item name") }
        if let g = groups(start, line) { return build(raw, g[3], g[1], g[2]) }
        if let g = groups(end, line) { return build(raw, g[1], g[2], g[3]) }
        return build(raw, line, nil, "")
    }

    private static func build(_ raw: String, _ rawName: String, _ qtyText: String?, _ unitText: String) -> ParsedPantryLine {
        let name = tidy(rawName)
        let qty = qtyText.flatMap(number) ?? 1
        let unit = unitWords[unitText.lowercased()] ?? "pcs"
        let problem: String? =
            name.isEmpty || !name.contains(where: { $0.isLetter }) ? "No item name"
            : name.count > 60 ? "Name is too long"
            : qty <= 0 ? "Quantity must be more than zero"
            : qty > 100_000 ? "Quantity is too large" : nil
        return ParsedPantryLine(raw: raw, name: name, quantity: qty, unit: unit, problem: problem)
    }

    /// The same item written twice in the paste becomes one line with the quantities added.
    static func mergeDuplicates(_ lines: [ParsedPantryLine]) -> [ParsedPantryLine] {
        var order: [String] = [], out: [String: ParsedPantryLine] = [:]
        for l in lines {
            let k = l.problem != nil ? "bad:\(order.count):\(l.raw)" : "\(l.name.lowercased())|\(l.unit)"
            if let e = out[k], l.problem == nil { out[k] = ParsedPantryLine(raw: e.raw, name: e.name, quantity: e.quantity + l.quantity, unit: e.unit, problem: nil) }
            else { out[k] = l; order.append(k) }
        }
        return order.compactMap { out[$0] }
    }
}
