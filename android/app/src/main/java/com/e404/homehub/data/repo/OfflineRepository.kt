package com.e404.homehub.data.repo

import android.content.Context
import com.e404.homehub.data.local.LocalDao
import com.e404.homehub.data.local.LocalGrocery
import com.e404.homehub.data.local.LocalNote
import com.e404.homehub.data.local.LocalTask
import com.e404.homehub.data.local.OutboxOp
import com.e404.homehub.data.local.SyncConflict
import com.e404.homehub.data.model.GroceryItem
import com.e404.homehub.data.model.Priority
import com.e404.homehub.data.model.Role
import com.e404.homehub.data.model.Task
import com.e404.homehub.data.sync.FieldCodec
import com.e404.homehub.data.sync.SyncWorker
import com.google.firebase.Timestamp
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.firestore.Query
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import java.time.Instant
import java.util.Date
import java.util.UUID

/**
 * Offline-first data (tasks, shopping items, notes). Room is the source of truth for
 * the UI; Firestore snapshots are mirrored in, except for documents with local edits
 * still waiting in the outbox (so a stale snapshot never overwrites pending work).
 */
class OfflineRepository(
    private val context: Context,
    private val db: FirebaseFirestore,
    private val dao: LocalDao,
    private val scope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val regs = mutableListOf<ListenerRegistration>()
    private val groceryRegs = mutableMapOf<String, ListenerRegistration>()

    fun attach(hid: String, uid: String, role: Role) {
        detach()
        // Children and staff may only read tasks assigned to them (rules enforce this; the query must match).
        val taskQuery: Query = db.collection("households/$hid/tasks").let { if (role.isAdultPlus) it else it.whereEqualTo("assigneeUid", uid) }
        regs += taskQuery.addSnapshotListener { snap, _ ->
            snap ?: return@addSnapshotListener
            if (snap.metadata.hasPendingWrites()) return@addSnapshotListener
            scope.launch {
                val seen = mutableSetOf<String>()
                for (d in snap.documents) {
                    seen += d.id
                    if (dao.opsForDoc(d.id) > 0) continue
                    @Suppress("UNCHECKED_CAST")
                    dao.upsertTask(LocalTask(d.id, hid, d.getString("title") ?: "", d.getString("notes"), d.getString("category"),
                        d.getString("priority") ?: "normal", d.getString("status") ?: "open", d.getTimestamp("dueAt")?.toDate()?.time,
                        d.getString("assigneeUid"), d.get("recurrence") != null, d.getLong("version") ?: 1, false))
                }
                // Remote deletions (only for rows without pending local work).
                if (!snap.metadata.isFromCache) dao.syncedTaskIds(hid).filterNot { it in seen }.forEach { dao.deleteTask(it) }
            }
        }
        if (role != Role.Staff) {
            val notes = db.collection("households/$hid/notes")
            val queries = listOf(notes.whereEqualTo("visibility", "household"), notes.whereEqualTo("createdBy", uid).whereEqualTo("visibility", "private"))
            queries.forEach { q ->
                regs += q.addSnapshotListener { snap, _ ->
                    snap ?: return@addSnapshotListener
                    scope.launch {
                        for (d in snap.documents) {
                            if (dao.opsForDoc(d.id) > 0) continue
                            dao.upsertNote(LocalNote(d.id, hid, d.getString("title") ?: "", d.getString("body") ?: "", d.getString("visibility") ?: "household",
                                d.getString("category"), d.getString("createdBy") ?: "", d.getTimestamp("updatedAt")?.toDate()?.time ?: 0, d.getLong("version") ?: 1, false))
                        }
                    }
                }
            }
        }
    }

    fun attachList(hid: String, listId: String) {
        if (groceryRegs.containsKey(listId)) return
        groceryRegs[listId] = db.collection("households/$hid/groceryItems").whereEqualTo("listId", listId).addSnapshotListener { snap, _ ->
            snap ?: return@addSnapshotListener
            scope.launch {
                val seen = mutableSetOf<String>()
                for (d in snap.documents) {
                    seen += d.id
                    if (dao.opsForDoc(d.id) > 0) continue
                    dao.upsertGrocery(LocalGrocery(d.id, hid, listId, d.getString("name") ?: "", d.getDouble("quantity") ?: 1.0, d.getString("unit") ?: "pcs",
                        d.getString("category") ?: "Other", d.getLong("estimatedPriceMinor"), d.getLong("actualPriceMinor"), d.getBoolean("purchased") ?: false,
                        d.getLong("version") ?: 1, false))
                }
                if (!snap.metadata.isFromCache) dao.syncedGroceryIds(hid, listId).filterNot { it in seen }.forEach { dao.deleteGrocery(it) }
            }
        }
    }

    fun detach() {
        regs.forEach { it.remove() }; regs.clear()
        groceryRegs.values.forEach { it.remove() }; groceryRegs.clear()
    }

    // ---------- tasks ----------
    fun tasks(hid: String): Flow<List<Task>> = dao.tasks(hid).map { list ->
        list.map { Task(it.id, it.title, it.notes, it.category, Priority.of(it.priority), it.status, it.dueAtMillis?.let(Instant::ofEpochMilli), it.assigneeUid, it.recurring, it.version, it.pendingSync) }
    }

    suspend fun createTask(hid: String, title: String, notes: String?, priority: Priority, dueAt: Instant?, assigneeUid: String?, category: String?, recurrence: String?): String {
        val id = db.collection("households/$hid/tasks").document().id
        val fields = mutableMapOf<String, Any?>(
            "title" to title.trim(), "notes" to notes?.trim()?.ifEmpty { null }, "priority" to priority.id, "status" to "open",
            "dueAt" to dueAt?.let { Timestamp(Date.from(it)) }, "assigneeUid" to assigneeUid, "category" to category,
            "recurrence" to recurrence?.let { mapOf("freq" to it) }, "seriesStartAt" to if (recurrence != null) dueAt?.let { Timestamp(Date.from(it)) } else null,
            "checklist" to emptyList<Any>(), "completedAt" to null, "completedBy" to null,
        )
        dao.writeTaskWithOp(
            LocalTask(id, hid, title.trim(), notes, category, priority.id, "open", dueAt?.toEpochMilli(), assigneeUid, recurrence != null, 1, true),
            op(hid, "tasks", id, "create", fields, 0),
        )
        SyncWorker.schedule(context)
        return id
    }

    suspend fun updateTask(hid: String, taskId: String, changes: Map<String, Any?>) {
        val cur = dao.task(taskId) ?: return
        // Local version tracks what the server will hold once queued ops apply, so chained offline edits stay consistent.
        var next = cur.copy(pendingSync = true, version = cur.version + 1)
        changes["title"]?.let { next = next.copy(title = it as String) }
        if ("notes" in changes) next = next.copy(notes = changes["notes"] as String?)
        changes["priority"]?.let { next = next.copy(priority = it as String) }
        if ("dueAt" in changes) next = next.copy(dueAtMillis = (changes["dueAt"] as Timestamp?)?.toDate()?.time)
        if ("assigneeUid" in changes) next = next.copy(assigneeUid = changes["assigneeUid"] as String?)
        changes["status"]?.let { next = next.copy(status = it as String) }
        dao.writeTaskWithOp(next, op(hid, "tasks", taskId, "update", changes, cur.version))
        SyncWorker.schedule(context)
    }

    suspend fun setTaskDone(hid: String, uid: String, taskId: String, done: Boolean) = updateTask(hid, taskId,
        if (done) mapOf("status" to "done", "completedAt" to FieldCodec.ServerTime, "completedBy" to uid)
        else mapOf("status" to "open", "completedAt" to null, "completedBy" to null))

    suspend fun deleteTask(hid: String, taskId: String) {
        val cur = dao.task(taskId) ?: return
        dao.deleteTask(taskId)
        dao.enqueue(op(hid, "tasks", taskId, "delete", emptyMap(), cur.version))
        SyncWorker.schedule(context)
    }

    // ---------- shopping ----------
    fun groceries(hid: String, listId: String): Flow<List<GroceryItem>> = dao.groceries(hid, listId).map { list ->
        list.map { GroceryItem(it.id, it.listId, it.name, it.quantity, it.unit, it.category, it.estimatedPriceMinor, it.actualPriceMinor, it.purchased, it.version, it.pendingSync) }
    }

    suspend fun addGrocery(hid: String, listId: String, name: String, quantity: Double, unit: String, category: String, estimatedPriceMinor: Long?): String {
        val id = db.collection("households/$hid/groceryItems").document().id
        val fields = mapOf(
            "listId" to listId, "name" to name.trim(), "nameKey" to name.trim().lowercase().replace(Regex("\\s+"), " "), "quantity" to quantity, "unit" to unit,
            "category" to category, "estimatedPriceMinor" to estimatedPriceMinor, "actualPriceMinor" to null, "purchased" to false,
            "purchasedAt" to null, "purchasedBy" to null, "preferredBrand" to null, "preferredStore" to null,
        )
        dao.writeGroceryWithOp(LocalGrocery(id, hid, listId, name.trim(), quantity, unit, category, estimatedPriceMinor, null, false, 1, true), op(hid, "groceryItems", id, "create", fields, 0))
        SyncWorker.schedule(context)
        return id
    }

    suspend fun setPurchased(hid: String, uid: String, itemId: String, purchased: Boolean, actualPriceMinor: Long? = null) {
        val cur = dao.grocery(itemId) ?: return
        val fields = mutableMapOf<String, Any?>("purchased" to purchased, "purchasedAt" to if (purchased) FieldCodec.ServerTime else null, "purchasedBy" to if (purchased) uid else null)
        if (actualPriceMinor != null) fields["actualPriceMinor"] = actualPriceMinor
        dao.writeGroceryWithOp(cur.copy(purchased = purchased, actualPriceMinor = actualPriceMinor ?: cur.actualPriceMinor, pendingSync = true, version = cur.version + 1), op(hid, "groceryItems", itemId, "update", fields, cur.version))
        SyncWorker.schedule(context)
    }

    suspend fun deleteGrocery(hid: String, itemId: String) {
        val cur = dao.grocery(itemId) ?: return
        dao.deleteGrocery(itemId)
        dao.enqueue(op(hid, "groceryItems", itemId, "delete", emptyMap(), cur.version))
        SyncWorker.schedule(context)
    }

    // ---------- notes ----------
    fun notes(hid: String) = dao.notes(hid)

    suspend fun saveNote(hid: String, uid: String, id: String?, title: String, body: String, visibility: String, category: String?) {
        val existing = id?.let { dao.note(it) }
        if (existing == null) {
            val newId = db.collection("households/$hid/notes").document().id
            dao.writeNoteWithOp(LocalNote(newId, hid, title, body, visibility, category, uid, now(), 1, true),
                op(hid, "notes", newId, "create", mapOf("title" to title.trim(), "body" to body, "visibility" to visibility, "category" to category), 0))
        } else {
            dao.writeNoteWithOp(existing.copy(title = title, body = body, category = category, updatedAtMillis = now(), pendingSync = true, version = existing.version + 1),
                op(hid, "notes", existing.id, "update", mapOf("title" to title.trim(), "body" to body, "category" to category), existing.version))
        }
        SyncWorker.schedule(context)
    }

    suspend fun deleteNote(hid: String, id: String) {
        val cur = dao.note(id) ?: return
        dao.deleteNote(id)
        dao.enqueue(op(hid, "notes", id, "delete", emptyMap(), cur.version))
        SyncWorker.schedule(context)
    }

    // ---------- sync state ----------
    fun pendingCount(hid: String) = dao.pendingCount(hid)
    fun conflicts(hid: String): Flow<List<SyncConflict>> = dao.conflicts(hid)

    /** Keep mine: re-apply the local change on top of the current server version. */
    suspend fun keepMine(c: SyncConflict) {
        val op = dao.op(c.opId) ?: return dao.deleteConflict(c.opId)
        dao.removeOp(op.opId)
        if (c.remoteVersion >= 0) dao.enqueue(op.copy(opId = UUID.randomUUID().toString(), baseVersion = c.remoteVersion, state = "pending", attempts = 0, createdAtMillis = now()))
        dao.deleteConflict(c.opId)
        SyncWorker.schedule(context)
    }

    /** Keep theirs: drop the local change and reload the server copy. */
    suspend fun keepTheirs(c: SyncConflict) {
        dao.removeOp(c.opId)
        dao.deleteConflict(c.opId)
        val snap = runCatching { db.document("households/${c.householdId}/${c.collection}/${c.docId}").get().await() }.getOrNull()
        if (snap == null || !snap.exists()) {
            when (c.collection) { "tasks" -> dao.deleteTask(c.docId); "groceryItems" -> dao.deleteGrocery(c.docId); "notes" -> dao.deleteNote(c.docId) }
            return
        }
        when (c.collection) {
            "tasks" -> dao.task(c.docId)?.let { dao.upsertTask(it.copy(title = snap.getString("title") ?: it.title, status = snap.getString("status") ?: it.status, version = snap.getLong("version") ?: it.version, pendingSync = false)) }
            "groceryItems" -> dao.grocery(c.docId)?.let { dao.upsertGrocery(it.copy(purchased = snap.getBoolean("purchased") ?: false, quantity = snap.getDouble("quantity") ?: it.quantity, version = snap.getLong("version") ?: it.version, pendingSync = false)) }
            "notes" -> dao.note(c.docId)?.let { dao.upsertNote(it.copy(title = snap.getString("title") ?: it.title, body = snap.getString("body") ?: it.body, version = snap.getLong("version") ?: it.version, pendingSync = false)) }
        }
    }

    private fun op(hid: String, collection: String, docId: String, kind: String, fields: Map<String, Any?>, baseVersion: Long) =
        OutboxOp(UUID.randomUUID().toString(), hid, collection, docId, kind, FieldCodec.encode(fields), baseVersion, now())
}
