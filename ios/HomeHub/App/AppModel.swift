import SwiftUI
import Observation
import FirebaseAuth
import FirebaseFirestore

struct HouseholdContext {
    let hid: String, uid: String, role: Role, household: Household, members: [Member]
    var tz: TimeZone { household.tz }
    var currency: String { household.currency }
    var me: Member? { members.first { $0.id == uid } }
    var canFinance: Bool { role.isAdultPlus && (me?.financeAllowed ?? true) }
    func name(_ uid: String?) -> String? { uid.flatMap { u in members.first { $0.id == u }?.displayName.components(separatedBy: " ").first } }
}

enum Gate { case loading, signedOut, onboarding(uid: String, step: String?, hid: String?), ready(HouseholdContext) }

/// Session + active household state. Listeners are attached/detached as the gate changes.
@MainActor @Observable
final class AppModel {
    var gate: Gate = .loading
    var memberships: [String: String] = [:]
    var deepLink: URL?
    let offline = OfflineStore()
    @ObservationIgnored private var authHandle: AuthStateDidChangeListenerHandle?
    @ObservationIgnored private var userReg: ListenerRegistration?
    @ObservationIgnored private var hhReg: ListenerRegistration?
    @ObservationIgnored private var memReg: ListenerRegistration?
    @ObservationIgnored private var household: Household?
    @ObservationIgnored private var members: [Member] = []
    @ObservationIgnored private var attachedKey: String?

    init() {
        authHandle = Auth.auth().addStateDidChangeListener { [weak self] _, user in self?.onUser(user) }
    }

    private func onUser(_ user: User?) {
        userReg?.remove(); hhReg?.remove(); memReg?.remove()
        guard let user else { gate = .signedOut; offline.detach(); attachedKey = nil; return }
        Task { await validateSession(user) }
        userReg = Firestore.firestore().document("users/\(user.uid)").addSnapshotListener { [weak self] snap, _ in
            guard let self else { return }
            let d = snap?.data() ?? [:]
            self.memberships = (d["memberships"] as? [String: [String: Any]] ?? [:]).mapValues { $0["name"] as? String ?? "Household" }
            let ob = d.map("onboarding")
            let hid = d.str("activeHouseholdId")
            let completed = ob?["completed"] as? Bool ?? (hid != nil)
            if let hid, completed { self.watch(hid: hid, uid: user.uid) }
            else { self.hhReg?.remove(); self.memReg?.remove(); self.gate = .onboarding(uid: user.uid, step: ob?.str("step"), hid: hid) }
        }
    }

    private func watch(hid: String, uid: String) {
        if case .ready(let c) = gate, c.hid == hid { return }
        hhReg?.remove(); memReg?.remove()
        hhReg = Firestore.firestore().document("households/\(hid)").addSnapshotListener { [weak self] s, _ in
            guard let self, let d = s?.data() else { return }
            self.household = Household(id: hid, d); self.publish(hid: hid, uid: uid)
        }
        memReg = Firestore.firestore().collection("households/\(hid)/members").whereField("status", isEqualTo: "active").addSnapshotListener { [weak self] s, _ in
            guard let self else { return }
            self.members = (s?.documents ?? []).map { Member(id: $0.documentID, $0.data()) }.sorted { Role.allCases.firstIndex(of: $0.role)! < Role.allCases.firstIndex(of: $1.role)! }
            self.publish(hid: hid, uid: uid)
        }
    }

    private func publish(hid: String, uid: String) {
        guard let household, let me = members.first(where: { $0.id == uid }) else { return }
        let ctx = HouseholdContext(hid: hid, uid: uid, role: me.role, household: household, members: members)
        gate = .ready(ctx)
        let key = "\(hid):\(uid):\(me.role.rawValue)"
        if key != attachedKey {
            attachedKey = key
            offline.attach(hid: hid, uid: uid, role: me.role)
            SyncScheduler.engine = SyncEngine(store: offline); SyncScheduler.uid = uid; SyncScheduler.kick()
            if me.role.isAdultPlus { HermesBackgroundJobs.householdId = hid; HermesBackgroundJobs.schedule() }
        }
    }

    func switchHousehold(_ hid: String) {
        guard let uid = Auth.auth().currentUser?.uid else { return }
        Firestore.firestore().document("users/\(uid)").setData(["activeHouseholdId": hid], merge: true)
    }

    /// A persisted session can outlive its account (deleted, disabled, tokens revoked). Firebase only
    /// notices on the next token refresh, so check once per sign-in and return to the sign-in screen
    /// instead of failing every gateway call. Network failures keep the session (offline use).
    private func validateSession(_ user: User) async {
        do { _ = try await user.getIDTokenResult(forcingRefresh: true) }
        catch { if Self.isDeadSession(error as NSError) { try? Auth.auth().signOut() } }
    }

    static func isDeadSession(_ e: NSError) -> Bool {
        if let code = AuthErrorCode(rawValue: e.code), deadCodes.contains(code) { return true }
        // Some token-service replies (e.g. INVALID_REFRESH_TOKEN) surface as a generic internal error;
        // the server's reason is kept in the deserialized response.
        var next: NSError? = e
        while let cur = next {
            if let m = (cur.userInfo["FIRAuthErrorUserInfoDeserializedResponseKey"] as? [String: Any])?["message"] as? String {
                return deadMessages.contains { m.hasPrefix($0) }
            }
            next = cur.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        return false
    }
    private static let deadCodes: Set<AuthErrorCode> = [.userNotFound, .userDisabled, .userTokenExpired, .invalidUserToken, .userMismatch]
    private static let deadMessages = ["INVALID_REFRESH_TOKEN", "TOKEN_EXPIRED", "USER_NOT_FOUND", "USER_DISABLED", "INVALID_ID_TOKEN"]

    func signOut() {
        Task { try? await Gateway.shared.call("DELETE", "/v1/me/devices/\(DeviceId.value)") }
        try? Auth.auth().signOut()
    }
}
