package com.e404.homehub.data.model

import com.google.firebase.Timestamp
import com.google.firebase.firestore.DocumentSnapshot
import java.time.Instant

// Mapping is explicit (no reflection) so a malformed document never crashes a screen.
private fun DocumentSnapshot.str(k: String) = getString(k)
private fun DocumentSnapshot.long(k: String) = (get(k) as? Number)?.toLong()
private fun DocumentSnapshot.dbl(k: String) = (get(k) as? Number)?.toDouble()
private fun DocumentSnapshot.bool(k: String) = getBoolean(k) ?: false
private fun DocumentSnapshot.instant(k: String): Instant? = (get(k) as? Timestamp)?.toDate()?.toInstant()

enum class Role(val id: String, val label: String) {
    Owner("owner", "Owner"), Admin("admin", "Administrator"), Adult("adult", "Adult"), Child("child", "Child"), Staff("staff", "Staff");
    val isAdultPlus get() = this == Owner || this == Admin || this == Adult
    val isManager get() = this == Owner || this == Admin
    companion object { fun of(id: String?) = entries.firstOrNull { it.id == id } ?: Adult }
}

data class Autonomy(val mode: String = "routine", val paused: Boolean = false)

data class Household(val id: String, val name: String, val currency: String, val timezone: String, val locale: String, val autonomy: Autonomy, val memberCount: Int) {
    companion object {
        fun from(d: DocumentSnapshot): Household {
            @Suppress("UNCHECKED_CAST") val a = d.get("autonomy") as? Map<String, Any?>
            return Household(d.id, d.str("name") ?: "Home", d.str("currency") ?: "INR", d.str("timezone") ?: "UTC", d.str("locale") ?: "en",
                Autonomy(a?.get("mode") as? String ?: "routine", a?.get("paused") as? Boolean ?: false), d.long("memberCount")?.toInt() ?: 1)
        }
    }
}

data class Member(val uid: String, val displayName: String, val role: Role, val financeAllowed: Boolean) {
    val initials: String get() = displayName.split(" ").filter { it.isNotBlank() }.take(2).joinToString("") { it.first().uppercase() }.ifEmpty { "?" }
    companion object {
        fun from(d: DocumentSnapshot): Member {
            @Suppress("UNCHECKED_CAST") val p = d.get("permissions") as? Map<String, Any?>
            return Member(d.id, d.str("displayName") ?: "Member", Role.of(d.str("role")), p?.get("finance") as? Boolean ?: true)
        }
    }
}

enum class Priority(val id: String, val label: String) {
    Low("low", "Low"), Normal("normal", "Normal"), High("high", "High"), Urgent("urgent", "Urgent");
    companion object { fun of(id: String?) = entries.firstOrNull { it.id == id } ?: Normal }
}

data class Task(
    val id: String, val title: String, val notes: String?, val category: String?, val priority: Priority, val status: String,
    val dueAt: Instant?, val assigneeUid: String?, val recurring: Boolean, val version: Long, val pendingSync: Boolean = false,
) {
    val isDone get() = status == "done"
}

data class ShoppingList(val id: String, val name: String, val store: String?, val itemCount: Int, val purchasedCount: Int) {
    companion object { fun from(d: DocumentSnapshot) = ShoppingList(d.id, d.str("name") ?: "List", d.str("store"), d.long("itemCount")?.toInt() ?: 0, d.long("purchasedCount")?.toInt() ?: 0) }
}

data class GroceryItem(
    val id: String, val listId: String, val name: String, val quantity: Double, val unit: String, val category: String,
    val estimatedPriceMinor: Long?, val actualPriceMinor: Long?, val purchased: Boolean, val version: Long, val pendingSync: Boolean = false,
)

data class PantryItem(val id: String, val name: String, val quantity: Double, val unit: String, val minQuantity: Double?, val lowStock: Boolean, val location: String?, val expiresAt: Instant?, val updatedAt: Instant?, val version: Long) {
    companion object { fun from(d: DocumentSnapshot) = PantryItem(d.id, d.str("name") ?: "", d.dbl("quantity") ?: 0.0, d.str("unit") ?: "pcs", d.dbl("minQuantity"), d.bool("lowStock"), d.str("location"), d.instant("expiresAt"), d.instant("updatedAt"), d.long("version") ?: 1) }
}

data class Txn(val id: String, val type: String, val amountMinor: Long, val currency: String, val category: String, val description: String?, val paymentMethod: String, val occurredAt: Instant?, val locked: Boolean) {
    companion object { fun from(d: DocumentSnapshot) = Txn(d.id, d.str("type") ?: "expense", d.long("amountMinor") ?: 0, d.str("currency") ?: "INR", d.str("category") ?: "Other", d.str("description"), d.str("paymentMethod") ?: "other", d.instant("occurredAt"), d.bool("locked")) }
}

data class Budget(val id: String, val period: String, val category: String?, val limitMinor: Long) {
    companion object { fun from(d: DocumentSnapshot) = Budget(d.id, d.str("period") ?: "", d.str("category"), d.long("limitMinor") ?: 0) }
}

data class Bill(val id: String, val name: String, val category: String?, val amountMinor: Long, val currency: String, val nextDueAt: Instant?, val recurrence: String?, val lastPaidAt: Instant?, val reminderDaysBefore: Int, val active: Boolean, val version: Long, val metered: Boolean = false, val meterUnit: String? = null, val meterRateMinor: Long = 0) {
    companion object {
        fun from(d: DocumentSnapshot): Bill {
            @Suppress("UNCHECKED_CAST") val r = d.get("recurrence") as? Map<String, Any?>
            return Bill(d.id, d.str("name") ?: "Bill", d.str("category"), d.long("amountMinor") ?: 0, d.str("currency") ?: "INR", d.instant("nextDueAt"), r?.get("freq") as? String, d.instant("lastPaidAt"), d.long("reminderDaysBefore")?.toInt() ?: 3, d.getBoolean("active") ?: true, d.long("version") ?: 1,
                d.str("kind") == "metered", (d.get("meter") as? Map<String, Any?>)?.get("unit") as? String, ((d.get("meter") as? Map<String, Any?>)?.get("rateMinor") as? Number)?.toLong() ?: 0)
        }
    }
}

data class BillPayment(val id: String, val billId: String, val amountMinor: Long, val currency: String, val paidAt: Instant?, val method: String) {
    companion object { fun from(d: DocumentSnapshot) = BillPayment(d.id, d.str("billId") ?: "", d.long("amountMinor") ?: 0, d.str("currency") ?: "INR", d.instant("paidAt"), d.str("method") ?: "other") }
}

data class MealEntry(val date: String, val slot: String, val title: String, val recipeId: String?, val servings: Int)
data class MealPlan(val weekStart: String, val entries: List<MealEntry>, val version: Long) {
    companion object {
        fun from(d: DocumentSnapshot): MealPlan {
            @Suppress("UNCHECKED_CAST") val e = (d.get("entries") as? List<Map<String, Any?>>).orEmpty()
            return MealPlan(d.str("weekStart") ?: d.id, e.map { MealEntry(it["date"] as? String ?: "", it["slot"] as? String ?: "dinner", it["title"] as? String ?: "", it["recipeId"] as? String, (it["servings"] as? Number)?.toInt() ?: 2) }, d.long("version") ?: 1)
        }
    }
}
data class Recipe(val id: String, val name: String, val servings: Int, val ingredients: List<String>, val tags: List<String>) {
    companion object {
        fun from(d: DocumentSnapshot): Recipe {
            @Suppress("UNCHECKED_CAST") val ing = (d.get("ingredients") as? List<Map<String, Any?>>).orEmpty()
            @Suppress("UNCHECKED_CAST") val tags = (d.get("tags") as? List<String>).orEmpty()
            return Recipe(d.id, d.str("name") ?: "Recipe", d.long("servings")?.toInt() ?: 2, ing.map { "${it["quantity"]} ${it["unit"]} ${it["name"]}" }, tags)
        }
    }
}

/** Generic record used by the simpler modules (cleaning, maintenance, inventory, documents, events, notes). */
data class Record(val id: String, val collection: String, val data: Map<String, Any?>) {
    fun s(k: String) = data[k] as? String
    fun l(k: String) = (data[k] as? Number)?.toLong()
    fun d(k: String) = (data[k] as? Number)?.toDouble()
    fun b(k: String) = data[k] as? Boolean ?: false
    fun t(k: String): Instant? = (data[k] as? Timestamp)?.toDate()?.toInstant()
    val version get() = l("version") ?: 1
    companion object { fun from(collection: String, d: DocumentSnapshot) = Record(d.id, collection, d.data.orEmpty()) }
}

data class Approval(
    val id: String, val action: String, val title: String, val rationale: String, val status: String, val params: Map<String, Any?>,
    val estimatedCostMinor: Long?, val currency: String?, val recipient: String?, val relevantDate: String?, val dataShared: String?,
    val consequences: String?, val manualCompletion: Boolean, val requestedBy: String?, val agentId: String?, val createdAt: Instant?, val expiresAt: Instant?,
    val executionOutcome: String?, val executionNote: String?,
) {
    companion object {
        fun from(d: DocumentSnapshot): Approval {
            @Suppress("UNCHECKED_CAST") val p = d.get("params") as? Map<String, Any?> ?: emptyMap()
            @Suppress("UNCHECKED_CAST") val r = d.get("executionResult") as? Map<String, Any?>
            return Approval(d.id, d.str("action") ?: "", d.str("title") ?: "", d.str("rationale") ?: "", d.str("status") ?: "pending", p,
                d.long("estimatedCostMinor"), d.str("currency"), d.str("recipient"), d.str("relevantDate"), d.str("dataShared"), d.str("consequences"),
                d.bool("manualCompletion"), d.str("requestedBy"), d.str("agentId"), d.instant("createdAt"), d.instant("expiresAt"),
                r?.get("outcome") as? String, (r?.get("note") ?: r?.get("error")) as? String)
        }
    }
}

data class AppNotification(val id: String, val category: String, val title: String, val body: String, val deepLink: String?, val createdAt: Instant?, val read: Boolean) {
    companion object { fun from(d: DocumentSnapshot) = AppNotification(d.id, d.str("category") ?: "", d.str("title") ?: "", d.str("body") ?: "", d.str("deepLink"), d.instant("createdAt"), d.get("readAt") != null) }
}

data class AgentSession(val id: String, val title: String, val updatedAt: Instant?) {
    companion object { fun from(d: DocumentSnapshot) = AgentSession(d.id, d.str("title") ?: "Conversation", d.instant("updatedAt")) }
}
data class AgentMessage(val id: String, val role: String, val content: String, val state: String?, val createdAt: Instant?, val verifiedActions: List<String>, val pendingApprovalIds: List<String>) {
    companion object {
        fun from(d: DocumentSnapshot): AgentMessage {
            @Suppress("UNCHECKED_CAST") val va = (d.get("verifiedActions") as? List<Map<String, Any?>>).orEmpty().mapNotNull { it["action"] as? String }
            @Suppress("UNCHECKED_CAST") val pa = (d.get("pendingApprovalIds") as? List<String>).orEmpty()
            return AgentMessage(d.id, d.str("role") ?: "assistant", d.str("content") ?: "", d.str("state"), d.instant("createdAt"), va, pa)
        }
    }
}

data class ScheduledJob(val id: String, val type: String, val enabled: Boolean, val time: String, val kind: String, val lastStatus: String?, val nextRunAt: Instant?, val requiresAgent: Boolean) {
    companion object {
        fun from(d: DocumentSnapshot): ScheduledJob {
            @Suppress("UNCHECKED_CAST") val s = d.get("schedule") as? Map<String, Any?>
            return ScheduledJob(d.id, d.str("type") ?: d.id, d.bool("enabled"), s?.get("time") as? String ?: "", s?.get("kind") as? String ?: "daily", d.str("lastStatus"), d.instant("nextRunAt"), d.bool("requiresAgent"))
        }
    }
}
