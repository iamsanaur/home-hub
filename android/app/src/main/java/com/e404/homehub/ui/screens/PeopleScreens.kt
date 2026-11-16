package com.e404.homehub.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.CloudSync
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.Insights
import androidx.compose.material.icons.outlined.NotificationsNone
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.e404.homehub.AppGraph
import com.e404.homehub.data.model.AppNotification
import com.e404.homehub.data.model.Member
import com.e404.homehub.data.model.Money
import com.e404.homehub.data.model.Role
import com.e404.homehub.data.model.ScheduledJob
import com.e404.homehub.data.repo.Loadable
import com.e404.homehub.ui.LocalActions
import com.e404.homehub.ui.LocalHousehold
import com.e404.homehub.ui.Routes
import com.e404.homehub.ui.components.ApprovalCard
import com.e404.homehub.ui.components.ButtonKind
import com.e404.homehub.ui.components.ConfirmationDialog
import com.e404.homehub.ui.components.Divider
import com.e404.homehub.ui.components.EmptyState
import com.e404.homehub.ui.components.ErrorState
import com.e404.homehub.ui.components.GroupedList
import com.e404.homehub.ui.components.HomeHubButton
import com.e404.homehub.ui.components.HomeHubCard
import com.e404.homehub.ui.components.HomeHubIconButton
import com.e404.homehub.ui.components.HomeHubListTile
import com.e404.homehub.ui.components.HomeHubTextField
import com.e404.homehub.ui.components.LoadingSkeleton
import com.e404.homehub.ui.components.MemberAvatar
import com.e404.homehub.ui.components.ProgressRow
import com.e404.homehub.ui.components.SectionHeader
import com.e404.homehub.ui.components.SegmentedFilter
import com.e404.homehub.ui.components.StatusBadge
import com.e404.homehub.ui.components.Tone
import com.e404.homehub.ui.theme.HomeHubTheme
import com.e404.homehub.ui.theme.Space
import com.e404.homehub.ui.util.Dates
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.SetOptions
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

// ---------------- Family ----------------

@Composable
fun FamilyScreen() {
    val h = LocalHousehold.current
    val nav = LocalActions.current
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val c = HomeHubTheme.colors
    val tasks by remember(h.hid) { graph.offline.tasks(h.hid) }.collectAsStateWithLifecycle(emptyList())
    val invites by remember(h.hid, h.role) { if (h.role.isManager) graph.session.invitations(h.hid) else kotlinx.coroutines.flow.flowOf(emptyList()) }.collectAsStateWithLifecycle(emptyList())
    var inviting by remember { mutableStateOf(false) }
    var managing by remember { mutableStateOf<Member?>(null) }
    ListScreen("Family", subtitle = "${h.members.size} members", showBack = false, actions = { if (h.role.isManager) HomeHubIconButton(Icons.Outlined.PersonAdd, "Invite", { inviting = true }, tint = c.brand) }) {
        item {
            Column {
                SectionHeader("Members")
                GroupedList {
                    h.members.forEachIndexed { i, m ->
                        if (i > 0) Divider()
                        val open = tasks.count { it.assigneeUid == m.uid && !it.isDone }
                        Row(Modifier.fillMaxWidth().padding(horizontal = Space.md, vertical = Space.sm), verticalAlignment = Alignment.CenterVertically) {
                            MemberAvatar(m.initials, label = m.displayName)
                            Column(Modifier.weight(1f).padding(start = Space.sm)) {
                                Text(m.displayName + if (m.uid == h.uid) " (you)" else "", style = HomeHubTheme.type.cardTitle, color = c.ink)
                                Text("${m.role.label} · $open open task${if (open == 1) "" else "s"}" + permissionSummary(m), style = HomeHubTheme.type.caption, color = c.inkSecondary)
                            }
                            if (h.role.isManager && m.uid != h.uid && m.role != Role.Owner) HomeHubButton("Manage", { managing = m }, kind = ButtonKind.Tertiary)
                        }
                    }
                }
            }
        }
        if (invites.isNotEmpty()) item {
            Column {
                SectionHeader("Pending invitations")
                GroupedList {
                    invites.forEachIndexed { i, inv ->
                        if (i > 0) Divider()
                        HomeHubListTile((inv["displayName"] as? String) ?: (inv["email"] as? String) ?: "Invitation", subtitle = Role.of(inv["role"] as? String).label + " · awaiting acceptance",
                            trailing = { HomeHubButton("Revoke", { scope.launch { runCatching { graph.session.revokeInvitation(h.hid, inv["id"] as String) }.onFailure { nav.toast(it.message ?: "Couldn't revoke") } } }, kind = ButtonKind.Tertiary) })
                    }
                }
            }
        }
        item {
            Column {
                SectionHeader("Schedules")
                GroupedList {
                    HomeHubListTile("Family calendar", subtitle = "Appointments, birthdays, school", leadingIcon = Icons.Outlined.CalendarMonth, onClick = { nav.go(Routes.CALENDAR) })
                    Divider()
                    HomeHubListTile("Assignments", subtitle = "Who is doing what", leadingIcon = Icons.Outlined.Checklist, onClick = { nav.go(Routes.TASKS) })
                }
            }
        }
        item {
            HomeHubCard(Modifier.padding(top = Space.lg)) {
                Text("Privacy by role", style = HomeHubTheme.type.cardTitle, color = c.ink)
                Text("Staff see only their assigned work. Children see their own tasks and shared events. Finance and documents stay with permitted adults.", style = HomeHubTheme.type.bodyCompact, color = c.inkSecondary)
            }
        }
    }
    if (inviting) FormSheet("Invite to ${h.household.name}", { inviting = false }) { InviteForm(h.hid) }
    managing?.let { m ->
        var role by remember(m.uid) { mutableStateOf(m.role) }
        var finance by remember(m.uid) { mutableStateOf(m.financeAllowed) }
        var confirmRemove by remember { mutableStateOf(false) }
        var busy by remember { mutableStateOf(false) }
        FormSheet(m.displayName, { managing = null }) {
            RolePicker(role) { role = it }
            if (role == Role.Adult || role == Role.Admin) Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Can see household finance", style = HomeHubTheme.type.body, color = c.ink, modifier = Modifier.weight(1f))
                Switch(finance, { finance = it }, colors = SwitchDefaults.colors(checkedTrackColor = c.brand))
            }
            HomeHubButton("Save", {
                busy = true
                scope.launch {
                    runCatching {
                        if (role != m.role) graph.session.changeRole(h.hid, m.uid, role)
                        if ((role == Role.Adult || role == Role.Admin) && finance != m.financeAllowed) graph.session.setFinanceAccess(h.hid, m.uid, finance)
                    }.onSuccess { managing = null; nav.toast("Updated ${m.displayName}") }.onFailure { nav.toast(it.message ?: "Couldn't update") }
                    busy = false
                }
            }, Modifier.fillMaxWidth(), loading = busy)
            HomeHubButton("Remove from household", { confirmRemove = true }, Modifier.fillMaxWidth(), kind = ButtonKind.Tertiary)
        }
        if (confirmRemove) ConfirmationDialog("Remove ${m.displayName}?", "They'll lose access to ${h.household.name} immediately. Their completed work stays in the history.", "Remove", {
            scope.launch { runCatching { graph.session.removeMember(h.hid, m.uid) }.onSuccess { confirmRemove = false; managing = null }.onFailure { nav.toast(it.message ?: "Couldn't remove") } }
        }, { confirmRemove = false }, destructive = true)
    }
}

private fun permissionSummary(m: Member) = when (m.role) {
    Role.Owner, Role.Adult, Role.Admin -> if (m.financeAllowed) " · finance" else " · no finance"
    Role.Staff -> " · assigned work only"
    else -> ""
}

// ---------------- Insights ----------------

@Composable
fun InsightsScreen() {
    val h = LocalHousehold.current
    val graph = AppGraph.get(LocalContext.current)
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    var report by remember { mutableStateOf<Loadable<JsonObject>>(Loadable.Loading) }
    var usage by remember { mutableStateOf<JsonObject?>(null) }
    var reload by remember { mutableStateOf(0) }
    LaunchedEffect(h.hid, reload) {
        if (!h.role.isAdultPlus) { report = Loadable.Failed("Reports are available to adults in the household."); return@LaunchedEffect }
        report = Loadable.Loading
        report = runCatching { graph.agent.report(h.hid, "overview") }.fold({ Loadable.Ready(it) }, { Loadable.Failed(it.message ?: "Couldn't load reports") })
        if (h.role.isManager) usage = runCatching { graph.agent.usage(h.hid) }.getOrNull()
    }
    ListScreen("Insights", subtitle = "Last 30 days · recorded data", showBack = false) {
        when (val r = report) {
            Loadable.Loading -> item { LoadingSkeleton() }
            is Loadable.Failed -> item { ErrorState(r.message, onRetry = { reload++ }, offline = r.message.contains("offline", true)) }
            is Loadable.Ready -> {
                val o = r.value
                (o["finance"] as? JsonObject)?.let { f ->
                    item {
                        Column {
                            SectionHeader("Spending")
                            HomeHubCard {
                                val exp = f["expenseMinor"]?.jsonPrimitive?.longOrNull ?: 0
                                val inc = f["incomeMinor"]?.jsonPrimitive?.longOrNull ?: 0
                                Text("Spent ${Money.format(exp, h.currency)} · earned ${Money.format(inc, h.currency)}", style = t.cardTitle, color = c.ink)
                                Spacer(Modifier.height(Space.sm))
                                f["byCategory"]?.jsonArray?.take(6)?.forEach { el ->
                                    val cat = el.jsonObject["category"]?.jsonPrimitive?.contentOrNull ?: ""
                                    val amt = el.jsonObject["amountMinor"]?.jsonPrimitive?.longOrNull ?: 0
                                    ProgressRow(cat, Money.percent(amt, exp.coerceAtLeast(1)) / 100f, Money.format(amt, h.currency), modifier = Modifier.padding(vertical = 4.dp))
                                }
                            }
                        }
                    }
                }
                (o["tasks"] as? JsonObject)?.let { tk ->
                    item {
                        Column {
                            SectionHeader("Tasks")
                            val done = tk["completed"]?.jsonPrimitive?.longOrNull ?: 0
                            val onTime = tk["onTime"]?.jsonPrimitive?.longOrNull ?: 0
                            HomeHubCard {
                                Text("$done completed · ${tk["openNow"]?.jsonPrimitive?.contentOrNull ?: "0"} open now", style = t.cardTitle, color = c.ink)
                                if (done > 0) ProgressRow("On time", onTime.toFloat() / done, "${(onTime * 100 / done)}%", modifier = Modifier.padding(top = 8.dp))
                            }
                        }
                    }
                }
                item {
                    Column {
                        SectionHeader("Shopping, maintenance and waste")
                        GroupedList {
                            (o["shopping"] as? JsonObject)?.let { s -> HomeHubListTile("Groceries bought", subtitle = "${s["itemsPurchased"]?.jsonPrimitive?.longOrNull ?: 0} item${if ((s["itemsPurchased"]?.jsonPrimitive?.longOrNull ?: 0) == 1L) "" else "s"} · ${Money.format(s["spentMinor"]?.jsonPrimitive?.longOrNull ?: 0, h.currency)}" + ((s["unpricedItems"]?.jsonPrimitive?.longOrNull ?: 0).takeIf { it > 0 }?.let { " ($it without price)" } ?: "")) }
                            Divider()
                            (o["maintenance"] as? JsonObject)?.let { m -> HomeHubListTile("Maintenance", subtitle = "${m["requests"]?.jsonPrimitive?.contentOrNull} requests · ${m["completed"]?.jsonPrimitive?.contentOrNull} done · ${Money.format(m["costMinor"]?.jsonPrimitive?.longOrNull ?: 0, h.currency)}") }
                            Divider()
                            (o["wastage"] as? JsonObject)?.let { w -> HomeHubListTile("Pantry waste", subtitle = "${w["events"]?.jsonPrimitive?.contentOrNull} items wasted") }
                        }
                    }
                }
                usage?.let { u -> item { UsageCard(u) } }
            }
        }
    }
}

@Composable
fun UsageCard(u: JsonObject) {
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    Column {
        SectionHeader("Assistant usage")
        HomeHubCard {
            val tokens = u["tokens"] as? JsonObject
            Text("${u["runs"]?.jsonPrimitive?.contentOrNull ?: "0"} runs · ${grouped(tokens?.get("total")?.jsonPrimitive?.contentOrNull)} tokens", style = t.cardTitle, color = c.ink)
            Text("Per successful request: ${u["tokensPerSuccessfulRun"]?.jsonPrimitive?.contentOrNull?.takeIf { it != "null" }?.let { grouped(it) } ?: "—"} tokens · cached ${tokens?.get("cached")?.jsonPrimitive?.contentOrNull ?: "0"}", style = t.bodyCompact, color = c.inkSecondary)
            Text("Measured by HomeHub's model proxy, not estimated. Cost shown only when pricing is configured (${u["costCoverage"]?.jsonPrimitive?.contentOrNull}).", style = t.caption, color = c.inkTertiary)
        }
    }
}

// ---------------- Approvals ----------------

@Composable
fun ApprovalsScreen() {
    val h = LocalHousehold.current
    val graph = AppGraph.get(LocalContext.current)
    val nav = LocalActions.current
    val scope = rememberCoroutineScope()
    val pending by remember(h.hid) { graph.agent.pendingApprovals(h.hid) }.collectAsStateWithLifecycle(emptyList())
    var busy by remember { mutableStateOf<String?>(null) }
    ListScreen("Approvals", subtitle = "${pending.size} waiting") {
        if (!h.role.isAdultPlus) item { EmptyState(Icons.Outlined.VerifiedUser, "Adults decide approvals", "Requests you make will appear for the adults in your household.") }
        else if (pending.isEmpty()) item { EmptyState(Icons.Outlined.CheckCircle, "Nothing waiting", "Purchases, payments, bookings and other sensitive actions appear here for a decision.") }
        pending.forEach { a ->
            item(key = a.id) {
                ApprovalCard(a, h.zone, h.role.isAdultPlus, busy == a.id, modifier = Modifier.padding(vertical = 6.dp), onApprove = {
                    busy = a.id
                    scope.launch {
                        runCatching { graph.agent.decide(h.hid, a.id, true, null) }.onSuccess { r ->
                            nav.toast(when (r["status"]?.jsonPrimitive?.contentOrNull) { "executed" -> "Approved and done"; "approved" -> "Approved — a person needs to complete it"; "failed" -> "Approved, but it couldn't be completed"; else -> "Approved" })
                        }.onFailure { nav.toast(it.message ?: "Couldn't approve") }
                        busy = null
                    }
                }, onReject = {
                    busy = a.id
                    scope.launch { runCatching { graph.agent.decide(h.hid, a.id, false, null) }.onSuccess { nav.toast("Rejected") }; busy = null }
                })
            }
        }
    }
}

// ---------------- Notifications ----------------

@Composable
fun NotificationsScreen() {
    val h = LocalHousehold.current
    val graph = AppGraph.get(LocalContext.current)
    val nav = LocalActions.current
    val scope = rememberCoroutineScope()
    val list by remember(h.hid) { graph.data.observe(h.hid, "notifications", { it.whereEqualTo("recipientUid", h.uid).orderBy("createdAt", Query.Direction.DESCENDING).limit(50) }, AppNotification::from) }.collectAsStateWithLifecycle(Loadable.Loading)
    ListScreen("Notifications") {
        when (val l = list) {
            Loadable.Loading -> item { LoadingSkeleton() }
            is Loadable.Failed -> item { ErrorState(l.message) }
            is Loadable.Ready -> if (l.value.isEmpty()) item { EmptyState(Icons.Outlined.NotificationsNone, "You're all caught up", "Reminders, approvals and briefings appear here.") }
            else item {
                GroupedList {
                    l.value.forEachIndexed { i, n ->
                        if (i > 0) Divider()
                        HomeHubListTile(n.title, subtitle = n.body + (n.createdAt?.let { " · ${Dates.relative(it, h.zone)}" } ?: ""), onClick = {
                            scope.launch { runCatching { graph.data.markNotificationRead(h.hid, n.id) } }
                            n.deepLink?.removePrefix("homehub://")?.substringBefore('/')?.takeIf { it.isNotBlank() }?.let { nav.go(it) }
                        }, trailing = { if (!n.read) StatusBadge("New", Tone.Brand) })
                    }
                }
            }
        }
    }
}

// ---------------- Settings ----------------

@Composable
fun SettingsScreen() {
    val h = LocalHousehold.current
    val graph = AppGraph.get(LocalContext.current)
    val nav = LocalActions.current
    val scope = rememberCoroutineScope()
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    val jobs by remember(h.hid, h.role) { if (h.role.isManager) graph.data.observe(h.hid, "scheduledJobs", { it }, ScheduledJob::from) else kotlinx.coroutines.flow.flowOf(Loadable.Ready(emptyList())) }.collectAsStateWithLifecycle(Loadable.Loading)
    val pending by graph.database.dao().pendingCount(h.hid).collectAsStateWithLifecycle(0)
    val conflicts by remember(h.hid) { graph.offline.conflicts(h.hid) }.collectAsStateWithLifecycle(emptyList())
    var prefs by remember { mutableStateOf<Map<String, Any?>>(emptyMap()) }
    var quietStart by remember { mutableStateOf("22:00") }
    var quietEnd by remember { mutableStateOf("07:00") }
    var memories by remember { mutableStateOf<JsonArray?>(null) }
    var health by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    var confirmPause by remember { mutableStateOf(false) }
    LaunchedEffect(h.uid) {
        runCatching { graph.firestore.document("users/${h.uid}").get().await() }.getOrNull()?.let { s ->
            @Suppress("UNCHECKED_CAST") val p = s.get("notificationPrefs") as? Map<String, Any?> ?: emptyMap()
            prefs = p
            @Suppress("UNCHECKED_CAST") (p["quietHours"] as? Map<String, Any?>)?.let { q -> quietStart = q["start"] as? String ?: "22:00"; quietEnd = q["end"] as? String ?: "07:00" }
        }
        memories = runCatching { graph.agent.memories(h.hid)["items"]?.jsonArray }.getOrNull()
        health = runCatching { graph.agent.health()["status"]?.jsonPrimitive?.contentOrNull }.getOrElse { "unreachable" }
    }
    fun savePrefs(next: Map<String, Any?>) {
        prefs = next
        scope.launch { runCatching { graph.firestore.document("users/${h.uid}").set(mapOf("notificationPrefs" to next), SetOptions.merge()).await() }.onFailure { nav.toast("Couldn't save") } }
    }
    ListScreen("Settings") {
        item {
            Column {
                SectionHeader("Assistant")
                HomeHubCard {
                    val paused = h.household.autonomy.paused
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(if (paused) "Assistant is paused" else "Assistant is active", style = t.cardTitle, color = if (paused) c.warning else c.ink)
                            Text(if (paused) "No autonomous changes until a manager resumes it. Reads still work." else "Emergency pause stops every autonomous change immediately.", style = t.bodyCompact, color = c.inkSecondary)
                        }
                    }
                    Spacer(Modifier.height(Space.sm))
                    if (!paused && h.role.isAdultPlus) HomeHubButton("Pause the assistant", { confirmPause = true }, Modifier.fillMaxWidth(), kind = ButtonKind.Destructive)
                    if (paused && h.role.isManager) HomeHubButton("Resume the assistant", { scope.launch { runCatching { graph.agent.setAutonomy(h.hid, paused = false) }.onFailure { nav.toast(it.message ?: "Couldn't resume") } } }, Modifier.fillMaxWidth())
                    if (h.role.isManager) {
                        Spacer(Modifier.height(Space.md))
                        Text("Autonomy", style = t.label, color = c.ink)
                        AutonomyPicker(h.household.autonomy.mode) { mode -> scope.launch { runCatching { graph.agent.setAutonomy(h.hid, mode = mode) }.onSuccess { nav.toast("Autonomy updated") }.onFailure { nav.toast(it.message ?: "Couldn't update") } } }
                    }
                    Spacer(Modifier.height(Space.sm))
                    val p = graph.hermes.power.snapshot()
                    Text("Runs on this phone (Hermes Mobile). Battery: ${p.levelPercent ?: "?"}%${if (p.charging) ", charging" else ""} · mode ${p.mode.name.lowercase()}. Scheduled assistant jobs run only while charging; otherwise the HomeHub server runs them.", style = t.caption, color = c.inkSecondary)
                }
            }
        }
        if (h.role.isManager) item {
            Column {
                SectionHeader("Automations")
                when (val j = jobs) {
                    is Loadable.Ready -> GroupedList {
                        j.value.sortedBy { it.type }.forEachIndexed { i, job ->
                            if (i > 0) Divider()
                            Row(Modifier.fillMaxWidth().padding(horizontal = Space.md, vertical = Space.sm), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(job.type.replace('_', ' ').replaceFirstChar { it.uppercase() }, style = t.cardTitle, color = c.ink)
                                    Text("${job.kind.replaceFirstChar { it.uppercase() }} at ${job.time}" + (job.nextRunAt?.let { " · next ${Dates.relative(it, h.zone)}" } ?: "") + (job.lastStatus?.let { " · last: ${it.replace('_', ' ')}" } ?: "") + if (job.requiresAgent) " · uses the assistant" else "", style = t.caption, color = c.inkSecondary)
                                }
                                Switch(job.enabled, { on -> scope.launch { runCatching { graph.agent.jobAction(h.hid, job.id, if (on) "resume" else "pause") }.onFailure { nav.toast(it.message ?: "Couldn't update") } } }, colors = SwitchDefaults.colors(checkedTrackColor = c.brand))
                            }
                        }
                    }
                    else -> LoadingSkeleton(3)
                }
            }
        }
        item {
            Column {
                SectionHeader("Notifications")
                GroupedList {
                    @Suppress("UNCHECKED_CAST") val cats = prefs["categories"] as? Map<String, Boolean> ?: emptyMap()
                    listOf("tasks" to "Tasks", "bills" to "Bills", "pantry" to "Pantry", "maintenance" to "Maintenance", "approvals" to "Approvals", "agent" to "Assistant", "briefing" to "Daily briefing").forEachIndexed { i, (id, label) ->
                        if (i > 0) Divider()
                        Row(Modifier.fillMaxWidth().padding(horizontal = Space.md).height(52.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(label, style = t.body, color = c.ink, modifier = Modifier.weight(1f))
                            Switch(cats[id] ?: true, { on -> savePrefs(prefs + ("categories" to (cats + (id to on)))) }, colors = SwitchDefaults.colors(checkedTrackColor = c.brand))
                        }
                    }
                }
                Spacer(Modifier.height(Space.sm))
                Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    HomeHubTextField("Quiet from", quietStart, { quietStart = it }, Modifier.weight(1f), placeholder = "22:00")
                    HomeHubTextField("Until", quietEnd, { quietEnd = it }, Modifier.weight(1f), placeholder = "07:00")
                }
                HomeHubButton("Save quiet hours", {
                    if (!Regex("^\\d{2}:\\d{2}$").matches(quietStart) || !Regex("^\\d{2}:\\d{2}$").matches(quietEnd)) { scope.launch { nav.toast("Use HH:MM") }; return@HomeHubButton }
                    savePrefs(prefs + ("quietHours" to mapOf("start" to quietStart, "end" to quietEnd)) + ("timezone" to h.household.timezone))
                }, kind = ButtonKind.Tertiary)
            }
        }
        item {
            Column {
                SectionHeader("Assistant memory")
                val items = memories
                if (items == null) Text("Couldn't load memory right now.", style = t.bodyCompact, color = c.inkSecondary)
                else if (items.isEmpty()) Text("Nothing remembered. HomeHub never stores whole conversations as memory.", style = t.bodyCompact, color = c.inkSecondary)
                else GroupedList {
                    items.forEachIndexed { i, m ->
                        val o = m.jsonObject
                        if (i > 0) Divider()
                        HomeHubListTile(o["text"]?.jsonPrimitive?.contentOrNull ?: "", subtitle = (o["scope"]?.jsonPrimitive?.contentOrNull ?: "") + " · " + (o["kind"]?.jsonPrimitive?.contentOrNull ?: ""),
                            trailing = { HomeHubButton("Forget", { scope.launch { runCatching { graph.agent.deleteMemory(h.hid, o["id"]!!.jsonPrimitive.content) }.onSuccess { memories = JsonArray(items.filterNot { it == m }) } } }, kind = ButtonKind.Tertiary) })
                    }
                }
            }
        }
        item {
            Column {
                SectionHeader("Sync & diagnostics")
                GroupedList {
                    HomeHubListTile("Waiting to sync", subtitle = if (pending == 0) "Everything is up to date" else "$pending change${if (pending > 1) "s" else ""} will sync when you're online", leadingIcon = Icons.Outlined.CloudSync)
                    Divider()
                    HomeHubListTile("Sync conflicts", subtitle = if (conflicts.isEmpty()) "None" else "${conflicts.size} need your decision", onClick = { nav.go(Routes.CONFLICTS) },
                        trailing = { if (conflicts.isNotEmpty()) StatusBadge("Action needed", Tone.Warning) })
                    Divider()
                    HomeHubListTile("HomeHub service", subtitle = health ?: "Checking…", leadingIcon = Icons.Outlined.Insights)
                }
            }
        }
        item {
            Column {
                SectionHeader("Your data")
                GroupedList {
                    HomeHubListTile("Export my data", subtitle = "Profile, memberships, private notes and memories", onClick = {
                        scope.launch { runCatching { graph.session.exportMyData() }.onSuccess { json ->
                            val f = java.io.File(graph.appContext.cacheDir, "homehub-export.json").apply { writeText(json) }
                            nav.toast("Export saved (${f.length() / 1024} KB) to app storage")
                        }.onFailure { nav.toast(it.message ?: "Couldn't export") } }
                    })
                    Divider()
                    HomeHubListTile("Sign out", onClick = { nav.vm.signOut() })
                    Divider()
                    HomeHubListTile("Delete my account", subtitle = "Removes your profile, private notes and memories", onClick = { confirmDelete = true })
                }
            }
        }
    }
    if (confirmPause) ConfirmationDialog("Pause the assistant?", "Every autonomous change stops for the whole household until a manager resumes it.", "Pause", {
        confirmPause = false
        scope.launch { runCatching { graph.agent.setAutonomy(h.hid, paused = true) }.onSuccess { nav.toast("Assistant paused") }.onFailure { nav.toast(it.message ?: "Couldn't pause") } }
    }, { confirmPause = false }, destructive = true)
    if (confirmDelete) ConfirmationDialog("Delete your account?", "This permanently removes your profile, private notes and private memories. Shared household records stay. This can't be undone.", "Delete account", {
        confirmDelete = false
        scope.launch { runCatching { graph.session.deleteAccount() }.onFailure { nav.toast(it.message ?: "Couldn't delete the account") } }
    }, { confirmDelete = false }, destructive = true)
}

// ---------------- Sync conflicts ----------------

@Composable
fun ConflictsScreen() {
    val h = LocalHousehold.current
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val c = HomeHubTheme.colors
    val conflicts by remember(h.hid) { graph.offline.conflicts(h.hid) }.collectAsStateWithLifecycle(emptyList())
    ListScreen("Sync conflicts") {
        if (conflicts.isEmpty()) item { EmptyState(Icons.Outlined.CheckCircle, "No conflicts", "When the same item changes on two devices, you'll choose which version to keep here.") }
        conflicts.forEach { cf ->
            item(key = cf.opId) {
                HomeHubCard(Modifier.padding(vertical = 6.dp)) {
                    Text(cf.collection.replaceFirstChar { it.uppercase() }.removeSuffix("s").replace("groceryItem", "Shopping item"), style = HomeHubTheme.type.label, color = c.inkSecondary)
                    Text("Your change: ${cf.localSummary}", style = HomeHubTheme.type.body, color = c.ink)
                    Text("On the server: ${cf.remoteSummary}", style = HomeHubTheme.type.bodyCompact, color = c.inkSecondary)
                    Spacer(Modifier.height(Space.sm))
                    Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                        HomeHubButton("Keep theirs", { scope.launch { graph.offline.keepTheirs(cf) } }, Modifier.weight(1f), kind = ButtonKind.Secondary)
                        if (cf.remoteVersion >= 0) HomeHubButton("Keep mine", { scope.launch { graph.offline.keepMine(cf) } }, Modifier.weight(1f))
                    }
                }
            }
        }
    }
}


/** Thousands separators for counts, like the iOS app ("39,367"). */
private fun grouped(v: String?): String = v?.toDoubleOrNull()?.let { java.text.NumberFormat.getIntegerInstance(java.util.Locale.ENGLISH).format(it.toLong()) } ?: (v ?: "0")
