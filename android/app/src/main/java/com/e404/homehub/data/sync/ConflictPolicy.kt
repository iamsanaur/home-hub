package com.e404.homehub.data.sync

/**
 * Conflict policy per data type (claude.md §13). Applied when an offline edit made on
 * `baseVersion` reaches a server copy at `remoteVersion`.
 *
 *  tasks          completion-only edits merge onto a newer remote unless the remote was
 *                 completed/cancelled meanwhile; anything else → user resolves.
 *  groceryItems   "purchased" edits merge onto a newer remote unless someone already
 *                 bought it; quantity/name edits → user resolves.
 *  notes          never merged automatically (text) → user resolves.
 *  finance        not editable offline at all; creates are append-only with client IDs,
 *                 so a financial record is never silently overwritten.
 */
sealed interface SyncDecision {
    data object Apply : SyncDecision
    data object AlreadyApplied : SyncDecision
    data class Conflict(val reason: String) : SyncDecision
}

object ConflictPolicy {
    private val TASK_COMPLETION = setOf("status", "completedAt", "completedBy")
    private val GROCERY_PURCHASE = setOf("purchased", "purchasedAt", "purchasedBy", "actualPriceMinor")

    fun decideUpdate(
        collection: String,
        baseVersion: Long,
        remoteExists: Boolean,
        remoteVersion: Long,
        changedFields: Set<String>,
        remote: Map<String, Any?>,
    ): SyncDecision {
        if (!remoteExists) return SyncDecision.Conflict("Deleted on another device")
        if (remoteVersion == baseVersion) return SyncDecision.Apply
        return when (collection) {
            "tasks" -> when {
                changedFields.isNotEmpty() && TASK_COMPLETION.containsAll(changedFields) &&
                    remote["status"] !in setOf("done", "cancelled") -> SyncDecision.Apply
                changedFields.isNotEmpty() && TASK_COMPLETION.containsAll(changedFields) && remote["status"] == "done" -> SyncDecision.AlreadyApplied
                else -> SyncDecision.Conflict("Changed on another device")
            }
            "groceryItems" -> when {
                changedFields.isNotEmpty() && GROCERY_PURCHASE.containsAll(changedFields) && remote["purchased"] != true -> SyncDecision.Apply
                changedFields.isNotEmpty() && GROCERY_PURCHASE.containsAll(changedFields) && remote["purchased"] == true -> SyncDecision.AlreadyApplied
                else -> SyncDecision.Conflict("Changed on another device")
            }
            else -> SyncDecision.Conflict("Changed on another device")
        }
    }

    /** A create is a no-op if this exact op already landed (same clientOpId); otherwise the ID collided. */
    fun decideCreate(remoteExists: Boolean, remoteClientOpId: String?, opId: String): SyncDecision = when {
        !remoteExists -> SyncDecision.Apply
        remoteClientOpId == opId -> SyncDecision.AlreadyApplied
        else -> SyncDecision.Conflict("A record with this ID already exists")
    }

    /** Exponential backoff with cap, in seconds, for transient failures. */
    fun backoffSeconds(attempt: Int): Long = minOf(15L shl minOf(attempt, 12), 6 * 3600L)
}
