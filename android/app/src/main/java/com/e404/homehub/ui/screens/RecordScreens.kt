package com.e404.homehub.ui.screens

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.CleaningServices
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.StickyNote2
import androidx.compose.material.icons.outlined.Weekend
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.e404.homehub.AppGraph
import com.e404.homehub.data.local.LocalNote
import com.e404.homehub.data.model.Money
import com.e404.homehub.data.model.Record
import com.e404.homehub.data.repo.Loadable
import com.e404.homehub.ui.HouseholdContext
import com.e404.homehub.ui.LocalActions
import com.e404.homehub.ui.LocalHousehold
import com.e404.homehub.ui.components.ButtonKind
import com.e404.homehub.ui.components.ConfirmationDialog
import com.e404.homehub.ui.components.Divider
import com.e404.homehub.ui.components.EmptyState
import com.e404.homehub.ui.components.ErrorState
import com.e404.homehub.ui.components.GroupedList
import com.e404.homehub.ui.components.HomeHubButton
import com.e404.homehub.ui.components.HomeHubListTile
import com.e404.homehub.ui.components.HomeHubTextField
import com.e404.homehub.ui.components.LoadingSkeleton
import com.e404.homehub.ui.components.PendingSyncIndicator
import com.e404.homehub.ui.components.SectionHeader
import com.e404.homehub.ui.components.SegmentedFilter
import com.e404.homehub.ui.components.StatusBadge
import com.e404.homehub.ui.components.Tone
import com.e404.homehub.ui.theme.HomeHubTheme
import com.e404.homehub.ui.util.Dates
import com.google.firebase.Timestamp
import com.google.firebase.firestore.Query
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.LocalDateTime
import java.util.Date

/** Typed field for record forms. Dates are entered as ISO text with inline validation. */
sealed class Field(val key: String, val label: String, val optional: Boolean) {
    class Text(key: String, label: String, optional: Boolean = false, val multiline: Boolean = false) : Field(key, label, optional)
    class Choice(key: String, label: String, val options: List<Pair<String, String>>, optional: Boolean = false) : Field(key, label, optional)
    class Date(key: String, label: String, optional: Boolean = false, val withTime: Boolean = false) : Field(key, label, optional)
    class Amount(key: String, label: String, optional: Boolean = true) : Field(key, label, optional)
    class Number(key: String, label: String, optional: Boolean = true) : Field(key, label, optional)
    class Toggle(key: String, label: String) : Field(key, label, true)
}

data class RecordSpec(
    val title: String,
    val collection: String,
    val icon: ImageVector,
    val emptyTitle: String,
    val emptyMessage: String,
    val fields: List<Field>,
    val query: (Query, HouseholdContext) -> Query = { q, _ -> q },
    val groupBy: (Record) -> String = { "" },
    val rowTitle: (Record) -> String = { it.s("title") ?: it.s("name") ?: "Untitled" },
    val rowSubtitle: (Record, HouseholdContext) -> String? = { _, _ -> null },
    val badge: (Record, HouseholdContext) -> Pair<String, Tone>? = { _, _ -> null },
    val defaults: Map<String, Any?> = emptyMap(),
    val canWrite: (HouseholdContext) -> Boolean = { it.role.isAdultPlus },
    val canRead: (HouseholdContext) -> Boolean = { true },
    val canDelete: (HouseholdContext) -> Boolean = { it.role.isManager },
)

@Composable
fun RecordListScreen(spec: RecordSpec) {
    val h = LocalHousehold.current
    val graph = AppGraph.get(LocalContext.current)
    var editing by remember { mutableStateOf<Record?>(null) }
    var creating by remember { mutableStateOf(false) }
    if (!spec.canRead(h)) { ListScreen(spec.title) { item { EmptyState(Icons.Outlined.Lock, "Not available for your role", "Ask an adult in your household if you need this.") } }; return }
    val records by remember(h.hid, spec.collection) { graph.data.records(h.hid, spec.collection) { spec.query(it, h) } }.collectAsStateWithLifecycle(Loadable.Loading)
    val canWrite = spec.canWrite(h)
    ListScreen(spec.title, fabIcon = if (canWrite) Icons.Outlined.Add else null, fabLabel = "Add", onFab = { creating = true }) {
        when (val r = records) {
            Loadable.Loading -> item { LoadingSkeleton() }
            is Loadable.Failed -> item { ErrorState(r.message) }
            is Loadable.Ready -> {
                val visible = r.value.filter { !it.b("deleted") }
                if (visible.isEmpty()) item { EmptyState(spec.icon, spec.emptyTitle, spec.emptyMessage, actionLabel = if (canWrite) "Add" else null, onAction = { creating = true }) }
                visible.groupBy(spec.groupBy).toSortedMap().forEach { (group, rows) ->
                    item {
                        Column {
                            if (group.isNotEmpty()) SectionHeader(group)
                            GroupedList {
                                rows.forEachIndexed { i, rec ->
                                    if (i > 0) Divider()
                                    HomeHubListTile(spec.rowTitle(rec), subtitle = spec.rowSubtitle(rec, h), leadingIcon = spec.icon,
                                        onClick = if (canWrite) ({ editing = rec }) else null,
                                        trailing = { spec.badge(rec, h)?.let { (l, tone) -> StatusBadge(l, tone) } })
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if (creating || editing != null) RecordForm(spec, editing) { creating = false; editing = null }
}

@Composable
private fun RecordForm(spec: RecordSpec, record: Record?, onDismiss: () -> Unit) {
    val h = LocalHousehold.current
    val graph = AppGraph.get(LocalContext.current)
    val nav = LocalActions.current
    val scope = rememberCoroutineScope()
    val values = remember(record?.id) {
        mutableStateMapOf<String, String>().apply {
            spec.fields.forEach { f ->
                val v = record?.data?.get(f.key)
                put(f.key, when {
                    v == null -> ""
                    f is Field.Date -> record.t(f.key)?.atZone(h.zone)?.let { if (f.withTime) it.toLocalDateTime().toString().take(16) else it.toLocalDate().toString() } ?: ""
                    f is Field.Amount -> (v as? Number)?.let { Money.toInput(it.toLong(), h.currency) } ?: ""
                    f is Field.Toggle -> v.toString()
                    else -> v.toString()
                })
            }
        }
    }
    var tried by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    fun error(f: Field): String? {
        val v = values[f.key].orEmpty()
        if (v.isBlank()) return if (!f.optional && tried) "Required" else null
        return when (f) {
            is Field.Date -> if ((if (f.withTime) runCatching { LocalDateTime.parse(v) } else runCatching { LocalDate.parse(v) }).isFailure) if (f.withTime) "Use YYYY-MM-DDTHH:MM" else "Use YYYY-MM-DD" else null
            is Field.Amount -> if (Money.parse(v, h.currency) == null) "Not a valid amount" else null
            is Field.Number -> if (v.toBigDecimalOrNull() == null) "Enter a number" else null
            else -> null
        }
    }
    FormSheet(if (record == null) "Add to ${spec.title}" else (spec.rowTitle(record)), onDismiss) {
        spec.fields.forEach { f ->
            when (f) {
                is Field.Choice -> {
                    Text(f.label, style = HomeHubTheme.type.label, color = HomeHubTheme.colors.ink)
                    SegmentedFilter(f.options.map { it.second }, f.options.indexOfFirst { it.first == values[f.key] }.coerceAtLeast(0), { values[f.key] = f.options[it].first })
                    if (values[f.key].isNullOrBlank()) values[f.key] = f.options.first().first
                }
                is Field.Toggle -> SegmentedFilter(listOf("No", "Yes"), if (values[f.key] == "true") 1 else 0, { values[f.key] = (it == 1).toString() }).also { Text(f.label, style = HomeHubTheme.type.caption, color = HomeHubTheme.colors.inkSecondary) }
                is Field.Text -> HomeHubTextField(f.label, values[f.key].orEmpty(), { values[f.key] = it }, optional = f.optional, singleLine = !f.multiline, minLines = if (f.multiline) 3 else 1, error = error(f))
                is Field.Date -> HomeHubTextField(f.label, values[f.key].orEmpty(), { values[f.key] = it }, optional = f.optional, placeholder = if (f.withTime) "2026-11-21T17:30" else "2026-11-21", error = error(f))
                is Field.Amount -> HomeHubTextField("${f.label} (${h.currency})", values[f.key].orEmpty(), { values[f.key] = it }, optional = f.optional, keyboardType = KeyboardType.Decimal, error = error(f))
                is Field.Number -> HomeHubTextField(f.label, values[f.key].orEmpty(), { values[f.key] = it }, optional = f.optional, keyboardType = KeyboardType.Decimal, error = error(f))
            }
        }
        HomeHubButton(if (record == null) "Save" else "Save changes", {
            tried = true
            if (spec.fields.any { error(it) != null || (!it.optional && values[it.key].isNullOrBlank()) }) return@HomeHubButton
            val data = spec.fields.associate { f ->
                val v = values[f.key].orEmpty().trim()
                f.key to when {
                    v.isBlank() -> if (f is Field.Toggle) false else null
                    f is Field.Date -> Timestamp(Date.from((if (f.withTime) LocalDateTime.parse(v) else LocalDate.parse(v).atTime(9, 0)).atZone(h.zone).toInstant()))
                    f is Field.Amount -> Money.parse(v, h.currency)
                    f is Field.Number -> v.toBigDecimal().toDouble()
                    f is Field.Toggle -> v == "true"
                    else -> v
                }
            }
            busy = true
            scope.launch {
                runCatching {
                    if (record == null) graph.data.create(h.hid, spec.collection, spec.defaults + data) else graph.data.update(h.hid, spec.collection, record.id, data)
                }.onSuccess { onDismiss(); nav.toast("Saved") }.onFailure { nav.toast(it.message ?: "Couldn't save") }
                busy = false
            }
        }, Modifier.fillMaxWidth(), loading = busy)
        if (record != null && spec.canDelete(h)) HomeHubButton("Delete", { confirmDelete = true }, Modifier.fillMaxWidth(), kind = ButtonKind.Tertiary)
    }
    if (confirmDelete && record != null) ConfirmationDialog("Delete this record?", "It will be removed for everyone in the household. This can't be undone.", "Delete", {
        scope.launch { runCatching { graph.data.delete(h.hid, spec.collection, record.id) }.onSuccess { confirmDelete = false; onDismiss() }.onFailure { nav.toast(it.message ?: "Couldn't delete") } }
    }, { confirmDelete = false }, destructive = true)
}

private fun memberOptions(h: HouseholdContext) = listOf("" to "Unassigned") + h.members.map { it.uid to it.displayName.substringBefore(' ') }

@Composable
fun CleaningScreen() {
    val h = LocalHousehold.current
    RecordListScreen(RecordSpec(
        "Cleaning", "cleaningSchedules", Icons.Outlined.CleaningServices, "No cleaning routines", "Set up room-wise routines — daily wipe-downs to seasonal deep cleans.",
        fields = listOf(
            Field.Text("title", "Routine"), Field.Text("roomName", "Room"),
            Field.Choice("frequency", "How often", listOf("daily" to "Daily", "weekly" to "Weekly", "monthly" to "Monthly", "seasonal" to "Seasonal")),
            Field.Choice("assigneeUid", "Assigned to", memberOptions(h), optional = true), Field.Date("nextDueAt", "Next due", optional = true),
            Field.Toggle("deepClean", "Deep-cleaning plan"),
        ),
        query = { q, ctx -> if (ctx.role.isAdultPlus) q else q.whereEqualTo("assigneeUid", ctx.uid) },
        groupBy = { (it.s("frequency") ?: "other").replaceFirstChar { c -> c.uppercase() } },
        rowSubtitle = { r, ctx -> listOfNotNull(r.s("roomName"), ctx.nameOf(r.s("assigneeUid")), r.t("nextDueAt")?.let { Dates.relative(it, ctx.zone) }, r.t("lastCompletedAt")?.let { "last done ${Dates.shortDate(it, ctx.zone)}" }).joinToString(" · ") },
        badge = { r, _ -> if (r.b("deepClean")) "Deep clean" to Tone.Info else null },
        defaults = mapOf("visibleToChildren" to false, "lastCompletedAt" to null),
    ))
}

@Composable
fun MaintenanceScreen() = RecordListScreen(RecordSpec(
    "Maintenance", "maintenanceRecords", Icons.Outlined.Build, "No maintenance records", "Log repairs and services. The assistant can propose dates — booking a provider always needs your approval.",
    fields = listOf(
        Field.Text("title", "Issue or service"), Field.Text("assetName", "Asset", optional = true),
        Field.Choice("status", "Status", listOf("requested" to "Requested", "scheduled" to "Scheduled", "in_progress" to "In progress", "done" to "Done", "cancelled" to "Cancelled")),
        Field.Choice("priority", "Priority", listOf("normal" to "Normal", "high" to "High", "urgent" to "Urgent", "low" to "Low")),
        Field.Date("nextDueAt", "Next due", optional = true), Field.Text("providerName", "Provider", optional = true), Field.Amount("costMinor", "Cost"),
        Field.Text("description", "Notes", optional = true, multiline = true),
    ),
    query = { q, ctx -> if (ctx.role.isAdultPlus) q else q.whereEqualTo("assigneeUid", ctx.uid) },
    canRead = { it.role.isAdultPlus || it.role.id == "staff" },
    groupBy = { when (it.s("status")) { "done", "cancelled" -> "History"; else -> "Open" } },
    rowSubtitle = { r, ctx -> listOfNotNull(r.s("assetName"), r.s("providerName"), r.t("nextDueAt")?.let { "next ${Dates.shortDate(it, ctx.zone)}" }, r.l("costMinor")?.let { Money.format(it, ctx.currency) }).joinToString(" · ").ifEmpty { null } },
    badge = { r, _ -> when (r.s("status")) { "requested" -> "Requested" to Tone.Info; "scheduled" -> "Scheduled" to Tone.Brand; "in_progress" -> "In progress" to Tone.Warning; "done" -> "Done" to Tone.Success; else -> null } },
    defaults = mapOf("assigneeUid" to null, "underWarranty" to null, "preferredDates" to emptyList<String>()),
))

@Composable
fun InventoryScreen() = RecordListScreen(RecordSpec(
    "Inventory", "inventoryItems", Icons.Outlined.Weekend, "Nothing in your inventory", "Track furniture, appliances, electronics and valuables with warranty dates.",
    fields = listOf(
        Field.Text("name", "Item"), Field.Choice("category", "Category", listOf("Furniture" to "Furniture", "Appliance" to "Appliance", "Electronics" to "Electronics", "Kitchen" to "Kitchen", "Valuables" to "Valuables", "Other" to "Other")),
        Field.Text("location", "Location", optional = true), Field.Number("quantity", "Quantity"), Field.Date("purchaseDate", "Purchased", optional = true),
        Field.Date("warrantyExpiresAt", "Warranty until", optional = true),
    ),
    canRead = { it.role.isAdultPlus },
    groupBy = { it.s("category") ?: "Other" },
    rowSubtitle = { r, ctx -> listOfNotNull(r.s("location"), r.d("quantity")?.let { "×${Dates.qty(it)}" }, r.t("warrantyExpiresAt")?.let { "warranty to ${Dates.shortDate(it, ctx.zone)}" }).joinToString(" · ").ifEmpty { null } },
    badge = { r, _ -> r.t("warrantyExpiresAt")?.let { if (it.isBefore(java.time.Instant.now())) "Out of warranty" to Tone.Neutral else null } },
))

@Composable
fun CalendarScreen() {
    val h = LocalHousehold.current
    val today = LocalDate.now(h.zone)
    RecordListScreen(RecordSpec(
        "Calendar", "events", Icons.Outlined.Event, "Nothing scheduled", "Add appointments, birthdays, school events and more.",
        fields = listOf(
            Field.Text("title", "Event"), Field.Date("startAt", "Starts", withTime = true), Field.Date("endAt", "Ends", withTime = true),
            Field.Choice("category", "Type", listOf("appointment" to "Appointment", "birthday" to "Birthday", "anniversary" to "Anniversary", "school" to "School", "social" to "Social", "bill" to "Bill", "other" to "Other")),
            Field.Text("location", "Where", optional = true), Field.Toggle("staffVisible", "Visible to staff"),
        ),
        query = { q, ctx ->
            val base = when (ctx.role.id) { "child" -> q.whereEqualTo("visibility", "household"); "staff" -> q.whereEqualTo("staffVisible", true); else -> q }
            base.whereGreaterThanOrEqualTo("startAt", Timestamp(Date.from(today.atStartOfDay(ctx.zone).toInstant()))).orderBy("startAt").limit(100)
        },
        canWrite = { it.role.isAdultPlus || it.role.id == "child" },
        groupBy = { r -> r.t("startAt")?.atZone(h.zone)?.toLocalDate()?.let { Dates.longDate(it) } ?: "Undated" },
        rowSubtitle = { r, ctx -> listOfNotNull(r.t("startAt")?.let { Dates.time(it, ctx.zone) }, r.s("category")?.replaceFirstChar { it.uppercase() }, r.s("location")).joinToString(" · ") },
        defaults = mapOf("visibility" to "household", "attendeeUids" to emptyList<String>(), "reminderMinutes" to 60),
    ))
}

@Composable
fun DocumentsScreen() = RecordListScreen(documentsSpec(LocalHousehold.current))

private fun documentsSpec(h: HouseholdContext) = (RecordSpec(
    "Documents", "documents", Icons.Outlined.Description, "No documents yet", "Keep agreements, insurance, warranties and receipts with expiry reminders.",
    fields = listOf(
        Field.Text("title", "Title"), Field.Choice("category", "Category", listOf("Property" to "Property", "Insurance" to "Insurance", "Warranty" to "Warranty", "Receipt" to "Receipt", "Agreement" to "Agreement", "Identity" to "Identity", "Other" to "Other")),
        Field.Date("expiresAt", "Expires", optional = true), Field.Toggle("restricted", "Restricted (only people you allow, plus managers)"),
    ),
    canRead = { it.role.isAdultPlus },
    groupBy = { it.s("category") ?: "Other" },
    rowSubtitle = { r, ctx -> listOfNotNull(r.s("fileType")?.uppercase(), r.t("updatedAt")?.let { "updated ${Dates.shortDate(it, ctx.zone)}" }, r.t("expiresAt")?.let { "expires ${Dates.shortDate(it, ctx.zone)}" }).joinToString(" · ").ifEmpty { null } },
    badge = { r, _ -> if (r.b("restricted")) "Restricted" to Tone.Warning else null },
    // Metadata record; the file itself lives under the same household path in Cloud Storage (rules check both).
    defaults = mapOf("allowedUids" to emptyList<String>(), "fileType" to null, "storagePath" to "households/${h.hid}/documents/unattached"),
))

@Composable
fun NotesScreen() {
    val h = LocalHousehold.current
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val notes by remember(h.hid) { graph.offline.notes(h.hid) }.collectAsStateWithLifecycle(emptyList())
    var query by remember { mutableStateOf("") }
    var editing by remember { mutableStateOf<LocalNote?>(null) }
    var creating by remember { mutableStateOf(false) }
    val shown = notes.filter { query.isBlank() || it.title.contains(query, true) || it.body.contains(query, true) }
    ListScreen("Notes", fabIcon = Icons.Outlined.Add, fabLabel = "New note", onFab = { creating = true }) {
        item { com.e404.homehub.ui.components.HomeHubSearchField(query, { query = it }, "Search notes", Modifier.padding(vertical = 8.dp)) }
        if (shown.isEmpty()) item { EmptyState(Icons.Outlined.StickyNote2, if (query.isBlank()) "No notes yet" else "No matching notes", "Shared notes are visible to the household; private notes only to you. Notes work offline.") }
        listOf("household" to "Shared", "private" to "Private").forEach { (vis, label) ->
            val rows = shown.filter { it.visibility == vis }
            if (rows.isNotEmpty()) item {
                Column {
                    SectionHeader(label)
                    GroupedList { rows.forEachIndexed { i, n -> if (i > 0) Divider(); HomeHubListTile(n.title.ifBlank { "Untitled" }, subtitle = n.body.take(80), leadingIcon = Icons.Outlined.StickyNote2, onClick = { editing = n }, trailing = { PendingSyncIndicator(n.pendingSync) }) } }
                }
            }
        }
    }
    if (creating || editing != null) {
        val n = editing
        var title by remember(n?.id) { mutableStateOf(n?.title ?: "") }
        var body by remember(n?.id) { mutableStateOf(n?.body ?: "") }
        var vis by remember(n?.id) { mutableStateOf(n?.visibility ?: "household") }
        val mine = n == null || n.createdBy == h.uid
        FormSheet(if (n == null) "New note" else "Edit note", { creating = false; editing = null }) {
            HomeHubTextField("Title", title, { title = it })
            HomeHubTextField("Note", body, { body = it }, singleLine = false, minLines = 5)
            if (n == null) SegmentedFilter(listOf("Shared with household", "Private to me"), if (vis == "household") 0 else 1, { vis = if (it == 0) "household" else "private" })
            HomeHubButton("Save", { scope.launch { graph.offline.saveNote(h.hid, h.uid, n?.id, title.ifBlank { "Untitled" }, body, vis, null); creating = false; editing = null } }, Modifier.fillMaxWidth(), enabled = mine || h.role.isAdultPlus)
            if (n != null && mine) HomeHubButton("Delete note", { scope.launch { graph.offline.deleteNote(h.hid, n.id); editing = null } }, Modifier.fillMaxWidth(), kind = ButtonKind.Tertiary)
        }
    }
}
