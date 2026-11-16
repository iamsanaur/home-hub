package com.e404.homehub.data.local

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

/**
 * Local source of truth for the offline-capable data: tasks, shopping items and notes.
 * Every local edit is written here AND appended to the outbox in one transaction;
 * SyncWorker drains the outbox to Firestore.
 */
@Entity(tableName = "tasks", indices = [Index("householdId")])
data class LocalTask(
    @PrimaryKey val id: String,
    val householdId: String,
    val title: String,
    val notes: String?,
    val category: String?,
    val priority: String,
    val status: String,
    val dueAtMillis: Long?,
    val assigneeUid: String?,
    val recurring: Boolean,
    val version: Long,
    val pendingSync: Boolean,
)

@Entity(tableName = "grocery_items", indices = [Index("householdId"), Index("listId")])
data class LocalGrocery(
    @PrimaryKey val id: String,
    val householdId: String,
    val listId: String,
    val name: String,
    val quantity: Double,
    val unit: String,
    val category: String,
    val estimatedPriceMinor: Long?,
    val actualPriceMinor: Long?,
    val purchased: Boolean,
    val version: Long,
    val pendingSync: Boolean,
)

@Entity(tableName = "notes", indices = [Index("householdId")])
data class LocalNote(
    @PrimaryKey val id: String,
    val householdId: String,
    val title: String,
    val body: String,
    val visibility: String,
    val category: String?,
    val createdBy: String,
    val updatedAtMillis: Long,
    val version: Long,
    val pendingSync: Boolean,
)

/** One pending write. `fieldsJson` holds only the changed fields; `baseVersion` is the version the edit was made on. */
@Entity(tableName = "outbox", indices = [Index("householdId")])
data class OutboxOp(
    @PrimaryKey val opId: String,
    val householdId: String,
    val collection: String,
    val docId: String,
    val kind: String, // create | update | delete
    val fieldsJson: String,
    val baseVersion: Long,
    val createdAtMillis: Long,
    val attempts: Int = 0,
    val state: String = "pending", // pending | conflict | failed
    val lastError: String? = null,
)

@Entity(tableName = "conflicts")
data class SyncConflict(
    @PrimaryKey val opId: String,
    val householdId: String,
    val collection: String,
    val docId: String,
    val localSummary: String,
    val remoteSummary: String,
    val remoteVersion: Long,
    val createdAtMillis: Long,
)

@Dao
interface LocalDao {
    @Query("SELECT * FROM tasks WHERE householdId = :hid ORDER BY CASE WHEN dueAtMillis IS NULL THEN 1 ELSE 0 END, dueAtMillis")
    fun tasks(hid: String): Flow<List<LocalTask>>
    @Query("SELECT * FROM tasks WHERE id = :id") suspend fun task(id: String): LocalTask?
    @Upsert suspend fun upsertTask(t: LocalTask)
    @Query("DELETE FROM tasks WHERE id = :id") suspend fun deleteTask(id: String)
    @Query("SELECT id FROM tasks WHERE householdId = :hid AND pendingSync = 0") suspend fun syncedTaskIds(hid: String): List<String>

    @Query("SELECT * FROM grocery_items WHERE householdId = :hid AND listId = :listId ORDER BY purchased, category, name")
    fun groceries(hid: String, listId: String): Flow<List<LocalGrocery>>
    @Query("SELECT * FROM grocery_items WHERE id = :id") suspend fun grocery(id: String): LocalGrocery?
    @Upsert suspend fun upsertGrocery(g: LocalGrocery)
    @Query("DELETE FROM grocery_items WHERE id = :id") suspend fun deleteGrocery(id: String)
    @Query("SELECT id FROM grocery_items WHERE householdId = :hid AND listId = :listId AND pendingSync = 0") suspend fun syncedGroceryIds(hid: String, listId: String): List<String>

    @Query("SELECT * FROM notes WHERE householdId = :hid ORDER BY updatedAtMillis DESC")
    fun notes(hid: String): Flow<List<LocalNote>>
    @Query("SELECT * FROM notes WHERE id = :id") suspend fun note(id: String): LocalNote?
    @Upsert suspend fun upsertNote(n: LocalNote)
    @Query("DELETE FROM notes WHERE id = :id") suspend fun deleteNote(id: String)
    @Query("SELECT id FROM notes WHERE householdId = :hid AND pendingSync = 0") suspend fun syncedNoteIds(hid: String): List<String>

    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun enqueue(op: OutboxOp)
    @Query("SELECT * FROM outbox WHERE state = 'pending' ORDER BY createdAtMillis LIMIT :limit") suspend fun pendingOps(limit: Int = 50): List<OutboxOp>
    @Query("SELECT COUNT(*) FROM outbox WHERE householdId = :hid AND state = 'pending'") fun pendingCount(hid: String): Flow<Int>
    @Query("SELECT COUNT(*) FROM outbox WHERE docId = :docId AND state != 'done'") suspend fun opsForDoc(docId: String): Int
    @Query("UPDATE outbox SET attempts = attempts + 1, lastError = :error WHERE opId = :opId") suspend fun markAttempt(opId: String, error: String?)
    @Query("UPDATE outbox SET state = :state, lastError = :error WHERE opId = :opId") suspend fun setState(opId: String, state: String, error: String?)
    @Query("DELETE FROM outbox WHERE opId = :opId") suspend fun removeOp(opId: String)
    @Query("SELECT * FROM outbox WHERE opId = :opId") suspend fun op(opId: String): OutboxOp?

    @Upsert suspend fun upsertConflict(c: SyncConflict)
    @Query("SELECT * FROM conflicts WHERE householdId = :hid ORDER BY createdAtMillis DESC") fun conflicts(hid: String): Flow<List<SyncConflict>>
    @Query("DELETE FROM conflicts WHERE opId = :opId") suspend fun deleteConflict(opId: String)

    @Transaction
    suspend fun writeTaskWithOp(t: LocalTask, op: OutboxOp) { upsertTask(t); enqueue(op) }
    @Transaction
    suspend fun writeGroceryWithOp(g: LocalGrocery, op: OutboxOp) { upsertGrocery(g); enqueue(op) }
    @Transaction
    suspend fun writeNoteWithOp(n: LocalNote, op: OutboxOp) { upsertNote(n); enqueue(op) }

    @Query("DELETE FROM tasks") suspend fun clearTasks()
    @Query("DELETE FROM grocery_items") suspend fun clearGroceries()
    @Query("DELETE FROM notes") suspend fun clearNotes()
    @Query("DELETE FROM outbox") suspend fun clearOutbox()
    @Query("DELETE FROM conflicts") suspend fun clearConflicts()
}

@Database(entities = [LocalTask::class, LocalGrocery::class, LocalNote::class, OutboxOp::class, SyncConflict::class], version = 1, exportSchema = true)
abstract class HomeHubDatabase : RoomDatabase() {
    abstract fun dao(): LocalDao

    companion object {
        @Volatile private var instance: HomeHubDatabase? = null
        fun get(context: Context): HomeHubDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(context.applicationContext, HomeHubDatabase::class.java, "homehub.db").build().also { instance = it }
        }
        fun inMemory(context: Context): HomeHubDatabase = Room.inMemoryDatabaseBuilder(context, HomeHubDatabase::class.java).allowMainThreadQueries().build()
    }
}
