package com.e404.homehub.ui.screens

import android.app.Application
import androidx.compose.foundation.background
import androidx.compose.ui.unit.sp
import androidx.compose.ui.graphics.Color
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.PauseCircle
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.e404.homehub.AppGraph
import com.e404.homehub.data.model.AgentMessage
import com.e404.homehub.data.model.Approval
import com.e404.homehub.data.remote.GatewayException
import com.e404.homehub.hermes.AgentEvent
import com.e404.homehub.hermes.ChatMessage
import com.e404.homehub.hermes.ModelUnavailable
import com.e404.homehub.hermes.OfflineIntent
import com.e404.homehub.hermes.OfflineIntents
import com.e404.homehub.hermes.PowerMode
import com.e404.homehub.ui.HouseholdContext
import com.e404.homehub.ui.LocalActions
import com.e404.homehub.ui.LocalHousehold
import com.e404.homehub.ui.Routes
import com.e404.homehub.ui.components.AgentActivityTimeline
import com.e404.homehub.ui.components.AgentState
import com.e404.homehub.ui.components.AgentStatusIndicator
import com.e404.homehub.ui.components.ApprovalCard
import com.e404.homehub.ui.components.ButtonKind
import com.e404.homehub.ui.components.Divider
import com.e404.homehub.ui.components.GlassSurface
import com.e404.homehub.ui.components.GroupedList
import com.e404.homehub.ui.components.HomeHubButton
import com.e404.homehub.ui.components.HomeHubCard
import com.e404.homehub.ui.components.HomeHubIconButton
import com.e404.homehub.ui.components.HomeHubListTile
import com.e404.homehub.ui.components.StatusBadge
import com.e404.homehub.ui.components.ToolStep
import com.e404.homehub.ui.components.Tone
import com.e404.homehub.ui.theme.GlassStrength
import com.e404.homehub.ui.theme.HomeHubTheme
import com.e404.homehub.ui.theme.Radius
import com.e404.homehub.ui.theme.Space
import com.e404.homehub.ui.util.Dates
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import java.time.Instant

data class LiveRun(
    val prompt: String,
    val state: AgentState = AgentState.Executing,
    val text: String = "",
    val steps: List<ToolStep> = emptyList(),
    val notes: List<String> = emptyList(),
    val verified: List<String> = emptyList(),
    val approvalIds: List<String> = emptyList(),
    val error: String? = null,
    val onDevice: Boolean = false,
    val needsModelAccount: Boolean = false,
)

data class AiUi(val sessionId: String? = null, val live: LiveRun? = null)

/** Drives Hermes Mobile for the AI screen. Survives configuration changes; cancellation stops the loop. */
class AgentViewModel(app: Application) : AndroidViewModel(app) {
    private val graph = AppGraph.get(app)
    private val _ui = MutableStateFlow(AiUi())
    val ui = _ui.asStateFlow()
    private var job: Job? = null

    fun newConversation() { job?.cancel(); _ui.value = AiUi() }
    fun openSession(id: String) { job?.cancel(); _ui.value = AiUi(sessionId = id) }

    fun send(h: HouseholdContext, prompt: String) {
        if (job?.isActive == true || prompt.isBlank()) return
        _ui.update { it.copy(live = LiveRun(prompt.trim())) }
        job = viewModelScope.launch {
            // 1) Zero-model path: common commands are handled on the phone (works offline, costs no tokens).
            OfflineIntents.parse(prompt)?.let { intent ->
                val answer = runCatching { handleLocally(h, intent) }.getOrElse { "Couldn't do that: ${it.message}" }
                _ui.update { it.copy(live = it.live?.copy(state = AgentState.Local, text = answer, onDevice = true)) }
                return@launch
            }
            // 2) Hermes Mobile: agent loop on this phone; model via the HomeHub proxy; tools via HomeHub MCP.
            try {
                val history = _ui.value.sessionId?.let { sid -> graph.agent.messages(h.hid, sid).first().takeLast(6).map { ChatMessage(it.role, it.content) } }.orEmpty()
                val outcome = graph.hermes.run(h.hid, prompt, _ui.value.sessionId, history) { e -> onEvent(e) }
                _ui.update { s ->
                    val text = when {
                        outcome.state == "deterministic" -> describeDeterministic(outcome.deterministicAnswer)
                        outcome.text.isNotBlank() -> outcome.text
                        else -> s.live?.text.orEmpty()
                    }
                    s.copy(sessionId = outcome.sessionId ?: s.sessionId, live = s.live?.copy(
                        state = if (outcome.state == "deterministic") AgentState.Completed else AgentState.of(outcome.state),
                        text = text, verified = outcome.verifiedActions, approvalIds = outcome.approvalIds, error = outcome.error,
                    ))
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                _ui.update { it.copy(live = it.live?.copy(state = AgentState.Cancelled)) }
                throw e
            } catch (e: Exception) {
                val msg = when {
                    e is GatewayException && e.code == "network" -> "You're offline. I can still add items to your list, add tasks, mark tasks done and show today's tasks."
                    e is GatewayException && e.isAgentUnavailable -> "The assistant isn't available right now. Everything else in HomeHub keeps working."
                    e is GatewayException && e.code == "rate_limited" -> "You've reached the assistant's hourly limit. Try again later."
                    e is ModelUnavailable && e.code == "model_account_required" -> "Connect an AI model account to use the assistant. Everything else in HomeHub works without one."
                    e is ModelUnavailable -> e.message ?: "The assistant's model is unavailable."
                    else -> e.message ?: "Something went wrong."
                }
                val needsAccount = (e is ModelUnavailable && e.code == "model_account_required") || (e is GatewayException && e.code == "model_account_required")
                _ui.update { it.copy(live = it.live?.copy(state = AgentState.Failed, error = msg, needsModelAccount = needsAccount)) }
            }
        }
    }

    fun stop() { job?.cancel() }

    private fun onEvent(e: AgentEvent) = _ui.update { s ->
        val live = s.live ?: return@update s
        s.copy(live = when (e) {
            is AgentEvent.Delta -> live.copy(text = live.text + e.text)
            is AgentEvent.ToolStarted -> live.copy(steps = live.steps + ToolStep(e.name, done = false, ok = true))
            is AgentEvent.ToolFinished -> live.copy(steps = live.steps.toMutableList().also { l ->
                val i = l.indexOfLast { it.name == e.name && !it.done }; if (i >= 0) l[i] = l[i].copy(done = true, ok = e.ok)
            })
            is AgentEvent.Note -> live.copy(notes = live.notes + e.text)
        })
    }

    private suspend fun handleLocally(h: HouseholdContext, intent: OfflineIntent): String = when (intent) {
        is OfflineIntent.AddToList -> {
            val lists = graph.firestore.collection("households/${h.hid}/shoppingLists").whereEqualTo("archived", false).limit(1).get().await()
            val listId = lists.documents.firstOrNull()?.id ?: return "There's no shopping list yet. Create one in Shopping first."
            graph.offline.addGrocery(h.hid, listId, intent.item, intent.quantity, intent.unit, "Other", null)
            "Added ${Dates.qty(intent.quantity)} ${intent.unit} ${intent.item} to “${lists.documents.first().getString("name")}”."
        }
        is OfflineIntent.AddTask -> { graph.offline.createTask(h.hid, intent.title, null, com.e404.homehub.data.model.Priority.Normal, null, h.uid, null, null); "Added task “${intent.title}” for you." }
        is OfflineIntent.CompleteTask -> {
            val tasks = graph.offline.tasks(h.hid).first().filter { !it.isDone }
            val match = tasks.firstOrNull { it.title.equals(intent.query, true) } ?: tasks.firstOrNull { it.title.contains(intent.query, true) }
            if (match == null) "I couldn't find an open task called “${intent.query}”."
            else { graph.offline.setTaskDone(h.hid, h.uid, match.id, true); "Marked “${match.title}” done." }
        }
        OfflineIntent.DueToday -> {
            val end = Instant.now().atZone(h.zone).toLocalDate().plusDays(1).atStartOfDay(h.zone).toInstant()
            val due = graph.offline.tasks(h.hid).first().filter { !it.isDone && it.dueAt != null && it.dueAt.isBefore(end) }
            if (due.isEmpty()) "Nothing due today." else "Due today:\n" + due.joinToString("\n") { "• ${it.title}" + (it.dueAt?.let { d -> " — ${Dates.time(d, h.zone)}" } ?: "") }
        }
    }

    private fun describeDeterministic(a: kotlinx.serialization.json.JsonElement?): String {
        val o = a as? kotlinx.serialization.json.JsonObject ?: return "Here's what I found."
        return (o["summary"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: "Here's what I found."
    }
}

private val SUGGESTIONS = listOf(
    "Prepare everything for next week.",
    "Prepare the house for guests on Saturday.",
    "Are we over budget this month?",
    "What's running low in the pantry?",
    "The bedroom AC isn't cooling — sort it out.",
    "Plan dinners for this week.",
)

@Composable
fun AiScreen(initialPrompt: String? = null) {
    val h = LocalHousehold.current
    val nav = LocalActions.current
    val graph = AppGraph.get(LocalContext.current)
    val vm: AgentViewModel = viewModel()
    val ui by vm.ui.collectAsStateWithLifecycle()
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    var input by rememberSaveable { mutableStateOf("") }
    var showSessions by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val history by remember(h.hid, ui.sessionId) { ui.sessionId?.let { graph.agent.messages(h.hid, it) } ?: kotlinx.coroutines.flow.flowOf(emptyList()) }.collectAsStateWithLifecycle(emptyList())
    val power = remember { graph.hermes.power.snapshot() }
    val running = ui.live?.state == AgentState.Executing
    var modelLabel by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(h.hid, ui.live?.state) {
        modelLabel = runCatching { (graph.connect.modelAccounts(h.hid)["active"] as? kotlinx.serialization.json.JsonObject)?.get("label")?.let { (it as kotlinx.serialization.json.JsonPrimitive).content } ?: "" }.getOrNull()
    }
    val canUse = h.role.id != "staff"

    LaunchedEffect(initialPrompt) { if (!initialPrompt.isNullOrBlank() && ui.live == null) input = initialPrompt }
    LaunchedEffect(ui.live?.text, ui.live?.steps?.size, history.size) { val n = listState.layoutInfo.totalItemsCount; if (n > 0) listState.animateScrollToItem(n - 1) }

    Box(Modifier.fillMaxSize().background(c.canvas)) {
        Column(Modifier.fillMaxSize()) {
            HomeHubTopBar("Assistant", actions = {
                HomeHubIconButton(Icons.Outlined.ChatBubbleOutline, "Conversations", { showSessions = true })
                HomeHubButton("New", { vm.newConversation(); input = "" }, kind = ButtonKind.Tertiary)
            })
            // Context strip: household, autonomy mode, on-device runtime, battery state.
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = Space.md, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                if (h.household.autonomy.paused) StatusBadge("Agent paused", Tone.Warning, Icons.Outlined.PauseCircle)
                else StatusBadge("${AUTONOMY.firstOrNull { it.first == h.household.autonomy.mode }?.second?.first?.substringBefore(" (") ?: "Routine"} mode", Tone.Brand)
                StatusBadge("Runs on this phone", Tone.Neutral, Icons.Outlined.PhoneAndroid)
                modelLabel?.let { label -> Box(Modifier.clickable(role = androidx.compose.ui.semantics.Role.Button) { nav.go(Routes.MODEL_ACCOUNTS) }) { StatusBadge(label.ifEmpty { "No model account" }, if (label.isEmpty()) Tone.Warning else Tone.Neutral, Icons.Outlined.AutoAwesome) } }
                if (power.mode == PowerMode.Saver) StatusBadge("Battery saver: lighter plans", Tone.Warning)
            }
            LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = listState, horizontalAlignment = Alignment.CenterHorizontally,
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = Space.md, vertical = Space.sm)) {
                if (!canUse) item { HomeHubCard { Text("The assistant isn't available for staff accounts. Your assigned work is in Manage.", style = t.body, color = c.inkSecondary) } }
                if (ui.live == null && history.isEmpty() && canUse) item {
                    Column(Modifier.widthIn(max = 720.dp).fillMaxWidth().padding(top = Space.lg)) {
                        Icon(Icons.Rounded.AutoAwesome, null, tint = c.brand, modifier = Modifier.size(36.dp))
                        Spacer(Modifier.size(Space.md))
                        Text("What can I take off your plate?", style = t.sectionTitle.copy(fontSize = 22.sp), color = c.ink)
                        Spacer(Modifier.size(Space.sm))
                        Text("I plan and organise household work. Purchases, payments and bookings always wait for your approval.", style = t.body, color = c.inkSecondary)
                        Spacer(Modifier.size(Space.xs))
                        SUGGESTIONS.forEach { s ->
                            // Capsule suggestion, same as iOS.
                            Text(s, style = t.body, color = c.ink, modifier = Modifier.padding(vertical = 4.dp).clip(RoundedCornerShape(50)).background(c.surface)
                                .border(1.dp, c.border, RoundedCornerShape(50)).clickable(role = androidx.compose.ui.semantics.Role.Button) { input = s }
                                .heightIn(min = 48.dp).padding(horizontal = 18.dp, vertical = 12.dp))
                        }
                    }
                }
                // The live run already shows its prompt (and later its answer): drop those from stored history to avoid duplicates.
                val shownHistory = ui.live?.let { live ->
                    val idx = history.indexOfLast { it.role == "user" && it.content == live.prompt }
                    if (idx >= 0) history.subList(0, idx) else history
                } ?: history
                items(shownHistory, key = { it.id }) { m -> Box(Modifier.widthIn(max = 720.dp).fillMaxWidth()) { HistoryBubble(m, h) } }
                ui.live?.let { live -> item(key = "live") { Box(Modifier.widthIn(max = 720.dp).fillMaxWidth()) { LiveRunView(live, h, onRetry = { vm.send(h, live.prompt) }) } } }
            }
            // Functional layer: the composer floats as a glass control over the conversation.
            if (canUse) GlassSurface(
                Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).imePadding().padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 92.dp),
                strength = GlassStrength.Regular, shape = RoundedCornerShape(Radius.panel),
            ) {
                Row(Modifier.padding(8.dp), verticalAlignment = Alignment.Bottom) {
                    // Text entry itself sits on an opaque inner surface (design.md: no text on raw glass).
                    OutlinedTextField(
                        input, { input = it }, Modifier.weight(1f).semantics { contentDescription = "Message the assistant" },
                        placeholder = { Text("Ask HomeHub…", color = c.inkTertiary) }, maxLines = 5, enabled = !running,
                        shape = RoundedCornerShape(Radius.input), textStyle = t.body.copy(color = c.ink),
                        colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = c.surface, unfocusedContainerColor = c.surface, disabledContainerColor = c.surfaceSubtle, focusedBorderColor = c.brand.copy(alpha = 0.35f), unfocusedBorderColor = Color.Transparent, disabledBorderColor = Color.Transparent),
                    )
                    Spacer(Modifier.width(6.dp))
                    if (running) HomeHubIconButton(Icons.Outlined.StopCircle, "Stop", { vm.stop() }, tint = c.danger)
                    else Box(
                        // Filled disc with an up arrow, like iOS's arrow.up.circle.fill.
                        Modifier.size(48.dp).clickable(enabled = input.isNotBlank(), role = androidx.compose.ui.semantics.Role.Button, onClickLabel = "Send") { vm.send(h, input); input = "" },
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(Modifier.size(32.dp).clip(androidx.compose.foundation.shape.CircleShape).background(if (input.isBlank()) c.inkTertiary else c.brand), contentAlignment = Alignment.Center) {
                            Icon(Icons.Rounded.ArrowUpward, "Send", tint = Color.White, modifier = Modifier.size(20.dp))
                        }
                    }
                }
            }
        }
    }
    if (showSessions) {
        val sessions by remember(h.hid) { graph.agent.sessions(h.hid, h.uid) }.collectAsStateWithLifecycle(emptyList())
        FormSheet("Conversations", { showSessions = false }) {
            HomeHubButton("New conversation", { vm.newConversation(); showSessions = false }, Modifier.fillMaxWidth(), kind = ButtonKind.Secondary)
            if (sessions.isEmpty()) Text("No conversations yet.", style = t.bodyCompact, color = c.inkSecondary)
            else GroupedList { sessions.forEachIndexed { i, s -> if (i > 0) Divider(); HomeHubListTile(s.title, subtitle = s.updatedAt?.let { Dates.relative(it, h.zone) }, onClick = { vm.openSession(s.id); showSessions = false }) } }
        }
    }
}

@Composable
private fun HistoryBubble(m: AgentMessage, h: HouseholdContext) {
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    val user = m.role == "user"
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalAlignment = if (user) Alignment.End else Alignment.Start) {
        val text = if (m.content.trimStart().startsWith("{") || m.content.trimStart().startsWith("[")) "Here's today's summary." else m.content
        Box(Modifier.clip(RoundedCornerShape(Radius.card)).background(if (user) c.brandTint else c.surface).border(1.dp, if (user) c.brandTint else c.border, RoundedCornerShape(Radius.card)).padding(Space.sm).widthIn(max = 560.dp)) {
            Text(text, style = t.body, color = c.ink)
        }
        if (!user && m.state != null) Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            AgentStatusIndicator(AgentState.of(m.state))
            m.createdAt?.let { Text("  ${Dates.relative(it, h.zone)}", style = t.caption, color = c.inkTertiary) }
        }
    }
}

@Composable
private fun LiveRunView(live: LiveRun, h: HouseholdContext, onRetry: () -> Unit) {
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val nav = LocalActions.current
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Box(Modifier.align(Alignment.End).clip(RoundedCornerShape(Radius.card)).background(c.brandTint).padding(Space.sm).widthIn(max = 560.dp)) { Text(live.prompt, style = t.body, color = c.ink) }
        Spacer(Modifier.size(Space.sm))
        HomeHubCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("HomeHub", style = t.label, color = c.inkSecondary, modifier = Modifier.weight(1f))
                AgentStatusIndicator(live.state)
            }
            if (live.onDevice) Text("Handled on your phone · no AI used", style = t.caption, color = c.inkTertiary)
            live.notes.forEach { Text(it, style = t.caption, color = c.inkSecondary) }
            if (live.steps.isNotEmpty()) {
                Spacer(Modifier.size(Space.xs))
                Text("Tool activity", style = t.caption, color = c.inkSecondary)
                AgentActivityTimeline(live.steps, Modifier.padding(top = 4.dp))
            }
            if (live.text.isNotBlank()) {
                Spacer(Modifier.size(Space.sm))
                Text(live.text.trim(), style = t.body, color = c.ink, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            }
            if (live.verified.isNotEmpty()) {
                Spacer(Modifier.size(Space.sm))
                Text("Verified in HomeHub", style = t.label, color = c.success)
                live.verified.distinct().forEach { a ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.TaskAlt, null, tint = c.success, modifier = Modifier.size(14.dp))
                        Text("  ${a.replace('.', ' ').replace('_', ' ')} (${live.verified.count { it == a }})", style = t.caption, color = c.inkSecondary)
                    }
                }
            }
            if (live.error != null) {
                Spacer(Modifier.size(Space.sm))
                Text(live.error, style = t.bodyCompact, color = if (live.state == AgentState.Failed) c.danger else c.inkSecondary)
                if (live.needsModelAccount) HomeHubButton("Connect a model account", { nav.go(Routes.MODEL_ACCOUNTS) }, kind = ButtonKind.Secondary, icon = Icons.Outlined.AutoAwesome)
                else if (live.state == AgentState.Failed) HomeHubButton("Try again", onRetry, kind = ButtonKind.Secondary, icon = Icons.Outlined.Refresh)
            }
        }
        live.approvalIds.forEach { id ->
            val approval by remember(id) { graph.agent.approval(h.hid, id) }.collectAsStateWithLifecycle(null as Approval?)
            var busy by remember { mutableStateOf(false) }
            approval?.let { a ->
                Spacer(Modifier.size(Space.sm))
                if (a.status == "pending") ApprovalCard(a, h.zone, h.role.isAdultPlus, busy, onApprove = {
                    busy = true
                    scope.launch { runCatching { graph.agent.decide(h.hid, a.id, true, null) }.onFailure { nav.toast(it.message ?: "Couldn't approve") }; busy = false }
                }, onReject = {
                    busy = true
                    scope.launch { runCatching { graph.agent.decide(h.hid, a.id, false, null) }; busy = false }
                })
                else HomeHubCard { Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(a.title.replaceFirstChar { it.uppercase() }, style = t.cardTitle, color = c.ink, modifier = Modifier.weight(1f))
                    StatusBadge(when (a.status) { "executed" -> "Done · verified"; "approved" -> "Approved · needs a person"; "rejected" -> "Rejected"; "expired" -> "Expired"; else -> a.status }, when (a.status) { "executed" -> Tone.Success; "rejected", "expired" -> Tone.Neutral; else -> Tone.Info })
                } }
            }
        }
        if (live.state == AgentState.AwaitingApproval && live.approvalIds.isEmpty()) HomeHubButton("Open approvals", { nav.go(Routes.APPROVALS) }, kind = ButtonKind.Tertiary)
    }
}
