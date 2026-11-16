import Foundation
import SwiftData
import FirebaseFirestore
import BackgroundTasks

// MARK: Local store (SwiftData) — source of truth for tasks, shopping items and notes.

@Model final class LocalTask {
    @Attribute(.unique) var id: String
    var householdId: String
    var title: String
    var notes: String?
    var category: String?
    var priority: String
    var status: String
    var dueAt: Date?
    var assigneeUid: String?
    var recurring: Bool
    var version: Int64
    var pendingSync: Bool
    init(id: String, householdId: String, title: String, notes: String?, category: String?, priority: String, status: String, dueAt: Date?, assigneeUid: String?, recurring: Bool, version: Int64, pendingSync: Bool) {
        self.id = id; self.householdId = householdId; self.title = title; self.notes = notes; self.category = category; self.priority = priority
        self.status = status; self.dueAt = dueAt; self.assigneeUid = assigneeUid; self.recurring = recurring; self.version = version; self.pendingSync = pendingSync
    }
    var model: TaskItem { TaskItem(id: id, title: title, notes: notes, category: category, priority: Priority(rawValue: priority) ?? .normal, status: status, dueAt: dueAt, assigneeUid: assigneeUid, recurring: recurring, version: version, pendingSync: pendingSync) }
}

@Model final class LocalGrocery {
    @Attribute(.unique) var id: String
    var householdId: String
    var listId: String
    var name: String
    var quantity: Double
    var unit: String
    var category: String
    var estimatedPriceMinor: Int64?
    var actualPriceMinor: Int64?
    var purchased: Bool
    var version: Int64
    var pendingSync: Bool
    init(id: String, householdId: String, listId: String, name: String, quantity: Double, unit: String, category: String, estimatedPriceMinor: Int64?, actualPriceMinor: Int64?, purchased: Bool, version: Int64, pendingSync: Bool) {
        self.id = id; self.householdId = householdId; self.listId = listId; self.name = name; self.quantity = quantity; self.unit = unit; self.category = category
        self.estimatedPriceMinor = estimatedPriceMinor; self.actualPriceMinor = actualPriceMinor; self.purchased = purchased; self.version = version; self.pendingSync = pendingSync
    }
    var model: GroceryItem { GroceryItem(id: id, listId: listId, name: name, quantity: quantity, unit: unit, category: category, estimatedPriceMinor: estimatedPriceMinor, actualPriceMinor: actualPriceMinor, purchased: purchased, version: version, pendingSync: pendingSync) }
}

@Model final class LocalNote {
    @Attribute(.unique) var id: String
    var householdId: String
    var title: String
    var body: String
    var visibility: String
    var createdBy: String
    var updatedAt: Date
    var version: Int64
    var pendingSync: Bool
    init(id: String, householdId: String, title: String, body: String, visibility: String, createdBy: String, updatedAt: Date, version: Int64, pendingSync: Bool) {
        self.id = id; self.householdId = householdId; self.title = title; self.body = body; self.visibility = visibility; self.createdBy = createdBy
        self.updatedAt = updatedAt; self.version = version; self.pendingSync = pendingSync
    }
}

@Model final class OutboxOp {
    @Attribute(.unique) var opId: String
    var householdId: String
    var collection: String
    var docId: String
    var kind: String
    var fieldsJSON: Data
    var baseVersion: Int64
    var createdAt: Date
    var attempts: Int
    var state: String
    init(opId: String = UUID().uuidString, householdId: String, collection: String, docId: String, kind: String, fieldsJSON: Data, baseVersion: Int64) {
        self.opId = opId; self.householdId = householdId; self.collection = collection; self.docId = docId; self.kind = kind
        self.fieldsJSON = fieldsJSON; self.baseVersion = baseVersion; self.createdAt = .now; self.attempts = 0; self.state = "pending"
    }
}

@Model final class SyncConflict {
    @Attribute(.unique) var opId: String
    var householdId: String
    var collection: String
    var docId: String
    var localSummary: String
    var remoteSummary: String
    var remoteVersion: Int64
    var createdAt: Date
    init(opId: String, householdId: String, collection: String, docId: String, localSummary: String, remoteSummary: String, remoteVersion: Int64) {
        self.opId = opId; self.householdId = householdId; self.collection = collection; self.docId = docId
        self.localSummary = localSummary; self.remoteSummary = remoteSummary; self.remoteVersion = remoteVersion; self.createdAt = .now
    }
}

// MARK: Conflict policy (identical to Android ConflictPolicy.kt)

enum SyncDecision: Equatable { case apply, alreadyApplied, conflict(String) }

enum ConflictPolicy {
    static let taskCompletion: Set<String> = ["status", "completedAt", "completedBy"]
    static let groceryPurchase: Set<String> = ["purchased", "purchasedAt", "purchasedBy", "actualPriceMinor"]

    static func decideUpdate(collection: String, baseVersion: Int64, remoteExists: Bool, remoteVersion: Int64, changed: Set<String>, remote: [String: Any]) -> SyncDecision {
        if !remoteExists { return .conflict("Deleted on another device") }
        if remoteVersion == baseVersion { return .apply }
        switch collection {
        case "tasks" where !changed.isEmpty && changed.isSubset(of: taskCompletion):
            let s = remote["status"] as? String
            return s == "done" ? .alreadyApplied : (s == "cancelled" ? .conflict("Cancelled on another device") : .apply)
        case "groceryItems" where !changed.isEmpty && changed.isSubset(of: groceryPurchase):
            return (remote["purchased"] as? Bool ?? false) ? .alreadyApplied : .apply
        default:
            return .conflict("Changed on another device")
        }
    }

    static func decideCreate(remoteExists: Bool, remoteClientOpId: String?, opId: String) -> SyncDecision {
        if !remoteExists { return .apply }
        return remoteClientOpId == opId ? .alreadyApplied : .conflict("A record with this ID already exists")
    }
}

// MARK: Field codec (keeps server-time markers and timestamps through JSON)

enum FieldCodec {
    static let serverTime = "__serverTime__"
    static func encode(_ fields: [String: Any]) -> Data {
        let mapped = fields.mapValues { v -> Any in
            if let d = v as? Date { return ["__ts": d.timeIntervalSince1970 * 1000] }
            if v is NSNull { return NSNull() }
            return v
        }
        return (try? JSONSerialization.data(withJSONObject: mapped)) ?? Data("{}".utf8)
    }
    static func decode(_ data: Data) -> [String: Any] {
        let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        return raw.mapValues { v -> Any in
            if let s = v as? String, s == serverTime { return FieldValue.serverTimestamp() }
            if let m = v as? [String: Any], let ms = m["__ts"] as? Double { return Timestamp(date: Date(timeIntervalSince1970: ms / 1000)) }
            return v
        }
    }
}

// MARK: Offline store

@MainActor
final class OfflineStore {
    let container: ModelContainer
    var context: ModelContext { container.mainContext }
    private var regs: [ListenerRegistration] = []
    private var listRegs: [String: ListenerRegistration] = [:]
    private var db: Firestore { Firestore.firestore() }

    init(inMemory: Bool = false) {
        let config = ModelConfiguration(isStoredInMemoryOnly: inMemory)
        container = try! ModelContainer(for: LocalTask.self, LocalGrocery.self, LocalNote.self, OutboxOp.self, SyncConflict.self, configurations: config)
    }

    private func pendingOps(for docId: String) -> Int {
        (try? context.fetchCount(FetchDescriptor<OutboxOp>(predicate: #Predicate { $0.docId == docId && $0.state != "done" }))) ?? 0
    }

    func attach(hid: String, uid: String, role: Role) {
        detach()
        let q: Query = role.isAdultPlus ? db.collection("households/\(hid)/tasks") : db.collection("households/\(hid)/tasks").whereField("assigneeUid", isEqualTo: uid)
        regs.append(q.addSnapshotListener { [weak self] snap, _ in
            guard let self, let snap, !snap.metadata.hasPendingWrites else { return }
            for d in snap.documents where self.pendingOps(for: d.documentID) == 0 {
                let x = d.data()
                self.upsertTask(LocalTask(id: d.documentID, householdId: hid, title: x.str("title") ?? "", notes: x.str("notes"), category: x.str("category"),
                                          priority: x.str("priority") ?? "normal", status: x.str("status") ?? "open", dueAt: x.date("dueAt"), assigneeUid: x.str("assigneeUid"),
                                          recurring: x["recurrence"] != nil && !(x["recurrence"] is NSNull), version: x.int("version") ?? 1, pendingSync: false))
            }
            if !snap.metadata.isFromCache {
                let seen = Set(snap.documents.map(\.documentID))
                let local = (try? self.context.fetch(FetchDescriptor<LocalTask>(predicate: #Predicate { $0.householdId == hid && !$0.pendingSync }))) ?? []
                local.filter { !seen.contains($0.id) }.forEach { self.context.delete($0) }
            }
            try? self.context.save()
        })
        if role != .staff {
            let notes = db.collection("households/\(hid)/notes")
            for nq in [notes.whereField("visibility", isEqualTo: "household"), notes.whereField("createdBy", isEqualTo: uid).whereField("visibility", isEqualTo: "private")] {
                regs.append(nq.addSnapshotListener { [weak self] snap, _ in
                    guard let self, let snap else { return }
                    for d in snap.documents where self.pendingOps(for: d.documentID) == 0 {
                        let x = d.data()
                        self.upsert(LocalNote(id: d.documentID, householdId: hid, title: x.str("title") ?? "", body: x.str("body") ?? "", visibility: x.str("visibility") ?? "household",
                                              createdBy: x.str("createdBy") ?? "", updatedAt: x.date("updatedAt") ?? .now, version: x.int("version") ?? 1, pendingSync: false))
                    }
                    try? self.context.save()
                })
            }
        }
    }

    func attachList(hid: String, listId: String) {
        guard listRegs[listId] == nil else { return }
        listRegs[listId] = db.collection("households/\(hid)/groceryItems").whereField("listId", isEqualTo: listId).addSnapshotListener { [weak self] snap, _ in
            guard let self, let snap else { return }
            for d in snap.documents where self.pendingOps(for: d.documentID) == 0 {
                let x = d.data()
                self.upsert(LocalGrocery(id: d.documentID, householdId: hid, listId: listId, name: x.str("name") ?? "", quantity: x.dbl("quantity") ?? 1, unit: x.str("unit") ?? "pcs",
                                         category: x.str("category") ?? "Other", estimatedPriceMinor: x.int("estimatedPriceMinor"), actualPriceMinor: x.int("actualPriceMinor"),
                                         purchased: x.bool("purchased"), version: x.int("version") ?? 1, pendingSync: false))
            }
            try? self.context.save()
        }
    }

    func detach() { regs.forEach { $0.remove() }; regs = []; listRegs.values.forEach { $0.remove() }; listRegs = [:] }

    // Upserts keyed by id.
    private func upsertTask(_ t: LocalTask) {
        let id = t.id
        if let cur = try? context.fetch(FetchDescriptor<LocalTask>(predicate: #Predicate { $0.id == id })).first {
            cur.title = t.title; cur.notes = t.notes; cur.category = t.category; cur.priority = t.priority; cur.status = t.status; cur.dueAt = t.dueAt
            cur.assigneeUid = t.assigneeUid; cur.recurring = t.recurring; cur.version = t.version; cur.pendingSync = t.pendingSync
        } else { context.insert(t) }
    }
    private func upsert(_ g: LocalGrocery) {
        let id = g.id
        if let cur = try? context.fetch(FetchDescriptor<LocalGrocery>(predicate: #Predicate { $0.id == id })).first {
            cur.name = g.name; cur.quantity = g.quantity; cur.unit = g.unit; cur.category = g.category; cur.estimatedPriceMinor = g.estimatedPriceMinor
            cur.actualPriceMinor = g.actualPriceMinor; cur.purchased = g.purchased; cur.version = g.version; cur.pendingSync = g.pendingSync
        } else { context.insert(g) }
    }
    private func upsert(_ n: LocalNote) {
        let id = n.id
        if let cur = try? context.fetch(FetchDescriptor<LocalNote>(predicate: #Predicate { $0.id == id })).first {
            cur.title = n.title; cur.body = n.body; cur.version = n.version; cur.pendingSync = n.pendingSync; cur.updatedAt = n.updatedAt
        } else { context.insert(n) }
    }

    private func enqueue(_ hid: String, _ c: String, _ docId: String, _ kind: String, _ fields: [String: Any], base: Int64) {
        context.insert(OutboxOp(householdId: hid, collection: c, docId: docId, kind: kind, fieldsJSON: FieldCodec.encode(fields), baseVersion: base))
        try? context.save()
        SyncScheduler.kick()
    }

    // MARK: writes — local first, then outbox; local version = what the server will hold after queued ops apply.

    func createTask(hid: String, title: String, notes: String?, priority: Priority, dueAt: Date?, assigneeUid: String?, category: String?, repeatFreq: String?) {
        let id = db.collection("households/\(hid)/tasks").document().documentID
        var f: [String: Any] = ["title": title, "priority": priority.rawValue, "status": "open", "checklist": [] as [Any], "completedAt": NSNull(), "completedBy": NSNull()]
        f["notes"] = notes ?? NSNull(); f["category"] = category ?? NSNull(); f["assigneeUid"] = assigneeUid ?? NSNull()
        f["dueAt"] = dueAt ?? NSNull()
        f["recurrence"] = repeatFreq.map { ["freq": $0] } ?? NSNull()
        f["seriesStartAt"] = (repeatFreq != nil ? dueAt : nil) ?? NSNull()
        context.insert(LocalTask(id: id, householdId: hid, title: title, notes: notes, category: category, priority: priority.rawValue, status: "open", dueAt: dueAt, assigneeUid: assigneeUid, recurring: repeatFreq != nil, version: 1, pendingSync: true))
        enqueue(hid, "tasks", id, "create", f, base: 0)
    }

    func setTaskDone(hid: String, uid: String, id: String, done: Bool) {
        guard let t = try? context.fetch(FetchDescriptor<LocalTask>(predicate: #Predicate { $0.id == id })).first else { return }
        let base = t.version
        t.status = done ? "done" : "open"; t.pendingSync = true; t.version = base + 1
        let f: [String: Any] = done ? ["status": "done", "completedAt": FieldCodec.serverTime, "completedBy": uid] : ["status": "open", "completedAt": NSNull(), "completedBy": NSNull()]
        enqueue(hid, "tasks", id, "update", f, base: base)
    }

    func addGrocery(hid: String, listId: String, name: String, quantity: Double, unit: String, category: String, estimatedPriceMinor: Int64?) {
        let id = db.collection("households/\(hid)/groceryItems").document().documentID
        let f: [String: Any] = ["listId": listId, "name": name, "nameKey": name.lowercased(), "quantity": quantity, "unit": unit, "category": category,
                                "estimatedPriceMinor": estimatedPriceMinor.map { NSNumber(value: $0) } ?? NSNull(), "actualPriceMinor": NSNull(), "purchased": false,
                                "purchasedAt": NSNull(), "purchasedBy": NSNull(), "preferredBrand": NSNull(), "preferredStore": NSNull()]
        context.insert(LocalGrocery(id: id, householdId: hid, listId: listId, name: name, quantity: quantity, unit: unit, category: category, estimatedPriceMinor: estimatedPriceMinor, actualPriceMinor: nil, purchased: false, version: 1, pendingSync: true))
        enqueue(hid, "groceryItems", id, "create", f, base: 0)
    }

    func setPurchased(hid: String, uid: String, id: String, purchased: Bool) {
        guard let g = try? context.fetch(FetchDescriptor<LocalGrocery>(predicate: #Predicate { $0.id == id })).first else { return }
        let base = g.version
        g.purchased = purchased; g.pendingSync = true; g.version = base + 1
        enqueue(hid, "groceryItems", id, "update", ["purchased": purchased, "purchasedAt": purchased ? FieldCodec.serverTime : NSNull(), "purchasedBy": purchased ? uid : NSNull()], base: base)
    }

    func saveNote(hid: String, uid: String, id: String?, title: String, body: String, visibility: String) {
        if let id, let n = try? context.fetch(FetchDescriptor<LocalNote>(predicate: #Predicate { $0.id == id })).first {
            let base = n.version
            n.title = title; n.body = body; n.updatedAt = .now; n.pendingSync = true; n.version = base + 1
            enqueue(hid, "notes", id, "update", ["title": title, "body": body], base: base)
        } else {
            let nid = db.collection("households/\(hid)/notes").document().documentID
            context.insert(LocalNote(id: nid, householdId: hid, title: title, body: body, visibility: visibility, createdBy: uid, updatedAt: .now, version: 1, pendingSync: true))
            enqueue(hid, "notes", nid, "create", ["title": title, "body": body, "visibility": visibility, "category": NSNull()], base: 0)
        }
    }

    func pendingCount(hid: String) -> Int { (try? context.fetchCount(FetchDescriptor<OutboxOp>(predicate: #Predicate { $0.householdId == hid && $0.state == "pending" }))) ?? 0 }
}

// MARK: Sync engine

@MainActor
final class SyncEngine {
    let store: OfflineStore
    init(store: OfflineStore) { self.store = store }

    /// Drains the outbox; returns false on a transient failure (retry later with backoff).
    func drain(uid: String) async -> Bool {
        let ops = (try? store.context.fetch(FetchDescriptor<OutboxOp>(predicate: #Predicate { $0.state == "pending" }, sortBy: [SortDescriptor(\.createdAt)]))) ?? []
        let db = Firestore.firestore()
        for op in ops {
            let ref = db.document("households/\(op.householdId)/\(op.collection)/\(op.docId)")
            let fields = FieldCodec.decode(op.fieldsJSON)
            let opId = op.opId, kind = op.kind, collection = op.collection, base = op.baseVersion, hid = op.householdId
            do {
                let outcome = try await db.runTransaction { tx, errPtr -> Any? in
                    do {
                        let snap = try tx.getDocument(ref)
                        let remote = snap.data() ?? [:]
                        let rv = remote.int("version") ?? 0
                        switch kind {
                        case "create":
                            switch ConflictPolicy.decideCreate(remoteExists: snap.exists, remoteClientOpId: remote.str("clientOpId"), opId: opId) {
                            case .apply:
                                var d = fields
                                d["householdId"] = hid; d["createdBy"] = uid; d["createdAt"] = FieldValue.serverTimestamp(); d["updatedBy"] = uid
                                d["updatedAt"] = FieldValue.serverTimestamp(); d["version"] = 1; d["source"] = "user"; d["clientOpId"] = opId
                                tx.setData(d, forDocument: ref); return ["done": 1]
                            case .alreadyApplied: return ["done": rv]
                            case .conflict(let r): return ["conflict": r, "rv": rv]
                            }
                        case "update":
                            switch ConflictPolicy.decideUpdate(collection: collection, baseVersion: base, remoteExists: snap.exists, remoteVersion: rv, changed: Set(fields.keys), remote: remote) {
                            case .apply:
                                var d = fields; d["version"] = rv + 1; d["updatedBy"] = uid; d["updatedAt"] = FieldValue.serverTimestamp()
                                tx.updateData(d, forDocument: ref); return ["done": rv + 1]
                            case .alreadyApplied: return ["done": rv]
                            case .conflict(let r): return ["conflict": r, "rv": rv]
                            }
                        default:
                            if snap.exists { tx.deleteDocument(ref) }
                            return ["done": rv]
                        }
                    } catch { errPtr?.pointee = error as NSError; return nil }
                } as? [String: Any]
                if let reason = outcome?["conflict"] as? String {
                    op.state = "conflict"
                    store.context.insert(SyncConflict(opId: op.opId, householdId: hid, collection: collection, docId: op.docId,
                                                      localSummary: (fields["title"] ?? fields["name"] ?? fields["status"]).map { "\($0)" } ?? "your change",
                                                      remoteSummary: reason, remoteVersion: (outcome?["rv"] as? NSNumber)?.int64Value ?? 0))
                } else if let v = (outcome?["done"] as? NSNumber)?.int64Value {
                    let docId = op.docId
                    store.context.delete(op)
                    if let t = try? store.context.fetch(FetchDescriptor<LocalTask>(predicate: #Predicate { $0.id == docId })).first { t.version = v; t.pendingSync = false }
                    if let g = try? store.context.fetch(FetchDescriptor<LocalGrocery>(predicate: #Predicate { $0.id == docId })).first { g.version = v; g.pendingSync = false }
                    if let n = try? store.context.fetch(FetchDescriptor<LocalNote>(predicate: #Predicate { $0.id == docId })).first { n.version = v; n.pendingSync = false }
                }
                try? store.context.save()
            } catch {
                let ns = error as NSError
                if ns.domain == FirestoreErrorDomain && ns.code == FirestoreErrorCode.permissionDenied.rawValue {
                    op.state = "failed"
                    store.context.insert(SyncConflict(opId: op.opId, householdId: hid, collection: collection, docId: op.docId, localSummary: "your change", remoteSummary: "The household rejected this change (permissions).", remoteVersion: -1))
                    try? store.context.save()
                    continue
                }
                op.attempts += 1; try? store.context.save()
                return false
            }
        }
        return true
    }
}

/// Runs the sync engine when the app is active and via BGTaskScheduler (network required), with backoff.
enum SyncScheduler {
    static let taskId = "com.e404.homehub.sync"
    @MainActor static var engine: SyncEngine?
    @MainActor static var uid: String?
    @MainActor private static var attempt = 0

    @MainActor static func kick() {
        guard let engine, let uid else { return }
        Task { @MainActor in
            let ok = await engine.drain(uid: uid)
            if ok { attempt = 0 } else {
                attempt += 1
                let delay = min(15.0 * pow(2, Double(min(attempt, 12))), 6 * 3600)
                try? await Task.sleep(for: .seconds(delay))
                kick()
            }
        }
    }

    static func scheduleBackground() {
        let req = BGProcessingTaskRequest(identifier: taskId)
        req.requiresNetworkConnectivity = true
        req.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(req)
    }
}
