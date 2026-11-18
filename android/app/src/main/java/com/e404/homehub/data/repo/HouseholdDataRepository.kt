package com.e404.homehub.data.repo

import com.e404.homehub.data.model.Record
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await

sealed interface Loadable<out T> {
    data object Loading : Loadable<Nothing>
    data class Ready<T>(val value: T) : Loadable<T>
    data class Failed(val message: String) : Loadable<Nothing>
}

/**
 * Direct Firestore access for modules that don't need the offline outbox (finance,
 * bills, pantry, meals, maintenance, inventory, calendar, documents, cleaning).
 * The Firestore SDK still caches reads and queues writes while offline; every write
 * carries the metadata and version bump the security rules require.
 */
class HouseholdDataRepository(private val db: FirebaseFirestore, private val uid: () -> String?) {

    fun <T> observe(hid: String, collection: String, build: (Query) -> Query = { it }, map: (DocumentSnapshot) -> T): Flow<Loadable<List<T>>> = callbackFlow {
        trySend(Loadable.Loading)
        val reg = build(db.collection("households/$hid/$collection")).addSnapshotListener { s, e ->
            if (e != null) { trySend(Loadable.Failed(friendly(e))); return@addSnapshotListener }
            trySend(Loadable.Ready(s?.documents?.mapNotNull { runCatching { map(it) }.getOrNull() }.orEmpty()))
        }
        awaitClose { reg.remove() }
    }

    /**
     * Drops and re-opens Firestore's live connection so every open list catches up at once. On some networks the
     * long-lived stream is cut every minute or two and screens can lag behind changes made elsewhere (for example by
     * the assistant on the server). Cheap, and safe to call often; local pending writes are kept and re-sent.
     */
    suspend fun resync() {
        runCatching { db.disableNetwork().await(); db.enableNetwork().await() }
    }

    fun records(hid: String, collection: String, build: (Query) -> Query = { it }) = observe(hid, collection, build) { Record.from(collection, it) }

    fun <T> observeDoc(path: String, map: (DocumentSnapshot) -> T): Flow<T?> = callbackFlow {
        val reg = db.document(path).addSnapshotListener { s, _ -> trySend(s?.takeIf { it.exists() }?.let(map)) }
        awaitClose { reg.remove() }
    }

    fun newId(hid: String, collection: String): String = db.collection("households/$hid/$collection").document().id

    suspend fun create(hid: String, collection: String, fields: Map<String, Any?>, id: String = newId(hid, collection)): String {
        val me = uid() ?: error("Signed out")
        db.document("households/$hid/$collection/$id").set(fields + mapOf(
            "householdId" to hid, "createdBy" to me, "createdAt" to FieldValue.serverTimestamp(),
            "updatedBy" to me, "updatedAt" to FieldValue.serverTimestamp(), "version" to 1L, "source" to "user",
        )).await()
        return id
    }

    /** Optimistic-concurrency update: fails with a conflict if someone else changed the record first. */
    suspend fun update(hid: String, collection: String, id: String, fields: Map<String, Any?>) {
        val me = uid() ?: error("Signed out")
        val ref = db.document("households/$hid/$collection/$id")
        db.runTransaction { tx ->
            val cur = tx.get(ref)
            val v = cur.getLong("version") ?: 0
            tx.update(ref, fields + mapOf("version" to v + 1, "updatedBy" to me, "updatedAt" to FieldValue.serverTimestamp()))
        }.await()
    }

    /** Creates many documents with the standard bookkeeping fields, in batches (Firestore allows 500 writes per batch). */
    suspend fun createMany(hid: String, collection: String, docs: List<Map<String, Any?>>): Int {
        val me = uid() ?: error("Signed out")
        docs.chunked(400).forEach { chunk ->
            val batch = db.batch()
            chunk.forEach { fields ->
                batch.set(db.collection("households/$hid/$collection").document(), fields + mapOf(
                    "householdId" to hid, "createdBy" to me, "createdAt" to FieldValue.serverTimestamp(),
                    "updatedBy" to me, "updatedAt" to FieldValue.serverTimestamp(), "version" to 1L, "source" to "user",
                ))
            }
            batch.commit().await()
        }
        return docs.size
    }

    suspend fun delete(hid: String, collection: String, id: String) { db.document("households/$hid/$collection/$id").delete().await() }

    /** Append-only ledger write (pantry movements, bill payments): no version, never updated. */
    suspend fun append(path: String, fields: Map<String, Any?>) { db.collection(path).add(fields + mapOf("createdAt" to FieldValue.serverTimestamp())).await() }

    suspend fun markNotificationRead(hid: String, id: String) {
        db.document("households/$hid/notifications/$id").update("readAt", FieldValue.serverTimestamp()).await()
    }

    companion object {
        fun friendly(e: Exception): String = when {
            e.message?.contains("PERMISSION_DENIED") == true -> "You don't have access to this."
            e.message?.contains("UNAVAILABLE") == true -> "You're offline. Showing what's saved on this device."
            else -> "Couldn't load this right now."
        }
    }
}
