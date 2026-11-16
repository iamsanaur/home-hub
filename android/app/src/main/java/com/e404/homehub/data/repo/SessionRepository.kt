package com.e404.homehub.data.repo

import com.e404.homehub.data.local.LocalDao
import com.e404.homehub.data.model.Household
import com.e404.homehub.data.model.Member
import com.e404.homehub.data.model.Role
import com.e404.homehub.data.remote.GatewayClient
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import com.google.firebase.auth.FirebaseAuthInvalidUserException
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.UserProfileChangeRequest
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

data class UserProfile(
    val uid: String,
    val displayName: String,
    val activeHouseholdId: String?,
    val memberships: Map<String, Pair<String, Role>>,
    val onboardingStep: String?,
    val onboardingCompleted: Boolean,
)

/** Authentication, the user profile and the active household. */
private val DEAD_SESSION = setOf("ERROR_USER_NOT_FOUND", "ERROR_USER_DISABLED", "ERROR_USER_TOKEN_EXPIRED", "ERROR_INVALID_USER_TOKEN", "ERROR_INVALID_REFRESH_TOKEN")

class SessionRepository(private val auth: FirebaseAuth, private val db: FirebaseFirestore, private val gateway: GatewayClient, private val dao: LocalDao) {

    val currentUid: String? get() = auth.currentUser?.uid

    fun authState(): Flow<FirebaseUser?> = callbackFlow {
        val l = FirebaseAuth.AuthStateListener { trySend(it.currentUser) }
        auth.addAuthStateListener(l)
        awaitClose { auth.removeAuthStateListener(l) }
    }

    /**
     * A persisted session can outlive its account (deleted, disabled, tokens revoked); Firebase only
     * notices on the next refresh. Check once per sign-in and drop a dead session so the app returns to
     * sign-in instead of failing every gateway call. Network failures keep the session (offline use).
     */
    suspend fun validateSession(user: FirebaseUser) {
        try { user.getIdToken(true).await() }
        catch (e: FirebaseAuthInvalidUserException) { auth.signOut() }
        catch (e: FirebaseAuthException) { if (e.errorCode in DEAD_SESSION) auth.signOut() }
        catch (_: Exception) { }
    }

    suspend fun signIn(email: String, password: String) = wrap { auth.signInWithEmailAndPassword(email.trim(), password).await() }

    suspend fun signUp(name: String, email: String, password: String) = wrap {
        val res = auth.createUserWithEmailAndPassword(email.trim(), password).await()
        res.user?.updateProfile(UserProfileChangeRequest.Builder().setDisplayName(name.trim()).build())?.await()
        res.user?.let { u ->
            db.document("users/${u.uid}").set(mapOf("displayName" to name.trim(), "email" to email.trim(), "onboarding" to mapOf("step" to "household", "completed" to false)), SetOptions.merge()).await()
        }
    }

    suspend fun sendReset(email: String) = wrap { auth.sendPasswordResetEmail(email.trim()).await() }

    suspend fun signOut(deviceId: String?) {
        runCatching { if (deviceId != null) gateway.call("DELETE", "/v1/me/devices/$deviceId") }
        auth.signOut()
        dao.clearTasks(); dao.clearGroceries(); dao.clearNotes(); dao.clearOutbox(); dao.clearConflicts()
    }

    fun profile(uid: String): Flow<UserProfile?> = callbackFlow {
        val reg = db.document("users/$uid").addSnapshotListener { s, _ ->
            if (s == null) return@addSnapshotListener
            @Suppress("UNCHECKED_CAST") val m = (s.get("memberships") as? Map<String, Map<String, Any?>>).orEmpty()
            @Suppress("UNCHECKED_CAST") val ob = s.get("onboarding") as? Map<String, Any?>
            trySend(UserProfile(uid, s.getString("displayName") ?: auth.currentUser?.displayName ?: "", s.getString("activeHouseholdId"),
                m.mapValues { (it.value["name"] as? String ?: "Household") to Role.of(it.value["role"] as? String) },
                ob?.get("step") as? String, ob?.get("completed") as? Boolean ?: (s.getString("activeHouseholdId") != null)))
        }
        awaitClose { reg.remove() }
    }

    suspend fun setActiveHousehold(uid: String, hid: String) {
        db.document("users/$uid").set(mapOf("activeHouseholdId" to hid), SetOptions.merge()).await()
    }

    suspend fun setOnboarding(uid: String, step: String, completed: Boolean) {
        db.document("users/$uid").set(mapOf("onboarding" to mapOf("step" to step, "completed" to completed)), SetOptions.merge()).await()
    }

    fun household(hid: String): Flow<Household?> = callbackFlow {
        val reg = db.document("households/$hid").addSnapshotListener { s, _ -> trySend(s?.takeIf { it.exists() }?.let(Household::from)) }
        awaitClose { reg.remove() }
    }

    fun members(hid: String): Flow<List<Member>> = callbackFlow {
        val reg = db.collection("households/$hid/members").whereEqualTo("status", "active").addSnapshotListener { s, _ ->
            trySend(s?.documents?.map(Member::from)?.sortedBy { it.role.ordinal }.orEmpty())
        }
        awaitClose { reg.remove() }
    }

    fun invitations(hid: String): Flow<List<Map<String, Any?>>> = callbackFlow {
        val reg = db.collection("households/$hid/invitations").whereEqualTo("status", "pending").addSnapshotListener { s, _ ->
            trySend(s?.documents?.map { it.data.orEmpty() + ("id" to it.id) }.orEmpty())
        }
        awaitClose { reg.remove() }
    }

    suspend fun createHousehold(name: String, currency: String, timezone: String, locale: String, country: String?): String {
        val body = buildJsonObject {
            put("name", name.trim()); put("currency", currency); put("timezone", timezone); put("locale", locale)
            if (country != null && country.length == 2) put("country", country)
        }
        return gateway.call("POST", "/v1/households", body)!!.jsonObject["householdId"]!!.jsonPrimitive.content
    }

    suspend fun updateHouseholdSettings(hid: String, uid: String, name: String, currency: String) {
        db.document("households/$hid").update(mapOf("name" to name.trim(), "currency" to currency, "updatedBy" to uid, "updatedAt" to com.google.firebase.firestore.FieldValue.serverTimestamp())).await()
    }

    /** Returns the one-time invitation code to share. */
    suspend fun invite(hid: String, role: Role, email: String?, name: String?): String {
        val body = buildJsonObject {
            put("role", role.id)
            if (!email.isNullOrBlank()) put("email", email.trim())
            if (!name.isNullOrBlank()) put("displayName", name.trim())
        }
        return gateway.call("POST", "/v1/households/$hid/invitations", body)!!.jsonObject["token"]!!.jsonPrimitive.content
    }

    suspend fun revokeInvitation(hid: String, id: String) { gateway.call("DELETE", "/v1/households/$hid/invitations/$id") }

    suspend fun acceptInvitation(code: String): String =
        gateway.call("POST", "/v1/invitations/accept", buildJsonObject { put("token", code.trim()) })!!.jsonObject["householdId"]!!.jsonPrimitive.content

    suspend fun changeRole(hid: String, uid: String, role: Role) { gateway.call("PATCH", "/v1/households/$hid/members/$uid", buildJsonObject { put("role", role.id) }) }
    suspend fun setFinanceAccess(hid: String, uid: String, allowed: Boolean) {
        gateway.call("PATCH", "/v1/households/$hid/members/$uid", buildJsonObject { put("permissions", buildJsonObject { put("finance", JsonPrimitive(allowed)) }) })
    }
    suspend fun removeMember(hid: String, uid: String) { gateway.call("DELETE", "/v1/households/$hid/members/$uid") }

    suspend fun registerDevice(deviceId: String, token: String, appVersion: String) {
        gateway.call("POST", "/v1/me/devices", buildJsonObject { put("deviceId", deviceId); put("token", token); put("platform", "android"); put("appVersion", appVersion) })
    }

    suspend fun exportMyData(): String = gateway.call("GET", "/v1/me/export").toString()
    suspend fun deleteAccount() { gateway.call("DELETE", "/v1/me"); auth.signOut() }

    private suspend fun <T> wrap(block: suspend () -> T): T = try { block() } catch (e: FirebaseAuthException) {
        throw IllegalStateException(friendlyAuthError(e.errorCode))
    }

    companion object {
        fun friendlyAuthError(code: String): String = when (code) {
            "ERROR_INVALID_EMAIL" -> "That email address doesn't look right."
            "ERROR_WRONG_PASSWORD", "ERROR_INVALID_CREDENTIAL", "ERROR_USER_NOT_FOUND" -> "Email or password is incorrect."
            "ERROR_EMAIL_ALREADY_IN_USE" -> "An account already exists for this email. Sign in instead."
            "ERROR_WEAK_PASSWORD" -> "Use at least 8 characters for your password."
            "ERROR_TOO_MANY_REQUESTS" -> "Too many attempts. Wait a minute and try again."
            "ERROR_NETWORK_REQUEST_FAILED" -> "You're offline. Check your connection and try again."
            else -> "Couldn't sign in. Try again."
        }
    }
}
