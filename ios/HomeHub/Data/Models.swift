import Foundation
import FirebaseFirestore

// Explicit mapping from Firestore dictionaries: a malformed document never crashes a screen.
extension Dictionary where Key == String, Value == Any {
    func str(_ k: String) -> String? { self[k] as? String }
    func int(_ k: String) -> Int64? { (self[k] as? NSNumber)?.int64Value }
    func dbl(_ k: String) -> Double? { (self[k] as? NSNumber)?.doubleValue }
    func bool(_ k: String) -> Bool { self[k] as? Bool ?? false }
    func date(_ k: String) -> Date? { (self[k] as? Timestamp)?.dateValue() }
    func map(_ k: String) -> [String: Any]? { self[k] as? [String: Any] }
}

enum Role: String, CaseIterable, Identifiable {
    case owner, admin, adult, child, staff
    var id: String { rawValue }
    var label: String { ["owner": "Owner", "admin": "Administrator", "adult": "Adult", "child": "Child", "staff": "Staff"][rawValue]! }
    var isAdultPlus: Bool { self == .owner || self == .admin || self == .adult }
    var isManager: Bool { self == .owner || self == .admin }
}

enum Priority: String, CaseIterable, Identifiable {
    case low, normal, high, urgent
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
}

struct Household: Equatable {
    let id: String, name: String, currency: String, timezone: String, locale: String
    let autonomyMode: String, paused: Bool
    var tz: TimeZone { TimeZone(identifier: timezone) ?? .current }
    init(id: String, _ d: [String: Any]) {
        self.id = id; name = d.str("name") ?? "Home"; currency = d.str("currency") ?? "INR"; timezone = d.str("timezone") ?? "UTC"; locale = d.str("locale") ?? "en"
        autonomyMode = d.map("autonomy")?.str("mode") ?? "routine"; paused = d.map("autonomy")?.bool("paused") ?? false
    }
}

struct Member: Identifiable, Equatable {
    let id: String, displayName: String, role: Role, financeAllowed: Bool
    init(id: String, _ d: [String: Any]) {
        self.id = id; displayName = d.str("displayName") ?? "Member"; role = Role(rawValue: d.str("role") ?? "adult") ?? .adult
        financeAllowed = d.map("permissions")?["finance"] as? Bool ?? true
    }
}

struct TaskItem: Identifiable, Equatable {
    let id: String, title: String, notes: String?, category: String?, priority: Priority, status: String
    let dueAt: Date?, assigneeUid: String?, recurring: Bool, version: Int64, pendingSync: Bool
    var isDone: Bool { status == "done" }
}

struct GroceryItem: Identifiable, Equatable {
    let id: String, listId: String, name: String, quantity: Double, unit: String, category: String
    let estimatedPriceMinor: Int64?, actualPriceMinor: Int64?, purchased: Bool, version: Int64, pendingSync: Bool
}

/// Generic record for the simpler modules.
struct Record: Identifiable {
    let id: String
    let data: [String: Any]
    func s(_ k: String) -> String? { data.str(k) }
    func i(_ k: String) -> Int64? { data.int(k) }
    func d(_ k: String) -> Double? { data.dbl(k) }
    func b(_ k: String) -> Bool { data.bool(k) }
    func t(_ k: String) -> Date? { data.date(k) }
}

struct Approval: Identifiable {
    let id: String, action: String, title: String, rationale: String, status: String, params: [String: Any]
    let estimatedCostMinor: Int64?, currency: String?, recipient: String?, relevantDate: String?, dataShared: String?, consequences: String?
    let manualCompletion: Bool, agentId: String?, expiresAt: Date?
    init(id: String, _ d: [String: Any]) {
        self.id = id; action = d.str("action") ?? ""; title = d.str("title") ?? ""; rationale = d.str("rationale") ?? ""; status = d.str("status") ?? "pending"
        params = d.map("params") ?? [:]; estimatedCostMinor = d.int("estimatedCostMinor"); currency = d.str("currency"); recipient = d.str("recipient")
        relevantDate = d.str("relevantDate"); dataShared = d.str("dataShared"); consequences = d.str("consequences"); manualCompletion = d.bool("manualCompletion")
        agentId = d.str("agentId"); expiresAt = d.date("expiresAt")
    }
    var actionLabel: String {
        switch action {
        case "agent_tool_call": return ((params["tool"] as? String) ?? "household change").replacingOccurrences(of: "_", with: " ").capitalized
        case "purchase_items": return "Buy items on a shopping list"
        case "book_service_provider": return "Book a service provider"
        case "send_external_message": return "Send a message outside HomeHub"
        case "share_information": return "Share household information"
        case "delete_document": return "Delete a document"
        case "record_expense": return "Record an expense"
        case "create_meal_plan": return "Save a meal plan"
        default: return action.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}

struct AgentMessage: Identifiable {
    let id: String, role: String, content: String, state: String?, createdAt: Date?
    init(id: String, _ d: [String: Any]) { self.id = id; role = d.str("role") ?? "assistant"; content = d.str("content") ?? ""; state = d.str("state"); createdAt = d.date("createdAt") }
}
