package com.e404.homehub.ui.screens

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Kitchen
import androidx.compose.material.icons.outlined.ArrowForward
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.CloudSync
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.ReceiptLong
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material.icons.outlined.UnfoldMore
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.e404.homehub.AppGraph
import com.e404.homehub.data.model.Bill
import com.e404.homehub.data.model.PantryItem
import com.e404.homehub.data.model.Record
import com.e404.homehub.data.model.Txn
import com.e404.homehub.data.repo.Loadable
import com.e404.homehub.ui.LocalActions
import com.e404.homehub.ui.LocalHousehold
import com.e404.homehub.ui.Routes
import com.e404.homehub.ui.components.BillRow
import com.e404.homehub.ui.components.BudgetSummary
import com.e404.homehub.ui.components.ButtonKind
import com.e404.homehub.ui.components.Divider
import com.e404.homehub.ui.components.GroupedList
import com.e404.homehub.ui.components.HomeHubButton
import com.e404.homehub.ui.components.HomeHubCard
import com.e404.homehub.ui.components.HomeHubIconButton
import com.e404.homehub.ui.components.HomeHubListTile
import com.e404.homehub.ui.components.SectionHeader
import com.e404.homehub.ui.components.StatusBadge
import com.e404.homehub.ui.components.TaskRow
import com.e404.homehub.ui.components.Tone
import com.e404.homehub.ui.screenPadding
import com.e404.homehub.ui.theme.HomeHubTheme
import com.e404.homehub.ui.theme.Radius
import com.e404.homehub.ui.theme.Space
import com.e404.homehub.ui.util.Dates
import com.google.firebase.Timestamp
import kotlinx.coroutines.launch
import java.time.Instant
import java.util.Date

private val SECTIONS = listOf("tasks" to "Tasks due", "bills" to "Bills", "calendar" to "Calendar", "pantry" to "Shopping & pantry", "budget" to "Budget", "care" to "Cleaning & maintenance", "activity" to "Recent activity")

private fun sectionPrefs(ctx: Context) = ctx.getSharedPreferences("homehub_dashboard", Context.MODE_PRIVATE)

@Composable
fun HomeScreen() {
    val h = LocalHousehold.current
    val nav = LocalActions.current
    val context = LocalContext.current
    val graph = AppGraph.get(context)
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    val scope = rememberCoroutineScope()
    val now = remember { Instant.now() }
    val today = remember { now.atZone(h.zone).toLocalDate() }
    val endOfToday = remember { today.plusDays(1).atStartOfDay(h.zone).toInstant() }

    val tasks by remember(h.hid) { graph.offline.tasks(h.hid) }.collectAsStateWithLifecycle(emptyList())
    val pendingSync by graph.database.dao().pendingCount(h.hid).collectAsStateWithLifecycle(0)
    val bills by remember(h.hid, h.canFinance) {
        if (h.canFinance) graph.data.observe(h.hid, "bills", { it.whereLessThanOrEqualTo("nextDueAt", Timestamp(Date.from(now.plusSeconds(7 * 86400)))).orderBy("nextDueAt") }, Bill::from)
        else kotlinx.coroutines.flow.flowOf(Loadable.Ready(emptyList()))
    }.collectAsStateWithLifecycle(Loadable.Loading)
    val events by remember(h.hid) {
        graph.data.records(h.hid, "events") { q ->
            val base = when { h.role.id == "child" -> q.whereEqualTo("visibility", "household"); h.role.id == "staff" -> q.whereEqualTo("staffVisible", true); else -> q }
            base.whereGreaterThanOrEqualTo("startAt", Timestamp(Date.from(today.atStartOfDay(h.zone).toInstant()))).whereLessThan("startAt", Timestamp(Date.from(today.plusDays(3).atStartOfDay(h.zone).toInstant()))).orderBy("startAt")
        }
    }.collectAsStateWithLifecycle(Loadable.Loading)
    val pantry by remember(h.hid) { graph.data.observe(h.hid, "pantryItems", { it.whereEqualTo("lowStock", true) }, PantryItem::from) }.collectAsStateWithLifecycle(Loadable.Loading)
    val txns by remember(h.hid, h.canFinance) {
        if (h.canFinance) graph.data.observe(h.hid, "transactions", { it.whereGreaterThanOrEqualTo("occurredAt", Timestamp(Date.from(today.withDayOfMonth(1).atStartOfDay(h.zone).toInstant()))) }, Txn::from)
        else kotlinx.coroutines.flow.flowOf(Loadable.Ready(emptyList()))
    }.collectAsStateWithLifecycle(Loadable.Loading)
    val budgets by remember(h.hid, h.canFinance) {
        if (h.canFinance) graph.data.records(h.hid, "budgets") { it.whereEqualTo("period", today.toString().substring(0, 7)) } else kotlinx.coroutines.flow.flowOf(Loadable.Ready(emptyList()))
    }.collectAsStateWithLifecycle(Loadable.Loading)
    val maintenance by remember(h.hid, h.role) {
        if (h.role.isAdultPlus) graph.data.records(h.hid, "maintenanceRecords") { it.whereIn("status", listOf("requested", "scheduled", "in_progress")) } else kotlinx.coroutines.flow.flowOf(Loadable.Ready(emptyList()))
    }.collectAsStateWithLifecycle(Loadable.Loading)
    val activity by remember(h.hid, h.role) {
        if (h.role.isManager) graph.data.records(h.hid, "activityLogs") { it.orderBy("createdAt", com.google.firebase.firestore.Query.Direction.DESCENDING).limit(5) } else kotlinx.coroutines.flow.flowOf(Loadable.Ready(emptyList()))
    }.collectAsStateWithLifecycle(Loadable.Loading)
    val unread by remember(h.hid) { graph.data.records(h.hid, "notifications") { it.whereEqualTo("recipientUid", h.uid).whereEqualTo("readAt", null).limit(20) } }.collectAsStateWithLifecycle(Loadable.Loading)

    var visible by remember { mutableStateOf(SECTIONS.map { it.first }.filter { sectionPrefs(context).getBoolean(it, true) }.toSet()) }
    var customising by remember { mutableStateOf(false) }
    var switcher by remember { mutableStateOf(false) }
    var deletingActivity by remember { mutableStateOf<Record?>(null) }
    var clearingActivity by remember { mutableStateOf(false) }
    val profile by remember { graph.session.profile(h.uid) }.collectAsState(null)

    val open = tasks.filter { !it.isDone }
    val overdue = open.filter { it.dueAt != null && it.dueAt.isBefore(now) }
    val dueToday = open.filter { it.dueAt != null && !it.dueAt.isBefore(now) && it.dueAt.isBefore(endOfToday) }
    val billList = (bills as? Loadable.Ready)?.value.orEmpty().filter { it.active }
    val eventList = (events as? Loadable.Ready)?.value.orEmpty()
    val lowStock = (pantry as? Loadable.Ready)?.value.orEmpty()
    val spent = (txns as? Loadable.Ready)?.value.orEmpty().filter { it.type == "expense" && it.currency == h.currency }.sumOf { it.amountMinor }
    val income = (txns as? Loadable.Ready)?.value.orEmpty().filter { it.type == "income" && it.currency == h.currency }.sumOf { it.amountMinor }
    val limit = (budgets as? Loadable.Ready)?.value.orEmpty().firstOrNull { it.s("category") == "*" }?.l("limitMinor")

    // Today summary — computed locally from the same facts the deterministic server briefing uses.
    val summary = buildList {
        if (overdue.isNotEmpty()) add("${overdue.size} overdue")
        if (dueToday.isNotEmpty()) add("${dueToday.size} due today")
        val dueBills = billList.count { it.nextDueAt != null && it.nextDueAt.isBefore(now.plusSeconds(3 * 86400)) }
        if (dueBills > 0) add("$dueBills bill${if (dueBills > 1) "s" else ""} soon")
        if (eventList.isNotEmpty()) add("${eventList.size} event${if (eventList.size > 1) "s" else ""}")
        if (lowStock.isNotEmpty()) add("${lowStock.size} running low")
    }.joinToString(" · ").ifEmpty { "Nothing urgent today." }

    val unreadCount = (unread as? Loadable.Ready)?.value?.size ?: 0
    Column(Modifier.fillMaxSize().background(c.canvas)) {
        // Same header as iOS: actions in the glass capsule, large greeting below.
        HomeHubNavBar(actions = {
            HomeHubIconButton(if (unreadCount > 0) Icons.Outlined.NotificationsActive else Icons.Outlined.Notifications, if (unreadCount > 0) "Notifications, $unreadCount unread" else "Notifications", { nav.go(Routes.NOTIFICATIONS) }, tint = c.brand)
            HomeHubIconButton(Icons.Outlined.Settings, "Settings", { nav.go(Routes.SETTINGS) }, tint = c.brand)
        })
        LazyColumn(Modifier.fillMaxSize(), contentPadding = screenPadding(), horizontalAlignment = Alignment.CenterHorizontally) {
            item {
                Column(Modifier.widthIn(max = 760.dp).fillMaxWidth()) {
                    Text("${Dates.greeting(now, h.zone)}, ${h.me?.displayName?.substringBefore(' ') ?: ""}", style = t.screenTitle, color = c.ink, modifier = Modifier.padding(top = Space.xs).semantics { heading() })
                    Text(today.format(java.time.format.DateTimeFormatter.ofPattern("EEEE, d MMMM yyyy")), style = t.body, color = c.inkSecondary, modifier = Modifier.padding(top = Space.xxs))
                    Box {
                        Row(
                            Modifier.padding(top = Space.xxs).heightIn(min = 40.dp).clickable(role = androidx.compose.ui.semantics.Role.Button, onClickLabel = "Switch household") { switcher = true },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Outlined.UnfoldMore, null, tint = c.brand, modifier = Modifier.size(20.dp))
                            Spacer(Modifier.width(Space.xs))
                            Text(h.household.name, style = t.cardTitle.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Medium), color = c.brand)
                        }
                        DropdownMenu(switcher, { switcher = false }) {
                            profile?.memberships?.forEach { (id, pair) ->
                                DropdownMenuItem({ Text(pair.first + if (id == h.hid) "  ✓" else "") }, { switcher = false; nav.vm.switchHousehold(id) })
                            }
                        }
                    }
                    if (pendingSync > 0) {
                        Row(Modifier.padding(top = 4.dp).clip(RoundedCornerShape(50)).background(c.surfaceSubtle).padding(horizontal = 10.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.CloudSync, null, tint = c.inkSecondary, modifier = Modifier.size(14.dp))
                            Text("  $pendingSync change${if (pendingSync > 1) "s" else ""} waiting to sync", style = t.caption, color = c.inkSecondary)
                        }
                    }
                    Spacer(Modifier.height(Space.md))
                    // Today + one prominent next action.
                    HomeHubCard {
                        Text("Today", style = t.label, color = c.inkSecondary)
                        Text(summary, style = t.sectionTitle, color = c.ink)
                        val next = overdue.firstOrNull() ?: dueToday.firstOrNull()
                        if (next != null) {
                            Spacer(Modifier.height(Space.md))
                            Text("Next up", style = t.caption, color = c.inkSecondary)
                            Text(next.title, style = t.cardTitle, color = c.ink)
                            Spacer(Modifier.height(Space.sm))
                            HomeHubButton("Mark done", { scope.launch { graph.offline.setTaskDone(h.hid, h.uid, next.id, true); nav.toast("Done: ${next.title}") } }, Modifier.fillMaxWidth())
                        } else {
                            Spacer(Modifier.height(Space.sm))
                            HomeHubButton("Ask HomeHub to plan the week", { nav.go("${Routes.AI}/Prepare everything for next week.") }, Modifier.fillMaxWidth(), kind = ButtonKind.Secondary, icon = Icons.Outlined.AutoAwesome)
                        }
                    }
                }
            }
            item { com.e404.homehub.ui.components.NotificationPrompt(Modifier.widthIn(max = 840.dp).fillMaxWidth().padding(top = Space.md)) }
            if ("tasks" in visible) item {
                Column(Modifier.widthIn(max = 840.dp).fillMaxWidth()) {
                    SectionHeader("Tasks due", action = "All tasks", onAction = { nav.go(Routes.TASKS) })
                    val shown = (overdue + dueToday).take(5)
                    if (shown.isEmpty()) Text("No tasks due today.", style = t.bodyCompact, color = c.inkSecondary)
                    else GroupedList {
                        shown.forEachIndexed { i, task ->
                            if (i > 0) Divider()
                            TaskRow(task, h.zone, h.nameOf(task.assigneeUid), { done -> scope.launch { graph.offline.setTaskDone(h.hid, h.uid, task.id, done) } }, { nav.go(Routes.TASKS) })
                        }
                    }
                }
            }
            if ("bills" in visible && h.canFinance) item {
                Column(Modifier.widthIn(max = 840.dp).fillMaxWidth()) {
                    SectionHeader("Bills this week", action = "Bills", onAction = { nav.go(Routes.BILLS) })
                    if (billList.isEmpty()) Text("No bills due in the next 7 days.", style = t.bodyCompact, color = c.inkSecondary)
                    else GroupedList { billList.take(4).forEachIndexed { i, b -> if (i > 0) Divider(); BillRow(b, h.zone) { nav.go(Routes.BILLS) } } }
                }
            }
            if ("calendar" in visible) item {
                Column(Modifier.widthIn(max = 840.dp).fillMaxWidth()) {
                    SectionHeader("Coming up", action = "Calendar", onAction = { nav.go(Routes.CALENDAR) })
                    if (eventList.isEmpty()) Text("Nothing on the calendar for the next 3 days.", style = t.bodyCompact, color = c.inkSecondary)
                    else GroupedList { eventList.take(4).forEachIndexed { i, e -> if (i > 0) Divider(); HomeHubListTile(e.s("title") ?: "Event", subtitle = e.t("startAt")?.let { Dates.relative(it, h.zone, now) }, leadingIcon = Icons.Outlined.Event) } }
                }
            }
            if ("pantry" in visible) item {
                Column(Modifier.widthIn(max = 840.dp).fillMaxWidth()) {
                    SectionHeader("Shopping & pantry", action = "Shopping", onAction = { nav.go(Routes.SHOPPING) })
                    // Same card as iOS: a standard row (tinted icon tile) inside a card, the whole card opens Pantry.
                    HomeHubCard(onClick = { nav.go(Routes.PANTRY) }, padding = androidx.compose.foundation.layout.PaddingValues(vertical = Space.sm)) {
                        HomeHubListTile(
                            if (lowStock.isEmpty()) "Pantry is stocked" else "${lowStock.size} item${if (lowStock.size > 1) "s" else ""} running low",
                            subtitle = if (lowStock.isEmpty()) null else lowStock.take(4).joinToString(", ") { it.name },
                            leadingIcon = Icons.Outlined.Kitchen,
                        )
                    }
                }
            }
            if ("budget" in visible && h.canFinance) item {
                Column(Modifier.widthIn(max = 840.dp).fillMaxWidth()) {
                    SectionHeader("Budget", action = "Finance", onAction = { nav.go(Routes.FINANCE) })
                    HomeHubCard { BudgetSummary(spent, limit, income, h.currency) }
                }
            }
            if ("care" in visible && h.role.isAdultPlus) item {
                Column(Modifier.widthIn(max = 840.dp).fillMaxWidth()) {
                    SectionHeader("Home care", action = "Maintenance", onAction = { nav.go(Routes.MAINTENANCE) })
                    val open = (maintenance as? Loadable.Ready)?.value.orEmpty()
                    GroupedList {
                        HomeHubListTile("Cleaning routines", subtitle = "Room-wise schedules", leadingIcon = Icons.Outlined.Tune, onClick = { nav.go(Routes.CLEANING) })
                        Divider()
                        HomeHubListTile(if (open.isEmpty()) "No open repairs" else "${open.size} open maintenance item${if (open.size > 1) "s" else ""}", subtitle = open.firstOrNull()?.s("title"), leadingIcon = Icons.Outlined.Build, onClick = { nav.go(Routes.MAINTENANCE) },
                            trailing = { if (open.any { it.s("priority") == "high" || it.s("priority") == "urgent" }) StatusBadge("High priority", Tone.Warning) })
                    }
                }
            }
            if ("activity" in visible && h.role.isManager) item {
                Column(Modifier.widthIn(max = 840.dp).fillMaxWidth()) {
                    val logs = (activity as? Loadable.Ready)?.value.orEmpty()
                    // Owners and administrators can delete entries; the security audit trail is separate and stays.
                    SectionHeader("Recent activity", action = if (logs.isNotEmpty()) "Clear" else null, onAction = { clearingActivity = true })
                    if (logs.isEmpty()) Text("No recent activity.", style = t.bodyCompact, color = c.inkSecondary)
                    else GroupedList { logs.forEachIndexed { i, r -> if (i > 0) Divider(); ActivityTile(r, h.nameOf(r.s("actorUid")) ?: "Someone", h.zone, onDelete = { deletingActivity = r }) } }
                }
            }
            item {
                Column(Modifier.widthIn(max = 840.dp).fillMaxWidth().padding(top = Space.lg)) {
                    HomeHubButton("Customise dashboard", { customising = true }, kind = ButtonKind.Tertiary, icon = Icons.Outlined.Tune)
                }
            }
        }
    }
    deletingActivity?.let { r ->
        com.e404.homehub.ui.components.ConfirmationDialog("Delete this entry?", "It's removed from Recent activity for everyone. The security audit trail keeps a record that it was deleted.", "Delete", destructive = true,
            onConfirm = { deletingActivity = null; scope.launch { runCatching { graph.gateway.call("DELETE", "/v1/households/${h.hid}/activity/${r.id}") }.onFailure { nav.toast(it.message ?: "Couldn't delete") } } },
            onDismiss = { deletingActivity = null })
    }
    if (clearingActivity) com.e404.homehub.ui.components.ConfirmationDialog("Clear recent activity?", "All entries are removed for everyone in ${h.household.name}. The security audit trail keeps a record that it was cleared.", "Clear", destructive = true,
        onConfirm = { clearingActivity = false; scope.launch { runCatching { graph.gateway.call("DELETE", "/v1/households/${h.hid}/activity") }.onSuccess { nav.toast("Activity cleared") }.onFailure { nav.toast(it.message ?: "Couldn't clear") } } },
        onDismiss = { clearingActivity = false })
    if (customising) FormSheet("Dashboard sections", { customising = false }) {
        SECTIONS.forEach { (id, label) ->
            Row(Modifier.fillMaxWidth().height(52.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(label, style = t.body, color = c.ink, modifier = Modifier.weight(1f))
                Switch(id in visible, { on ->
                    visible = if (on) visible + id else visible - id
                    sectionPrefs(context).edit().putBoolean(id, on).apply()
                }, colors = SwitchDefaults.colors(checkedTrackColor = c.brand))
            }
        }
    }
}

@Composable
fun ActivityTile(r: Record, actor: String, zone: java.time.ZoneId, onDelete: (() -> Unit)? = null) {
    val agent = r.s("actorKind") == "agent"
    val action = (r.s("action") ?: "").replace('.', ' ').replace('_', ' ')
    HomeHubListTile(
        "${if (agent) "Assistant (for $actor)" else actor}: $action",
        subtitle = r.t("createdAt")?.let { Dates.relative(it, zone) },
        leadingIcon = if (agent) Icons.Outlined.AutoAwesome else Icons.Outlined.ReceiptLong,
        trailing = onDelete?.let { del -> { HomeHubIconButton(Icons.Outlined.DeleteOutline, "Delete this activity entry", del, tint = HomeHubTheme.colors.inkTertiary) } },
        chevron = false,
    )
}

