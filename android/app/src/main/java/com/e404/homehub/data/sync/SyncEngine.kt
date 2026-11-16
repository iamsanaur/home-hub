package com.e404.homehub.data.sync

import com.e404.homehub.data.local.LocalDao
import com.e404.homehub.data.local.OutboxOp
import com.e404.homehub.data.local.SyncConflict
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import kotlinx.coroutines.tasks.await

/** Outcome of draining the outbox once. */
data class SyncReport(val applied: Int, val conflicts: Int, val rejected: Int, val transientFailure: Boolean)

/**
 * Applies outbox operations to Firestore inside transactions. Every write carries the
 * metadata firestore.rules require (createdBy/createdAt/version on create; version+1,
 * updatedBy/updatedAt on update) so offline writes pass the same validation as online ones.
 */
class SyncEngine(
    private val db: FirebaseFirestore,
    private val dao: LocalDao,
    private val uid: () -> String?,
    private val now: () -> Long = System::currentTimeMillis,
) {
    suspend fun drain(): SyncReport {
        val me = uid() ?: return SyncReport(0, 0, 0, transientFailure = false)
        var applied = 0; var conflicts = 0; var rejected = 0
        for (op in dao.pendingOps()) {
            try {
                when (val r = apply(op, me)) {
                    is Result.Done -> { applied++; finish(op, r.version) }
                    is Result.Conflict -> {
                        conflicts++
                        dao.setState(op.opId, "conflict", r.reason)
                        dao.upsertConflict(SyncConflict(op.opId, op.householdId, op.collection, op.docId, summarize(FieldCodec.decode(op.fieldsJson)), summarize(r.remote), r.remoteVersion, now()))
                    }
                }
            } catch (e: FirebaseFirestoreException) {
                if (e.code == FirebaseFirestoreException.Code.PERMISSION_DENIED || e.code == FirebaseFirestoreException.Code.INVALID_ARGUMENT) {
                    rejected++
                    dao.setState(op.opId, "failed", "Not allowed: ${e.code}")
                    dao.upsertConflict(SyncConflict(op.opId, op.householdId, op.collection, op.docId, summarize(FieldCodec.decode(op.fieldsJson)), "The household rejected this change (permissions).", -1, now()))
                } else {
                    dao.markAttempt(op.opId, e.code.name)
                    return SyncReport(applied, conflicts, rejected, transientFailure = true)
                }
            } catch (e: Exception) {
                dao.markAttempt(op.opId, e.message)
                return SyncReport(applied, conflicts, rejected, transientFailure = true)
            }
        }
        return SyncReport(applied, conflicts, rejected, transientFailure = false)
    }

    private sealed interface Result {
        data class Done(val version: Long) : Result
        data class Conflict(val reason: String, val remote: Map<String, Any?>, val remoteVersion: Long) : Result
    }

    private suspend fun apply(op: OutboxOp, me: String): Result {
        val ref = db.document("households/${op.householdId}/${op.collection}/${op.docId}")
        val fields = FieldCodec.decode(op.fieldsJson)
        return db.runTransaction { tx ->
            val snap = tx.get(ref)
            val remote = snap.data.orEmpty()
            val remoteVersion = (remote["version"] as? Number)?.toLong() ?: 0
            when (op.kind) {
                "create" -> when (val d = ConflictPolicy.decideCreate(snap.exists(), remote["clientOpId"] as? String, op.opId)) {
                    SyncDecision.Apply -> {
                        tx.set(ref, fields + mapOf(
                            "householdId" to op.householdId, "createdBy" to me, "createdAt" to FieldValue.serverTimestamp(),
                            "updatedBy" to me, "updatedAt" to FieldValue.serverTimestamp(), "version" to 1L,
                            "source" to "user", "clientOpId" to op.opId,
                        ))
                        Result.Done(1)
                    }
                    SyncDecision.AlreadyApplied -> Result.Done(remoteVersion)
                    is SyncDecision.Conflict -> Result.Conflict(d.reason, remote, remoteVersion)
                }
                "update" -> when (val d = ConflictPolicy.decideUpdate(op.collection, op.baseVersion, snap.exists(), remoteVersion, fields.keys, remote)) {
                    SyncDecision.Apply -> {
                        tx.update(ref, fields + mapOf("version" to remoteVersion + 1, "updatedBy" to me, "updatedAt" to FieldValue.serverTimestamp()))
                        Result.Done(remoteVersion + 1)
                    }
                    SyncDecision.AlreadyApplied -> Result.Done(remoteVersion)
                    is SyncDecision.Conflict -> Result.Conflict(d.reason, remote, remoteVersion)
                }
                "delete" -> {
                    if (snap.exists()) tx.delete(ref)
                    Result.Done(remoteVersion)
                }
                else -> Result.Conflict("Unknown operation", remote, remoteVersion)
            }
        }.await()
    }

    private suspend fun finish(op: OutboxOp, version: Long) {
        dao.removeOp(op.opId)
        if (op.kind == "delete" || dao.opsForDoc(op.docId) > 0) return
        when (op.collection) {
            "tasks" -> dao.task(op.docId)?.let { dao.upsertTask(it.copy(version = version, pendingSync = false)) }
            "groceryItems" -> dao.grocery(op.docId)?.let { dao.upsertGrocery(it.copy(version = version, pendingSync = false)) }
            "notes" -> dao.note(op.docId)?.let { dao.upsertNote(it.copy(version = version, pendingSync = false)) }
        }
    }

    private fun summarize(m: Map<String, Any?>): String =
        listOf("title", "name", "status", "quantity", "purchased", "body").mapNotNull { k -> m[k]?.let { "$k: ${it.toString().take(80)}" } }.joinToString(" · ").ifEmpty { "(no visible fields)" }
}
