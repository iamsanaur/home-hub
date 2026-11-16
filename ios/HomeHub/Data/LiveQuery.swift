import Foundation
import Observation
import FirebaseFirestore

enum Loadable<T> {
    case loading, ready(T), failed(String)
    var value: T? { if case .ready(let v) = self { return v }; return nil }
}

/// A live Firestore query for SwiftUI. Listener is removed when the object is released.
@Observable
final class LiveQuery<T> {
    private(set) var state: Loadable<[T]> = .loading
    @ObservationIgnored private var reg: ListenerRegistration?

    init(_ query: Query, map: @escaping (String, [String: Any]) -> T?) {
        reg = query.addSnapshotListener { [weak self] snap, err in
            guard let self else { return }
            if let err {
                let msg = (err as NSError).code == FirestoreErrorCode.permissionDenied.rawValue ? "You don't have access to this." : "Couldn't load this right now."
                self.state = .failed(msg); return
            }
            self.state = .ready(snap?.documents.compactMap { map($0.documentID, $0.data()) } ?? [])
        }
    }
    deinit { reg?.remove() }
    var items: [T] { state.value ?? [] }
}

@Observable
final class LiveDoc {
    private(set) var data: [String: Any]?
    private(set) var loaded = false
    @ObservationIgnored private var reg: ListenerRegistration?
    init(_ ref: DocumentReference) {
        reg = ref.addSnapshotListener { [weak self] s, _ in self?.data = s?.exists == true ? s?.data() : nil; self?.loaded = true }
    }
    deinit { reg?.remove() }
}

/// Writes that satisfy firestore.rules (creation metadata, version bump on update).
enum HouseholdWrites {
    static var db: Firestore { Firestore.firestore() }
    static func col(_ hid: String, _ c: String) -> CollectionReference { db.collection("households/\(hid)/\(c)") }

    @discardableResult
    static func create(_ hid: String, _ c: String, uid: String, _ fields: [String: Any], id: String? = nil) async throws -> String {
        let ref = id.map { col(hid, c).document($0) } ?? col(hid, c).document()
        var data = fields
        data["householdId"] = hid; data["createdBy"] = uid; data["createdAt"] = FieldValue.serverTimestamp()
        data["updatedBy"] = uid; data["updatedAt"] = FieldValue.serverTimestamp(); data["version"] = 1; data["source"] = "user"
        try await ref.setData(data)
        return ref.documentID
    }

    static func update(_ hid: String, _ c: String, id: String, uid: String, _ fields: [String: Any]) async throws {
        let ref = col(hid, c).document(id)
        _ = try await db.runTransaction { tx, errPtr in
            do {
                let snap = try tx.getDocument(ref)
                let v = (snap.data()?["version"] as? NSNumber)?.int64Value ?? 0
                var data = fields
                data["version"] = v + 1; data["updatedBy"] = uid; data["updatedAt"] = FieldValue.serverTimestamp()
                tx.updateData(data, forDocument: ref)
            } catch { errPtr?.pointee = error as NSError }
            return nil
        }
    }

    static func delete(_ hid: String, _ c: String, id: String) async throws { try await col(hid, c).document(id).delete() }
}
