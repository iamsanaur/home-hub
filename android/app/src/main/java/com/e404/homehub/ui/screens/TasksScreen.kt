package com.e404.homehub.ui.screens

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.e404.homehub.AppGraph
import com.e404.homehub.data.model.Priority
import com.e404.homehub.data.model.Task
import com.e404.homehub.ui.LocalActions
import com.e404.homehub.ui.LocalHousehold
import com.e404.homehub.ui.components.ButtonKind
import com.e404.homehub.ui.components.ConfirmationDialog
import com.e404.homehub.ui.components.Divider
import com.e404.homehub.ui.components.EmptyState
import com.e404.homehub.ui.components.GroupedList
import com.e404.homehub.ui.components.HomeHubButton
import com.e404.homehub.ui.components.HomeHubTextField
import com.e404.homehub.ui.components.SegmentedFilter
import com.e404.homehub.ui.components.TaskRow
import com.e404.homehub.ui.theme.HomeHubTheme
import com.e404.homehub.ui.util.Dates
import com.google.firebase.Timestamp
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneOffset
import java.util.Date

private val FILTERS = listOf("Today", "Upcoming", "Mine", "All")

@Composable
fun TasksScreen() {
    val h = LocalHousehold.current
    val nav = LocalActions.current
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val tasks by remember(h.hid) { graph.offline.tasks(h.hid) }.collectAsStateWithLifecycle(emptyList())
    var filter by rememberSaveable { mutableIntStateOf(if (h.role.isAdultPlus) 0 else 2) }
    var editing by remember { mutableStateOf<Task?>(null) }
    var creating by remember { mutableStateOf(false) }
    val now = Instant.now()
    val endToday = now.atZone(h.zone).toLocalDate().plusDays(1).atStartOfDay(h.zone).toInstant()
    val shown = when (filter) {
        0 -> tasks.filter { !it.isDone && it.dueAt != null && it.dueAt.isBefore(endToday) }
        1 -> tasks.filter { !it.isDone && (it.dueAt == null || !it.dueAt.isBefore(endToday)) }
        2 -> tasks.filter { it.assigneeUid == h.uid && !it.isDone }
        else -> tasks
    }
    val canCreate = h.role.isAdultPlus || h.role.id == "child"

    fun toggle(task: Task, done: Boolean) = scope.launch {
        graph.offline.setTaskDone(h.hid, h.uid, task.id, done)
        if (done) {
            val r = nav.snackbar.showSnackbar("Completed “${task.title}”", actionLabel = "Undo", duration = SnackbarDuration.Short)
            if (r == SnackbarResult.ActionPerformed) graph.offline.setTaskDone(h.hid, h.uid, task.id, false)
        }
    }

    ListScreen("Tasks", subtitle = "${tasks.count { !it.isDone }} open", fabIcon = if (canCreate) Icons.Outlined.Add else null, fabLabel = "New task", onFab = { creating = true }) {
        item { SegmentedFilter(FILTERS, filter, { filter = it }, Modifier.padding(vertical = 8.dp)) }
        if (shown.isEmpty()) item {
            EmptyState(Icons.Outlined.Checklist, if (filter == 0) "Nothing due today" else "No tasks here", "Tasks you add — or the assistant creates — appear here.",
                actionLabel = if (canCreate) "Add a task" else null, onAction = { creating = true })
        } else item {
            GroupedList {
                shown.forEachIndexed { i, task ->
                    if (i > 0) Divider()
                    TaskRow(task, h.zone, h.nameOf(task.assigneeUid), { toggle(task, it) }, { if (h.role.isAdultPlus) editing = task })
                }
            }
        }
    }
    if (creating || editing != null) TaskEditor(editing, onDismiss = { creating = false; editing = null })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TaskEditor(task: Task?, onDismiss: () -> Unit) {
    val h = LocalHousehold.current
    val nav = LocalActions.current
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val c = HomeHubTheme.colors
    var title by rememberSaveable { mutableStateOf(task?.title ?: "") }
    var notes by rememberSaveable { mutableStateOf(task?.notes ?: "") }
    var category by rememberSaveable { mutableStateOf(task?.category ?: "") }
    var priority by remember { mutableStateOf(task?.priority ?: Priority.Normal) }
    var assignee by remember { mutableStateOf(task?.assigneeUid ?: if (h.role.id == "child") h.uid else null) }
    var dueDate by remember { mutableStateOf(task?.dueAt?.atZone(h.zone)?.toLocalDate()) }
    var dueTime by rememberSaveable { mutableStateOf(task?.dueAt?.atZone(h.zone)?.toLocalTime()?.toString()?.take(5) ?: "18:00") }
    var repeat by remember { mutableStateOf<String?>(null) }
    var pickDate by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var tried by remember { mutableStateOf(false) }
    val timeValid = runCatching { LocalTime.parse(dueTime) }.isSuccess

    FormSheet(if (task == null) "New task" else "Edit task", onDismiss) {
        HomeHubTextField("Title", title, { title = it }, error = if (tried && title.isBlank()) "Give the task a title." else null)
        HomeHubTextField("Notes", notes, { notes = it }, optional = true, singleLine = false, minLines = 2)
        Text("Priority", style = HomeHubTheme.type.label, color = c.ink)
        SegmentedFilter(Priority.entries.map { it.label }, priority.ordinal, { priority = Priority.entries[it] })
        if (h.role.isAdultPlus) {
            Text("Assign to", style = HomeHubTheme.type.label, color = c.ink)
            val options = listOf<Pair<String?, String>>(null to "Anyone") + h.members.map { it.uid to it.displayName.substringBefore(' ') }
            SegmentedFilter(options.map { it.second }, options.indexOfFirst { it.first == assignee }.coerceAtLeast(0), { assignee = options[it].first })
        }
        Text("Due", style = HomeHubTheme.type.label, color = c.ink)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            HomeHubButton(dueDate?.let { Dates.longDate(it) } ?: "Pick a date", { pickDate = true }, kind = ButtonKind.Secondary)
            if (dueDate != null) TextButton({ dueDate = null }) { Text("Clear", color = c.brand) }
        }
        if (dueDate != null) HomeHubTextField("Time (24h)", dueTime, { dueTime = it }, error = if (!timeValid) "Use HH:MM, e.g. 18:30" else null)
        if (task == null && dueDate != null) {
            Text("Repeat", style = HomeHubTheme.type.label, color = c.ink)
            val reps = listOf(null to "Never", "daily" to "Daily", "weekly" to "Weekly", "monthly" to "Monthly")
            SegmentedFilter(reps.map { it.second }, reps.indexOfFirst { it.first == repeat }, { repeat = reps[it].first })
            if (repeat != null) Text("When you complete it, HomeHub schedules the next one automatically.", style = HomeHubTheme.type.caption, color = c.inkSecondary)
        }
        HomeHubTextField("Category", category, { category = it }, optional = true, placeholder = "e.g. Kitchen, School, Finance")
        HomeHubButton(if (task == null) "Add task" else "Save changes", {
            tried = true
            if (title.isBlank() || (dueDate != null && !timeValid)) return@HomeHubButton
            val due = dueDate?.atTime(LocalTime.parse(dueTime))?.atZone(h.zone)?.toInstant()
            scope.launch {
                if (task == null) graph.offline.createTask(h.hid, title, notes, priority, due, assignee, category.ifBlank { null }, repeat)
                else graph.offline.updateTask(h.hid, task.id, mapOf("title" to title.trim(), "notes" to notes.ifBlank { null }, "priority" to priority.id,
                    "dueAt" to due?.let { Timestamp(Date.from(it)) }, "assigneeUid" to assignee, "category" to category.ifBlank { null }))
                onDismiss()
                nav.toast(if (task == null) "Task added" else "Task updated")
            }
        }, Modifier.fillMaxWidth())
        if (task != null) TaskComments(task.id)
        if (task != null && (h.role.isManager || h.role.isAdultPlus)) HomeHubButton("Delete task", { confirmDelete = true }, Modifier.fillMaxWidth(), kind = ButtonKind.Tertiary)
    }
    if (pickDate) {
        val state = rememberDatePickerState(initialSelectedDateMillis = (dueDate ?: LocalDate.now(h.zone)).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        DatePickerDialog({ pickDate = false }, confirmButton = {
            TextButton({ state.selectedDateMillis?.let { dueDate = Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate() }; pickDate = false }) { Text("Set date", color = c.brand) }
        }, dismissButton = { TextButton({ pickDate = false }) { Text("Cancel") } }) { DatePicker(state) }
    }
    if (confirmDelete && task != null) ConfirmationDialog("Delete task?", "“${task.title}” will be removed for everyone in the household.", "Delete",
        { scope.launch { graph.offline.deleteTask(h.hid, task.id); confirmDelete = false; onDismiss(); nav.toast("Task deleted") } }, { confirmDelete = false }, destructive = true)
}

