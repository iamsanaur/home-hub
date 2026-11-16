import Foundation

// MARK: Skills — the exact SKILL.md files the server Hermes uses; progressive loading.

struct Skill { let name: String, description: String, body: String }

struct SkillRegistry {
    let skills: [String: Skill]
    var names: [String] { skills.keys.sorted() }
    func index() -> String { skills.values.sorted { $0.name < $1.name }.map { "- \($0.name): \($0.description)" }.joined(separator: "\n") }
    func view(_ name: String) -> String? { skills[name]?.body }

    static func parse(_ text: String) -> Skill? {
        guard text.hasPrefix("---"), let end = text.range(of: "\n---", range: text.index(text.startIndex, offsetBy: 3)..<text.endIndex) else { return nil }
        let front = String(text[text.index(text.startIndex, offsetBy: 3)..<end.lowerBound])
        func field(_ k: String) -> String? {
            front.split(separator: "\n").first { $0.hasPrefix("\(k):") }.map { String($0.dropFirst(k.count + 1)).trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\"")) }
        }
        guard let name = field("name") else { return nil }
        return Skill(name: name, description: field("description") ?? "", body: String(text[end.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines))
    }
    static func from(texts: [String]) -> SkillRegistry {
        SkillRegistry(skills: Dictionary(texts.compactMap(parse).map { ($0.name, $0) }, uniquingKeysWith: { a, _ in a }))
    }
    static func bundled() -> SkillRegistry {
        guard let root = Bundle.main.url(forResource: "skills", withExtension: nil),
              let dirs = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return SkillRegistry(skills: [:]) }
        return from(texts: dirs.compactMap { try? String(contentsOf: $0.appendingPathComponent("SKILL.md"), encoding: .utf8) })
    }
}

// MARK: Model and tool contracts

struct ToolCall: Equatable { let id: String, name: String, argumentsJSON: String }

struct ChatMessage {
    let role: String
    let content: String?
    var toolCalls: [ToolCall] = []
    var toolCallId: String? = nil
}

struct ToolSpec { let name: String, description: String, parameters: [String: Any], readOnly: Bool }

enum ModelEvent: Equatable { case text(String), toolCalls([ToolCall]), usage(input: Int, output: Int) }

struct ModelUnavailable: LocalizedError { let message: String; var code = "agent_unavailable"; var errorDescription: String? { message } }

protocol ModelClient { func complete(_ messages: [ChatMessage], tools: [ToolSpec], tier: String) -> AsyncThrowingStream<ModelEvent, Error> }

protocol ToolHost {
    func listTools() async throws -> [ToolSpec]
    func call(_ name: String, argumentsJSON: String) async -> String
}

// MARK: Battery policy (same rules as Android Power.kt)

enum PowerMode: String { case normal, saver, critical }

struct PowerSnapshot {
    let levelPercent: Int?
    let charging: Bool
    let powerSaver: Bool
    /// 0…6 thermal scale (iOS .nominal=0, .fair=1, .serious=4, .critical=6)
    let thermal: Int
    let unmetered: Bool
    var mode: PowerMode {
        if !charging && (levelPercent ?? 100) <= 5 { return .critical }
        if thermal >= 4 { return .critical }
        if !charging && (powerSaver || (levelPercent ?? 100) <= 20 || thermal >= 2) { return .saver }
        return .normal
    }
    var allowsBackgroundAgent: Bool { charging && thermal < 2 && unmetered }
    var allowsForegroundAgent: Bool { mode != .critical }
}

protocol PowerSource { func snapshot() -> PowerSnapshot }

// MARK: Offline intents — zero model calls

enum OfflineIntent: Equatable { case addToList(item: String, quantity: Double, unit: String), completeTask(String), dueToday, addTask(String) }

enum OfflineIntents {
    static func parse(_ input: String) -> OfflineIntent? {
        let s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        func match(_ p: String) -> [String]? {
            guard let re = try? NSRegularExpression(pattern: p, options: [.caseInsensitive]), let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
            return (0..<m.numberOfRanges).map { i in Range(m.range(at: i), in: s).map { String(s[$0]) } ?? "" }
        }
        if match(#"^(?:what(?:'s| is)\s+(?:due|on)\s+today|today'?s tasks|what do i have today)\??$"#) != nil { return .dueToday }
        if let m = match(#"^(?:remind me to|add (?:a )?task(?: to)?:?)\s+(.+?)\.?$"#) { return .addTask(m[1].prefix(1).uppercased() + m[1].dropFirst()) }
        if let m = match(#"^(?:mark|set)\s+(.+?)\s+(?:as\s+)?(?:done|complete|completed)\.?$"#) { return .completeTask(m[1].replacingOccurrences(of: "the ", with: "", options: .anchored)) }
        if let m = match(#"^(?:please\s+)?(?:add|buy|get)\s+(?:(\d+(?:\.\d+)?)\s*(kg|g|l|ml|pcs|packs?|dozen|bunch(?:es)?)?\s+(?:of\s+)?)?(.+?)(?:\s+(?:to|on)\s+(?:the\s+|my\s+)?(?:shopping|grocery)?\s*list)?\.?$"#) {
            var item = m[3].trimmingCharacters(in: .whitespaces)
            if item.lowercased().hasPrefix("some ") { item = String(item.dropFirst(5)) }
            if item.isEmpty || item.split(separator: " ").count > 4 || item.contains(" and ") || item.contains(",") { return nil }
            var unit = m[2].lowercased(); if unit.isEmpty { unit = "pcs" }
            if unit.hasPrefix("pack") { unit = "pack" }; if unit.hasPrefix("bunch") { unit = "bunch" }
            return .addToList(item: item.prefix(1).uppercased() + item.dropFirst(), quantity: Double(m[1]) ?? 1, unit: unit)
        }
        return nil
    }
}
