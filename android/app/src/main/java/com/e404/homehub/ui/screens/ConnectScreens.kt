package com.e404.homehub.ui.screens

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Extension
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.LockOpen
import androidx.compose.material.icons.outlined.PauseCircle
import androidx.compose.material.icons.outlined.PowerSettingsNew
import androidx.compose.material.icons.outlined.PrivacyTip
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material.icons.outlined.RecordVoiceOver
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Science
import androidx.compose.material.icons.outlined.Sensors
import androidx.compose.material.icons.outlined.Thermostat
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import com.e404.homehub.AppGraph
import com.e404.homehub.data.remote.GatewayException
import com.e404.homehub.data.repo.arr
import com.e404.homehub.data.repo.bool
import com.e404.homehub.data.repo.num
import com.e404.homehub.data.repo.obj
import com.e404.homehub.data.repo.objects
import com.e404.homehub.data.repo.str
import com.e404.homehub.data.repo.strList
import com.e404.homehub.ui.LocalActions
import com.e404.homehub.ui.LocalHousehold
import com.e404.homehub.ui.Routes
import com.e404.homehub.ui.components.ButtonKind
import com.e404.homehub.ui.components.ConfirmationDialog
import com.e404.homehub.ui.components.Divider
import com.e404.homehub.ui.components.EmptyState
import com.e404.homehub.ui.components.ErrorState
import com.e404.homehub.ui.components.GroupedList
import com.e404.homehub.ui.components.HomeHubButton
import com.e404.homehub.ui.components.HomeHubCard
import com.e404.homehub.ui.components.HomeHubListTile
import com.e404.homehub.ui.components.HomeHubTextField
import com.e404.homehub.ui.components.LoadingSkeleton
import com.e404.homehub.ui.components.SectionHeader
import com.e404.homehub.ui.components.SegmentedFilter
import com.e404.homehub.ui.components.StatusBadge
import com.e404.homehub.ui.components.Tone
import com.e404.homehub.ui.theme.HomeHubTheme
import com.e404.homehub.ui.theme.Space
import com.e404.homehub.ui.util.Dates
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.time.Instant

// ---------------------------------------------------------------------------------------------
// Shared loading helper: one gateway read with loading / error / retry, reloaded on demand.
// ---------------------------------------------------------------------------------------------

private class Remote<T>(val value: T?, val error: Throwable?, val loading: Boolean)

@Composable
private fun <T> rememberRemote(vararg keys: Any?, load: suspend () -> T): Pair<Remote<T>, () -> Unit> {
    var state by remember(*keys) { mutableStateOf(Remote<T>(null, null, true)) }
    var tick by remember(*keys) { mutableIntStateOf(0) }
    LaunchedEffect(*keys, tick) {
        state = Remote(state.value, null, true)
        state = runCatching { load() }.fold({ Remote(it, null, false) }, { Remote(state.value, it, false) })
    }
    return state to { tick++ }
}

private fun friendly(e: Throwable?): String = when {
    e is GatewayException && e.code == "network" -> "You're offline. Connections need the HomeHub server."
    e is GatewayException && e.status == 403 -> e.message
    else -> e?.message ?: "Something went wrong."
}

private fun isOffline(e: Throwable?) = e is GatewayException && e.code == "network"

/** Renders loading / error / content for a [Remote] inside a LazyColumn item. */
@Composable
private fun <T> RemoteBody(r: Remote<T>, retry: () -> Unit, content: @Composable (T) -> Unit) {
    val v = r.value
    when {
        v != null -> content(v)
        r.loading -> LoadingSkeleton(4, Modifier.padding(top = Space.lg))
        else -> ErrorState(friendly(r.error), onRetry = retry, offline = isOffline(r.error))
    }
}

private fun humanize(s: String?): String = s.orEmpty().replace('_', ' ').replace('.', ' ').replace('-', ' ').replaceFirstChar { it.uppercase() }

private fun statusTone(s: String?): Tone = when (s) {
    "connected", "succeeded", "verified", "ok", "ready", "active", "available" -> Tone.Success
    "paused", "needs_setup", "action_required", "approval_required", "needs_model_account", "needs_platform_credentials", "partial", "skipped" -> Tone.Warning
    "error", "failed", "denied", "disconnected", "offline" -> Tone.Danger
    else -> Tone.Neutral
}

private fun statusLabel(s: String?): String = when (s) {
    "needs_platform_credentials" -> "Awaiting setup"
    "needs_model_account" -> "Needs a model account"
    "not_configured" -> "Not configured"
    "approval_required" -> "Needs approval"
    else -> humanize(s)
}

private fun whenText(iso: String?, zone: java.time.ZoneId): String =
    iso?.let { runCatching { Dates.relative(Instant.parse(it), zone) }.getOrNull() } ?: "—"

// ---------------------------------------------------------------------------------------------
// Connections hub
// ---------------------------------------------------------------------------------------------

private data class Hub(val title: String, val subtitle: String, val icon: ImageVector, val route: String, val managersOnly: Boolean = false)

private val HUB = listOf(
    Hub("AI model", "Use your own OpenRouter, OpenAI, Gemini or other account", Icons.Outlined.AutoAwesome, Routes.MODEL_ACCOUNTS),
    Hub("Integrations", "Connect services and devices", Icons.Outlined.Extension, Routes.INTEGRATIONS),
    Hub("Devices", "Lights, plugs, AC, locks and sensors", Icons.Outlined.Devices, Routes.DEVICES),
    Hub("Automations", "When this happens, do that", Icons.Outlined.Bolt, Routes.AUTOMATIONS),
    Hub("Channels and Alexa", "Where you can reach HomeHub", Icons.Outlined.RecordVoiceOver, Routes.CHANNELS),
    Hub("Agents and skills", "What the assistant can do", Icons.Outlined.Psychology, Routes.AGENTS),
    Hub("Activity and audit", "Every action, who did it and the result", Icons.Outlined.History, Routes.ACTIVITY),
    Hub("Privacy and permissions", "What each connection can see and keep", Icons.Outlined.PrivacyTip, Routes.PRIVACY),
)

@Composable
fun ConnectionsScreen() {
    val h = LocalHousehold.current
    val nav = LocalActions.current
    val graph = AppGraph.get(LocalContext.current)
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    val (status, reload) = rememberRemote(h.hid) { graph.connect.status(h.hid) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { reload() }
    ListScreen("Connections", subtitle = h.household.name) {
        item {
            RemoteBody(status, reload) { s ->
                Column {
                    SectionHeader("Status")
                    GroupedList {
                        val agents = s.obj("agents")
                        StatusRow("Assistant on this phone", agents.str("phone"))
                        Divider(); StatusRow("Server assistant (fallback)", agents.str("server"))
                        Divider()
                        val integ = s.obj("integrations")
                        HomeHubListTile("Integrations", subtitle = if (integ.isEmpty()) "None connected" else integ.entries.joinToString(" · ") { "${it.value} ${statusLabel(it.key).lowercase()}" })
                        Divider()
                        val dev = s.obj("devices")
                        val offline = dev.num("offline")?.toInt() ?: 0
                        HomeHubListTile("Devices", subtitle = "${dev.num("total")?.toInt() ?: 0} total", trailing = { if (offline > 0) StatusBadge("$offline offline", Tone.Warning, Icons.Outlined.WifiOff) })
                        Divider()
                        val runs = s.obj("automations24h")
                        HomeHubListTile("Automations, last 24 h", subtitle = if (runs.isEmpty()) "No runs" else runs.entries.joinToString(" · ") { "${it.value} ${humanize(it.key).lowercase()}" })
                    }
                    if (s.bool("paused")) {
                        Spacer(Modifier.size(Space.sm))
                        HomeHubCard { Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.PauseCircle, null, tint = c.warning); Spacer(Modifier.width(Space.xs))
                            Text("Automated actions are paused for this household.", style = t.bodyCompact, color = c.ink)
                        } }
                    }
                }
            }
        }
        item {
            Column {
                SectionHeader("Manage")
                GroupedList {
                    HUB.filter { !it.managersOnly || h.role.isManager }.forEachIndexed { i, e ->
                        if (i > 0) Divider()
                        HomeHubListTile(e.title, subtitle = e.subtitle, leadingIcon = e.icon, onClick = { nav.go(e.route) })
                    }
                }
            }
        }
        status.value?.arr("recentEvents")?.objects()?.takeIf { it.isNotEmpty() }?.let { events ->
            item {
                Column {
                    SectionHeader("Recent activity", action = "See all", onAction = { nav.go(Routes.ACTIVITY) })
                    GroupedList { events.take(5).forEachIndexed { i, e -> if (i > 0) Divider(); AuditRow(e, h.zone) } }
                }
            }
        }
    }
}

@Composable
private fun StatusRow(title: String, status: String?) {
    HomeHubListTile(title, trailing = { StatusBadge(statusLabel(status), statusTone(status), if (statusTone(status) == Tone.Success) Icons.Outlined.CheckCircle else Icons.Outlined.ErrorOutline) })
}

@Composable
private fun AuditRow(e: JsonObject, zone: java.time.ZoneId) {
    val target = e.obj("target")
    val result = e.str("result")
    HomeHubListTile(
        humanize(e.str("requestedAction")),
        subtitle = listOfNotNull(target.str("name") ?: target.str("type")?.let(::humanize), e.str("channel")?.let(::humanize), whenText(e.str("createdAt"), zone)).joinToString(" · "),
        trailing = { StatusBadge(statusLabel(result), statusTone(result)) },
    )
}

// ---------------------------------------------------------------------------------------------
// AI model accounts (bring your own)
// ---------------------------------------------------------------------------------------------

@Composable
fun ModelAccountsScreen() {
    val h = LocalHousehold.current
    val nav = LocalActions.current
    val graph = AppGraph.get(LocalContext.current)
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    val (data, reload) = rememberRemote(h.hid) { graph.connect.modelAccounts(h.hid) }
    // Returning from the browser sign-in lands here (homehub://model-accounts) — refresh.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { reload() }
    var keyFor by remember { mutableStateOf<JsonObject?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    var removing by remember { mutableStateOf<JsonObject?>(null) }
    val canUse = h.role.isAdultPlus

    ListScreen("AI model", subtitle = "Whose account the assistant uses") {
        item {
            RemoteBody(data, reload) { d ->
                Column {
                    Spacer(Modifier.size(Space.md))
                    val active = d["active"] as? JsonObject
                    HomeHubCard {
                        Text(if (active != null) "Using ${active.str("label")}" else "No model account yet", style = t.cardTitle, color = c.ink)
                        Spacer(Modifier.size(Space.xxs))
                        Text(
                            if (active != null) "Quick requests: ${active.str("modelSimple")} · Planning: ${active.str("modelComplex")}. Your key stays on HomeHub's server; it never reaches this phone."
                            else "Connect your own account to use the assistant. Everything else in HomeHub works without one.",
                            style = t.bodyCompact, color = c.inkSecondary,
                        )
                    }
                    val accounts = d.arr("items").objects()
                    if (accounts.isNotEmpty()) {
                        SectionHeader("Connected accounts")
                        GroupedList {
                            accounts.forEachIndexed { i, a ->
                                if (i > 0) Divider()
                                val iid = a.str("id")!!
                                HomeHubListTile(
                                    a.str("name") ?: "Account",
                                    subtitle = listOfNotNull(if (a.str("scope") == "household") "Household account" else "Your account", statusLabel(a.str("status")), a.str("lastError")).joinToString(" · "),
                                    leadingIcon = Icons.Outlined.Key,
                                    trailing = {
                                        if (a.bool("isDefault")) StatusBadge("Default", Tone.Brand, Icons.Outlined.CheckCircle)
                                        else if (a.bool("ownedByMe") || h.role.isManager) HomeHubButton("Use", {
                                            busy = iid
                                            scope.launch { runCatching { graph.connect.makeDefault(h.hid, iid) }.onFailure { nav.toast(friendly(it)) }; busy = null; reload() }
                                        }, kind = ButtonKind.Tertiary, loading = busy == iid)
                                    },
                                    onClick = if (a.bool("ownedByMe") || h.role.isManager) ({ removing = a }) else null,
                                )
                            }
                        }
                    }
                    SectionHeader("Add an account")
                    if (!canUse) Text("Only adults can connect a model account.", style = t.bodyCompact, color = c.inkSecondary)
                    else GroupedList {
                        d.arr("providers").objects().forEachIndexed { i, p ->
                            if (i > 0) Divider()
                            val oauth = p.str("signIn") == "oauth"
                            HomeHubListTile(
                                p.str("name") ?: "",
                                subtitle = if (oauth) "Sign in with your account; reaches Claude, GPT, Gemini, Llama and more" else "Paste an API key from your ${p.str("name")} account",
                                trailing = {
                                    HomeHubButton(if (oauth) "Sign in" else "Add key", {
                                        if (oauth) {
                                            busy = "openrouter"
                                            scope.launch {
                                                runCatching { graph.connect.startOpenRouter(h.hid, "personal") }
                                                    .onSuccess { url -> context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                                                    .onFailure { nav.toast(friendly(it)) }
                                                busy = null
                                            }
                                        } else keyFor = p
                                    }, kind = ButtonKind.Secondary, loading = oauth && busy == "openrouter")
                                },
                            )
                        }
                    }
                    Spacer(Modifier.size(Space.sm))
                    Text("Usage is billed by the provider to the account you connect. HomeHub records only token counts.", style = t.caption, color = c.inkTertiary)
                }
            }
        }
    }

    keyFor?.let { p ->
        ApiKeySheet(p, canHousehold = h.role.isManager, onDismiss = { keyFor = null }) { key, simple, complex, household ->
            val cfg = buildMap { if (simple.isNotBlank()) put("modelSimple", simple.trim()); if (complex.isNotBlank()) put("modelComplex", complex.trim()) }
            val r = runCatching { graph.connect.connect(h.hid, p.str("pluginId")!!, cfg, mapOf("apiKey" to key.trim()), if (household) "household" else "personal") }
            r.onSuccess { res ->
                val iid = res?.str("integrationId")
                if (iid != null && res.str("status") == "connected") runCatching { graph.connect.makeDefault(h.hid, iid) }
                nav.toast(if (res?.str("status") == "connected") "Connected" else "Saved, but the key was rejected — check it and try again")
                keyFor = null; reload()
            }.onFailure { nav.toast(friendly(it)) }
        }
    }
    removing?.let { a ->
        ConfirmationDialog("Remove ${a.str("name")}?", "HomeHub deletes the stored key. You can also revoke it in your provider account.", "Remove", destructive = true,
            onConfirm = { val iid = a.str("id")!!; removing = null; scope.launch { runCatching { graph.connect.disconnect(h.hid, iid, false) }.onFailure { nav.toast(friendly(it)) }; reload() } },
            onDismiss = { removing = null })
    }
}

@Composable
private fun ApiKeySheet(p: JsonObject, canHousehold: Boolean, onDismiss: () -> Unit, onSave: suspend (String, String, String, Boolean) -> Unit) {
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    val scope = rememberCoroutineScope()
    var key by remember { mutableStateOf("") }
    var simple by remember { mutableStateOf("") }
    var complex by remember { mutableStateOf("") }
    var household by remember { mutableStateOf(false) }
    var consent by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    FormSheet("Add ${p.str("name")} key", onDismiss) {
        HomeHubTextField("API key", key, { key = it }, password = true, helper = "Stored in Google Secret Manager on HomeHub's server. It's never shown again or stored on this phone.")
        HomeHubTextField("Model for quick requests", simple, { simple = it }, optional = true, helper = "Leave blank for HomeHub's default for this provider.")
        HomeHubTextField("Model for planning", complex, { complex = it }, optional = true)
        if (canHousehold) CheckRow("Share with the household (members without their own account use it)", household) { household = it }
        CheckRow("I understand my assistant requests and a compact household summary are sent to ${p.str("name")} under my account.", consent) { consent = it }
        HomeHubButton("Connect", {
            saving = true
            scope.launch { onSave(key, simple, complex, household); saving = false }
        }, Modifier.fillMaxWidth(), enabled = key.length >= 8 && consent, loading = saving)
        Text("You can remove the key here at any time.", style = t.caption, color = c.inkTertiary)
    }
}

@Composable
private fun CheckRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    val c = HomeHubTheme.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(role = Role.Checkbox) { onChange(!checked) }, verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked, onChange, colors = CheckboxDefaults.colors(checkedColor = c.brand))
        Text(label, style = HomeHubTheme.type.bodyCompact, color = c.ink)
    }
}

// ---------------------------------------------------------------------------------------------
// Integrations marketplace
// ---------------------------------------------------------------------------------------------

private val CATEGORY = mapOf("smart_home" to "Smart home", "developer" to "Developer", "channels" to "Messaging", "productivity" to "Email, calendar and files",
    "finance" to "Finance", "shopping" to "Shopping", "information" to "Information", "ai_provider" to "AI models")

@Composable
fun IntegrationsScreen() {
    val h = LocalHousehold.current
    val nav = LocalActions.current
    val graph = AppGraph.get(LocalContext.current)
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    val (data, reload) = rememberRemote(h.hid) { graph.connect.catalog() to graph.connect.integrations(h.hid) }
    var open by remember { mutableStateOf<JsonObject?>(null) }
    var openConnected by remember { mutableStateOf<JsonObject?>(null) }
    var filter by remember { mutableIntStateOf(0) }

    ListScreen("Integrations", subtitle = "Connect services and devices") {
        item {
            RemoteBody(data, reload) { (catalog, connected) ->
                val entries = catalog.objects().filter { it.str("category") != "ai_provider" }
                val mine = connected.objects().filter { it.str("category") != "ai_provider" }
                Column {
                    Spacer(Modifier.size(Space.md))
                    HomeHubListTile("AI model accounts", subtitle = "Managed in AI model", leadingIcon = Icons.Outlined.AutoAwesome, onClick = { nav.go(Routes.MODEL_ACCOUNTS) })
                    if (mine.isNotEmpty()) {
                        SectionHeader("Connected")
                        GroupedList {
                            mine.forEachIndexed { i, x ->
                                if (i > 0) Divider()
                                HomeHubListTile(x.str("name") ?: "", subtitle = x.str("lastError") ?: "Connected ${whenText(x.str("connectedAt"), h.zone)}", leadingIcon = Icons.Outlined.Hub,
                                    trailing = { StatusBadge(statusLabel(x.str("status")), statusTone(x.str("status"))) }, onClick = { openConnected = x })
                            }
                        }
                    }
                    SectionHeader("Catalog")
                    SegmentedFilter(listOf("Available", "Coming later"), filter, { filter = it })
                    Spacer(Modifier.size(Space.sm))
                    val shown = entries.filter { if (filter == 0) it.str("availability") != "planned" else it.str("availability") == "planned" }
                    shown.groupBy { CATEGORY[it.str("category")] ?: humanize(it.str("category")) }.forEach { (cat, list) ->
                        Text(cat, style = t.label, color = c.inkSecondary, modifier = Modifier.padding(top = Space.sm, bottom = Space.xxs))
                        GroupedList {
                            list.forEachIndexed { i, e ->
                                if (i > 0) Divider()
                                val av = e.str("availability")
                                HomeHubListTile(e.str("name") ?: "", subtitle = e.str("note") ?: e.str("description"),
                                    trailing = { if (av != "available") StatusBadge(if (av == "planned") "Planned" else statusLabel(av), Tone.Neutral) },
                                    onClick = if (av == "available") ({ open = e }) else null)
                            }
                        }
                    }
                    Spacer(Modifier.size(Space.sm))
                    Text("“Planned” integrations aren't built yet. HomeHub only lists something as available once it works and is tested.", style = t.caption, color = c.inkTertiary)
                }
            }
        }
    }
    open?.let { e -> ConnectSheet(e, onDismiss = { open = null }, onDone = { open = null; reload() }) }
    openConnected?.let { x -> ConnectedSheet(x, onDismiss = { openConnected = null }, onChanged = { openConnected = null; reload() }) }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ConnectSheet(e: JsonObject, onDismiss: () -> Unit, onDone: () -> Unit) {
    val h = LocalHousehold.current
    val nav = LocalActions.current
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    val values = remember { mutableStateMapOf<String, String>() }
    var consent by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    val fields = e.arr("config").objects()
    FormSheet(e.str("name") ?: "Connect", onDismiss) {
        Text(e.str("description") ?: "", style = t.body, color = c.inkSecondary)
        Text("What it can do", style = t.label, color = c.ink)
        e.arr("tools").objects().forEach { tool ->
            Column {
                Text(tool.str("description") ?: "", style = t.bodyCompact, color = c.ink)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                    StatusBadge(if (tool.str("access") == "read") "Reads" else "Makes changes", Tone.Neutral)
                    when (tool.str("confirmation")) {
                        "approval" -> StatusBadge("Always needs approval", Tone.Warning, Icons.Outlined.Lock)
                        "confirm" -> StatusBadge("Asks you to confirm", Tone.Info)
                    }
                    if (tool.bool("physicalSafety")) StatusBadge("Physical safety", Tone.Danger)
                }
            }
        }
        e.strList("dataCategories").takeIf { it.isNotEmpty() }?.let { Text("Data it uses: ${it.joinToString(", ")}", style = t.bodyCompact, color = c.inkSecondary) }
        e.obj("privacy").str("retention")?.let { Text(it, style = t.caption, color = c.inkSecondary) }
        if (!h.role.isManager) {
            Text("Ask a household manager to connect this.", style = t.bodyCompact, color = c.inkSecondary)
            return@FormSheet
        }
        fields.forEach { f ->
            val key = f.str("key")!!
            HomeHubTextField(f.str("label") ?: key, values[key].orEmpty(), { values[key] = it }, optional = !f.bool("required"), password = f.bool("secret"),
                helper = f.str("help") ?: if (f.bool("secret")) "Stored in Secret Manager; never shown again." else null)
        }
        CheckRow("I allow ${e.str("name")} to access the data listed above for this household.", consent) { consent = it }
        val missing = fields.any { it.bool("required") && values[it.str("key")].isNullOrBlank() }
        HomeHubButton("Connect", {
            saving = true
            scope.launch {
                val cfg = fields.filter { !it.bool("secret") }.mapNotNull { f -> values[f.str("key")]?.takeIf { it.isNotBlank() }?.let { f.str("key")!! to it.trim() } }.toMap()
                val sec = fields.filter { it.bool("secret") }.mapNotNull { f -> values[f.str("key")]?.takeIf { it.isNotBlank() }?.let { f.str("key")!! to it } }.toMap()
                runCatching { graph.connect.connect(h.hid, e.str("id")!!, cfg, sec) }
                    .onSuccess { r -> nav.toast(if (r?.str("status") == "connected") "${e.str("name")} connected" else "Connected — needs attention: ${statusLabel(r?.str("status"))}"); onDone() }
                    .onFailure { nav.toast(friendly(it)) }
                saving = false
            }
        }, Modifier.fillMaxWidth(), enabled = consent && !missing, loading = saving)
    }
}

@Composable
private fun ConnectedSheet(x: JsonObject, onDismiss: () -> Unit, onChanged: () -> Unit) {
    val h = LocalHousehold.current
    val nav = LocalActions.current
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    val iid = x.str("id")!!
    var busy by remember { mutableStateOf<String?>(null) }
    var confirm by remember { mutableStateOf(false) }
    val paused = x.str("status") == "paused"
    fun act(label: String, block: suspend () -> Unit) { busy = label; scope.launch { runCatching { block() }.onFailure { nav.toast(friendly(it)) }; busy = null } }
    FormSheet(x.str("name") ?: "Integration", onDismiss) {
        Row(verticalAlignment = Alignment.CenterVertically) { StatusBadge(statusLabel(x.str("status")), statusTone(x.str("status"))) }
        x.str("lastError")?.let { Text(it, style = t.bodyCompact, color = c.danger) }
        Text("Tools turned on: ${x.strList("enabledTools").joinToString(", ") { humanize(it) }}", style = t.bodyCompact, color = c.inkSecondary)
        if (!h.role.isManager) { Text("Only household managers can change integrations.", style = t.bodyCompact, color = c.inkSecondary); return@FormSheet }
        HomeHubButton("Test connection", { act("test") { val r = graph.connect.test(h.hid, iid); nav.toast("Status: ${statusLabel(r?.str("status"))}"); onChanged() } },
            Modifier.fillMaxWidth(), kind = ButtonKind.Secondary, loading = busy == "test", enabled = !paused)
        HomeHubButton(if (paused) "Resume" else "Pause", { act("pause") { graph.connect.pause(h.hid, iid, !paused); onChanged() } }, Modifier.fillMaxWidth(), kind = ButtonKind.Secondary, loading = busy == "pause")
        HomeHubButton("Disconnect", { confirm = true }, Modifier.fillMaxWidth(), kind = ButtonKind.Destructive, loading = busy == "disconnect")
    }
    if (confirm) ConfirmationDialog("Disconnect ${x.str("name")}?", "Stored credentials are deleted and its devices stop working in HomeHub. Device history is kept.", "Disconnect", destructive = true,
        onConfirm = { confirm = false; act("disconnect") { graph.connect.disconnect(h.hid, iid, false); nav.toast("Disconnected"); onChanged() } }, onDismiss = { confirm = false })
}

// ---------------------------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------------------------

private fun JsonObject.caps() = strList("capabilities")

private fun stateSummary(d: JsonObject): String {
    val s = d.obj("state")
    val parts = mutableListOf<String>()
    s.str("power")?.let { parts += if (it == "ON") "On" else "Off" }
    s.num("brightness")?.let { if (d.caps().contains("brightness")) parts += "${it.toInt()}%" }
    s.num("targetTemperature")?.let { parts += "Set to ${it}°" }
    s.num("temperature")?.let { parts += "${it}°C" }
    s.num("humidity")?.let { parts += "${it.toInt()}% humidity" }
    s.str("lock")?.let { parts += if (it == "LOCKED") "Locked" else if (it == "UNLOCKED") "Unlocked" else "Unknown" }
    s.str("contact")?.let { parts += if (it == "DETECTED") "Open" else "Closed" }
    s.str("motion")?.let { parts += if (it == "DETECTED") "Motion" else "No motion" }
    return parts.joinToString(" · ").ifEmpty { "No state yet" }
}

private fun deviceIcon(type: String?) = when (type) {
    "lock" -> Icons.Outlined.Lock; "thermostat", "ac", "climate_sensor" -> Icons.Outlined.Thermostat
    "contact_sensor", "motion_sensor" -> Icons.Outlined.Sensors; else -> Icons.Outlined.PowerSettingsNew
}

@Composable
fun DevicesScreen() {
    val h = LocalHousehold.current
    val nav = LocalActions.current
    val graph = AppGraph.get(LocalContext.current)
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    val (data, reload) = rememberRemote(h.hid) { graph.connect.devices(h.hid) }
    var open by remember { mutableStateOf<JsonObject?>(null) }
    val scope = rememberCoroutineScope()
    ListScreen("Devices", subtitle = h.household.name) {
        item {
            RemoteBody(data, reload) { d ->
                val devices = d.arr("devices").objects()
                val rooms = d.arr("rooms").objects()
                if (devices.isEmpty()) EmptyState(Icons.Outlined.Devices, "No devices yet", "Connect “Demo devices” to try HomeHub without hardware, or pair a home bridge.", actionLabel = "Open integrations", onAction = { nav.go(Routes.INTEGRATIONS) })
                else Column {
                    if (devices.any { it.bool("simulated") }) {
                        Spacer(Modifier.size(Space.md))
                        HomeHubCard { Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.Science, null, tint = c.info); Spacer(Modifier.width(Space.xs))
                            Text("Some devices are simulated. Nothing physical is controlled.", style = t.bodyCompact, color = c.ink)
                        } }
                    }
                    val byRoom = devices.groupBy { it.str("roomId") }
                    byRoom.forEach { (rid, list) ->
                        val room = rooms.firstOrNull { it.str("id") == rid }
                        Row(Modifier.fillMaxWidth().padding(top = Space.xl, bottom = Space.xs), verticalAlignment = Alignment.CenterVertically) {
                            Text(room?.str("name") ?: "No room", style = t.sectionTitle, color = c.ink, modifier = Modifier.weight(1f))
                            if (h.role.isManager && room != null) {
                                val exposed = room.bool("alexaExposed")
                                Text("Alexa", style = t.caption, color = c.inkSecondary)
                                Spacer(Modifier.width(Space.xs))
                                Switch(exposed, { v -> scope.launch { runCatching { graph.connect.exposeRoom(h.hid, rid!!, v) }.onFailure { nav.toast(friendly(it)) }; reload() } },
                                    modifier = Modifier.semantics { contentDescription = "Let Alexa see ${room.str("name")}" },
                                    colors = SwitchDefaults.colors(checkedTrackColor = c.brand))
                            }
                        }
                        GroupedList {
                            list.forEachIndexed { i, dev ->
                                if (i > 0) Divider()
                                val offline = !dev.bool("reachable") && dev["reachable"] != null
                                HomeHubListTile(dev.str("name") ?: "Device", subtitle = stateSummary(dev), leadingIcon = deviceIcon(dev.str("type")),
                                    trailing = {
                                        Row(horizontalArrangement = Arrangement.spacedBy(Space.xxs)) {
                                            if (offline) StatusBadge("Offline", Tone.Warning, Icons.Outlined.WifiOff)
                                            if (dev.obj("alexa").bool("exposed")) StatusBadge("Alexa", Tone.Neutral)
                                        }
                                    },
                                    onClick = { open = dev })
                            }
                        }
                    }
                }
            }
        }
    }
    open?.let { dev -> DeviceSheet(dev, onDismiss = { open = null }, onChanged = { reload() }) }
}

@Composable
private fun DeviceSheet(dev: JsonObject, onDismiss: () -> Unit, onChanged: () -> Unit) {
    val h = LocalHousehold.current
    val nav = LocalActions.current
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    val did = dev.str("id")!!
    var state by remember { mutableStateOf(dev.obj("state")) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var confirmAction by remember { mutableStateOf<JsonObject?>(null) }
    var exposed by remember { mutableStateOf(dev.obj("alexa").bool("exposed")) }
    val caps = dev.caps()
    val bridge = dev.str("integrationId")?.startsWith("bridge:") == true
    val safety = dev.str("safety") == "physical_safety"
    // Mirrors the server policy: children and staff may switch ordinary devices, never safety ones.
    val canControl = !bridge && (!safety || h.role.isAdultPlus)

    fun run(action: JsonObject, confirmed: Boolean = false) {
        busy = true; message = null
        scope.launch {
            runCatching { graph.connect.deviceAction(h.hid, did, action, confirmed) }.onSuccess { r ->
                when (r.str("status")) {
                    "verified" -> { state = JsonObject(state + r.obj("state")); message = "Done. The device confirmed it."; onChanged() }
                    "approval_required" -> message = "Sent for approval. Nothing changes until someone approves it in Approvals."
                    "confirmation_required" -> confirmAction = action
                    "unverified" -> { message = "Sent, but the device didn't confirm the change. Check the device."; onChanged() }
                    else -> message = r.str("message") ?: "The device didn't respond."
                }
            }.onFailure { message = friendly(it) }
            busy = false
        }
    }
    fun power(on: Boolean) = buildJsonObject { put("type", "power"); put("value", if (on) "ON" else "OFF") }

    FormSheet(dev.str("name") ?: "Device", onDismiss) {
        Row(horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
            if (dev.bool("simulated")) StatusBadge("Simulated", Tone.Info, Icons.Outlined.Science)
            if (safety) StatusBadge("Physical safety", Tone.Warning, Icons.Outlined.Lock)
        }
        Text(stateSummary(JsonObject(dev + ("state" to state))), style = t.body, color = c.ink, modifier = Modifier.semantics { stateDescription = stateSummary(JsonObject(dev + ("state" to state))) })
        if (bridge) Text("This device is reported by your home bridge. Control arrives with the Home Assistant bridge.", style = t.bodyCompact, color = c.inkSecondary)
        if (canControl && !bridge) {
            if ("power" in caps) {
                val on = state.str("power") == "ON"
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("Power", style = t.cardTitle, color = c.ink, modifier = Modifier.weight(1f))
                    Switch(on, { run(power(it)) }, enabled = !busy, modifier = Modifier.semantics { contentDescription = "Power" }, colors = SwitchDefaults.colors(checkedTrackColor = c.brand))
                }
            }
            if ("brightness" in caps) {
                var v by remember { mutableFloatStateOf((state.num("brightness") ?: 50.0).toFloat()) }
                Text("Brightness ${v.toInt()}%", style = t.label, color = c.ink)
                Slider(v, { v = it }, valueRange = 0f..100f, steps = 9, enabled = !busy,
                    onValueChangeFinished = { run(buildJsonObject { put("type", "brightness"); put("value", v.toInt()) }) },
                    colors = SliderDefaults.colors(thumbColor = c.brand, activeTrackColor = c.brand))
            }
            if ("thermostat" in caps) {
                val target = state.num("targetTemperature") ?: 24.0
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    Text("Target ${target}°C", style = t.cardTitle, color = c.ink, modifier = Modifier.weight(1f))
                    HomeHubButton("−", { run(buildJsonObject { put("type", "thermostat"); put("targetTemperature", (target - 1).coerceAtLeast(16.0)) }) }, kind = ButtonKind.Secondary, enabled = !busy && target > 16)
                    HomeHubButton("+", { run(buildJsonObject { put("type", "thermostat"); put("targetTemperature", (target + 1).coerceAtMost(30.0)) }) }, kind = ButtonKind.Secondary, enabled = !busy && target < 30)
                }
            }
            if ("lock" in caps && h.role.isAdultPlus) {
                val locked = state.str("lock") == "LOCKED"
                if (locked) HomeHubButton("Unlock (needs approval)", { run(buildJsonObject { put("type", "unlock") }) }, Modifier.fillMaxWidth(), kind = ButtonKind.Secondary, icon = Icons.Outlined.LockOpen, loading = busy)
                else HomeHubButton("Lock", { run(buildJsonObject { put("type", "lock") }) }, Modifier.fillMaxWidth(), icon = Icons.Outlined.Lock, loading = busy)
            }
        } else if (!bridge) Text("Ask an adult to use this device.", style = t.bodyCompact, color = c.inkSecondary)
        message?.let { Text(it, style = t.bodyCompact, color = c.inkSecondary, modifier = Modifier.semantics { contentDescription = it }) }
        if (h.role.isManager) {
            Divider()
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Let Alexa see this device", style = t.cardTitle, color = c.ink)
                    Text(if (safety) "Alexa can lock it but never unlock it." else "Off by default. Changes apply at Alexa's next discovery.", style = t.caption, color = c.inkSecondary)
                }
                Switch(exposed, { v -> exposed = v; scope.launch { runCatching { graph.connect.exposeDevice(h.hid, did, v) }.onFailure { exposed = !v; nav.toast(friendly(it)) }; onChanged() } },
                    colors = SwitchDefaults.colors(checkedTrackColor = c.brand))
            }
        }
    }
    confirmAction?.let { a ->
        ConfirmationDialog("Confirm", "Do this now on ${dev.str("name")}?", "Confirm", onConfirm = { confirmAction = null; run(a, confirmed = true) }, onDismiss = { confirmAction = null })
    }
}

// ---------------------------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------------------------

private fun triggerText(tr: JsonObject, deviceName: (String?) -> String?): String = when (tr.str("type")) {
    "schedule" -> "Every day at ${tr.str("time")}"
    "device_state" -> "When ${deviceName(tr.str("deviceId")) ?: "a device"} ${humanize(tr.str("property")).lowercase()} changes"
    "pantry_low" -> "When something in the pantry runs low"
    "bill_due" -> "When a bill is due within ${tr.num("withinDays")?.toInt() ?: 3} days"
    "webhook" -> "When a signed webhook arrives"
    else -> "When you run it"
}

private fun actionText(a: JsonObject, deviceName: (String?) -> String?): String = when (a.str("type")) {
    "create_task" -> "Create task “${a.str("title")}”"
    "notify" -> "Notify ${a.str("audience") ?: "adults"}: ${a.str("title")}"
    "add_shopping_item" -> "Add ${a.str("name")} to the shopping list"
    "device_action" -> "${humanize(a.str("action"))} ${deviceName(a.str("deviceId")) ?: "a device"}"
    else -> humanize(a.str("type"))
}

@Composable
fun AutomationsScreen() {
    val h = LocalHousehold.current
    val nav = LocalActions.current
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    val (data, reload) = rememberRemote(h.hid) { graph.connect.automations(h.hid) to runCatching { graph.connect.devices(h.hid).arr("devices").objects() }.getOrDefault(emptyList()) }
    var open by remember { mutableStateOf<JsonObject?>(null) }
    var creating by remember { mutableStateOf(false) }
    ListScreen("Automations", subtitle = "When this happens, do that",
        fabIcon = if (h.role.isManager) Icons.Outlined.Bolt else null, fabLabel = "New automation", onFab = if (h.role.isManager) ({ creating = true }) else null) {
        item {
            RemoteBody(data, reload) { (items, devices) ->
                val name = { id: String? -> devices.firstOrNull { it.str("id") == id }?.str("name") }
                val list = items.objects()
                if (list.isEmpty()) EmptyState(Icons.Outlined.Bolt, "No automations yet", "Automations run checks and actions for you, like a task when the balcony door opens. Unlocking and payments always need approval.",
                    actionLabel = if (h.role.isManager) "Create one" else null, onAction = if (h.role.isManager) ({ creating = true }) else null)
                else Column {
                    Spacer(Modifier.size(Space.md))
                    GroupedList {
                        list.forEachIndexed { i, a ->
                            if (i > 0) Divider()
                            val enabled = a.bool("enabled")
                            HomeHubListTile(a.str("name") ?: "Automation",
                                subtitle = "${triggerText(a.obj("trigger"), name)} → ${a.arr("actions").objects().joinToString(", ") { actionText(it, name) }}",
                                leadingIcon = if (a.obj("trigger").str("type") == "schedule") Icons.Outlined.Schedule else Icons.Outlined.Bolt,
                                trailing = {
                                    Column(horizontalAlignment = Alignment.End) {
                                        if (h.role.isManager) Switch(enabled, { v ->
                                            scope.launch { runCatching { graph.connect.saveAutomation(h.hid, automationBody(a, enabled = v), a.str("id")) }.onFailure { nav.toast(friendly(it)) }; reload() }
                                        }, modifier = Modifier.semantics { contentDescription = "Enabled" }, colors = SwitchDefaults.colors(checkedTrackColor = c.brand))
                                        a.str("lastStatus")?.let { StatusBadge(statusLabel(it), statusTone(it)) }
                                    }
                                },
                                onClick = { open = a })
                        }
                    }
                    Spacer(Modifier.size(Space.sm))
                    Text("Automations stop when the household is paused, after their daily limit, and can't trigger themselves in a loop.", style = t.caption, color = c.inkTertiary)
                }
            }
        }
    }
    open?.let { a -> AutomationSheet(a, data.value?.second.orEmpty(), onDismiss = { open = null }, onChanged = { open = null; reload() }) }
    if (creating) NewAutomationSheet(data.value?.second.orEmpty(), onDismiss = { creating = false }, onSaved = { creating = false; reload() })
}

/** Rebuild the server input from a stored automation (server fields like lastRunAt are dropped). */
private fun automationBody(a: JsonObject, enabled: Boolean = a.bool("enabled")) = buildJsonObject {
    put("name", a.str("name") ?: "Automation"); put("enabled", enabled)
    put("trigger", a.obj("trigger")); put("conditions", a.arr("conditions")); put("actions", a.arr("actions"))
    a.num("cooldownMinutes")?.let { put("cooldownMinutes", it.toInt()) }; a.num("maxRunsPerDay")?.let { put("maxRunsPerDay", it.toInt()) }
}

@Composable
private fun AutomationSheet(a: JsonObject, devices: List<JsonObject>, onDismiss: () -> Unit, onChanged: () -> Unit) {
    val h = LocalHousehold.current
    val nav = LocalActions.current
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    val id = a.str("id")!!
    val name = { d: String? -> devices.firstOrNull { it.str("id") == d }?.str("name") }
    val (runs, reloadRuns) = rememberRemote(id) { graph.connect.automationRuns(h.hid, id) }
    var result by remember { mutableStateOf<JsonObject?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    fun test(execute: Boolean) {
        busy = if (execute) "run" else "preview"
        scope.launch { runCatching { graph.connect.testAutomation(h.hid, id, execute) }.onSuccess { result = it; if (execute) reloadRuns() }.onFailure { nav.toast(friendly(it)) }; busy = null }
    }
    FormSheet(a.str("name") ?: "Automation", onDismiss) {
        Text(triggerText(a.obj("trigger"), name), style = t.body, color = c.ink)
        a.arr("actions").objects().forEach { Text("• ${actionText(it, name)}", style = t.bodyCompact, color = c.inkSecondary) }
        Text("Waits ${a.num("cooldownMinutes")?.toInt() ?: 5} min between runs · at most ${a.num("maxRunsPerDay")?.toInt() ?: 24} runs a day", style = t.caption, color = c.inkTertiary)
        if (h.role.isManager) {
            Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                HomeHubButton("Preview", { test(false) }, Modifier.weight(1f), kind = ButtonKind.Secondary, loading = busy == "preview")
                HomeHubButton("Run now", { test(true) }, Modifier.weight(1f), loading = busy == "run")
            }
        }
        result?.let { r ->
            HomeHubCard {
                Row { StatusBadge(statusLabel(r.str("status")), statusTone(r.str("status"))) }
                r.str("reason")?.let { Text(it, style = t.bodyCompact, color = c.inkSecondary) }
                r.arr("steps").objects().forEach { s -> Text("${humanize(s.str("status"))}: ${s.str("detail") ?: humanize(s.str("action"))}", style = t.bodyCompact, color = c.ink) }
            }
        }
        Text("Recent runs", style = t.label, color = c.ink)
        RemoteBody(runs, reloadRuns) { list ->
            if (list.isEmpty()) Text("Hasn't run yet.", style = t.bodyCompact, color = c.inkSecondary)
            else GroupedList { list.objects().take(10).forEachIndexed { i, r -> if (i > 0) Divider()
                HomeHubListTile(statusLabel(r.str("status")), subtitle = listOfNotNull(r.str("reason"), whenText(r.str("createdAt"), h.zone)).joinToString(" · "), trailing = { StatusBadge(statusLabel(r.str("status")), statusTone(r.str("status"))) }) } }
        }
        if (h.role.isManager) HomeHubButton("Delete automation", { confirmDelete = true }, Modifier.fillMaxWidth(), kind = ButtonKind.Tertiary)
    }
    if (confirmDelete) ConfirmationDialog("Delete ${a.str("name")}?", "It stops running immediately. Its run history is kept for 90 days.", "Delete", destructive = true,
        onConfirm = { confirmDelete = false; scope.launch { runCatching { graph.connect.deleteAutomation(h.hid, id) }.onFailure { nav.toast(friendly(it)) }; onChanged() } }, onDismiss = { confirmDelete = false })
}

@Composable
private fun NewAutomationSheet(devices: List<JsonObject>, onDismiss: () -> Unit, onSaved: () -> Unit) {
    val h = LocalHousehold.current
    val nav = LocalActions.current
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    var name by remember { mutableStateOf("") }
    var trigger by remember { mutableIntStateOf(0) } // 0 manual, 1 daily, 2 device, 3 pantry low, 4 bill due
    var time by remember { mutableStateOf("21:00") }
    var deviceIdx by remember { mutableIntStateOf(0) }
    var action by remember { mutableIntStateOf(0) } // 0 task, 1 notify, 2 device on/off
    var text by remember { mutableStateOf("") }
    var targetIdx by remember { mutableIntStateOf(0) }
    var turnOn by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    val sensors = devices.filter { d -> d.caps().any { it in listOf("contact", "motion", "power", "lock", "temperature") } }
    val switchable = devices.filter { "power" in it.caps() }
    val timeOk = Regex("^([01]\\d|2[0-3]):[0-5]\\d$").matches(time)
    FormSheet("New automation", onDismiss) {
        HomeHubTextField("Name", name, { name = it }, placeholder = "Night check")
        Text("When", style = t.label, color = c.ink)
        SegmentedFilter(listOf("I run it", "Daily", "Device", "Pantry low", "Bill due"), trigger, { trigger = it }, Modifier.fillMaxWidth())
        if (trigger == 1) HomeHubTextField("Time (24-hour)", time, { time = it }, error = if (!timeOk) "Use HH:MM, like 21:00" else null, helper = "In the household's time zone")
        if (trigger == 2) {
            if (sensors.isEmpty()) Text("No devices to watch yet.", style = t.bodyCompact, color = c.inkSecondary)
            else ChoiceList(sensors.map { "${it.str("name")} (${stateSummary(it)})" }, deviceIdx) { deviceIdx = it }
        }
        Text("Do", style = t.label, color = c.ink)
        SegmentedFilter(listOf("Create a task", "Notify adults", "Switch a device"), action, { action = it })
        if (action <= 1) HomeHubTextField(if (action == 0) "Task" else "Message", text, { text = it }, placeholder = if (action == 0) "Close the balcony door" else "Balcony door is open")
        if (action == 2) {
            if (switchable.isEmpty()) Text("No switchable devices.", style = t.bodyCompact, color = c.inkSecondary)
            else { ChoiceList(switchable.map { it.str("name") ?: "" }, targetIdx) { targetIdx = it }; CheckRow("Turn it on (otherwise off)", turnOn) { turnOn = it } }
        }
        val valid = name.isNotBlank() && (trigger != 1 || timeOk) && (trigger != 2 || sensors.isNotEmpty()) && (if (action <= 1) text.isNotBlank() else switchable.isNotEmpty())
        HomeHubButton("Save automation", {
            saving = true
            val body = buildJsonObject {
                put("name", name.trim())
                putJsonObject("trigger") {
                    when (trigger) {
                        1 -> { put("type", "schedule"); put("time", time) }
                        2 -> { val d = sensors[deviceIdx]; put("type", "device_state"); put("deviceId", d.str("id")); put("property", d.caps().first { it in listOf("contact", "motion", "power", "lock", "temperature") }) }
                        3 -> put("type", "pantry_low")
                        4 -> { put("type", "bill_due"); put("withinDays", 3) }
                        else -> put("type", "manual")
                    }
                }
                putJsonArray("actions") {
                    add(buildJsonObject {
                        when (action) {
                            0 -> { put("type", "create_task"); put("title", text.trim()) }
                            1 -> { put("type", "notify"); put("title", text.trim().take(120)); put("body", text.trim().take(300)); put("audience", "adults") }
                            else -> { put("type", "device_action"); put("deviceId", switchable[targetIdx].str("id")); put("action", if (turnOn) "power_on" else "power_off") }
                        }
                    })
                }
            }
            scope.launch { runCatching { graph.connect.saveAutomation(h.hid, body) }.onSuccess { nav.toast("Automation saved"); onSaved() }.onFailure { nav.toast(friendly(it)) }; saving = false }
        }, Modifier.fillMaxWidth(), enabled = valid, loading = saving)
        Text("Use Preview on the saved automation to check it before it runs for real.", style = t.caption, color = c.inkTertiary)
    }
}

@Composable
private fun ChoiceList(options: List<String>, selected: Int, onSelect: (Int) -> Unit) {
    GroupedList {
        options.forEachIndexed { i, o ->
            if (i > 0) Divider()
            HomeHubListTile(o, trailing = { if (i == selected) Icon(Icons.Outlined.CheckCircle, "Selected", tint = HomeHubTheme.colors.brand) }, onClick = { onSelect(i) })
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Channels and Alexa
// ---------------------------------------------------------------------------------------------

private val CHANNEL_NAMES = mapOf("app" to "HomeHub app", "push" to "Push notifications", "alexa" to "Amazon Alexa", "webhook" to "Signed webhooks",
    "telegram" to "Telegram", "whatsapp" to "WhatsApp", "email" to "Email", "sms" to "SMS")

@Composable
fun ChannelsScreen() {
    val h = LocalHousehold.current
    val nav = LocalActions.current
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    val (data, reload) = rememberRemote(h.hid) { graph.connect.channels(h.hid) }
    var confirm by remember { mutableStateOf(false) }
    ListScreen("Channels and Alexa", subtitle = "Where you can reach HomeHub") {
        item {
            RemoteBody(data, reload) { list ->
                val channels = list.objects()
                val alexa = channels.firstOrNull { it.str("type") == "alexa" }
                Column {
                    SectionHeader("Amazon Alexa")
                    HomeHubCard {
                        val st = alexa?.str("status")
                        val linkedMe = alexa?.strList("linkedMembers")?.contains(h.uid) == true
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(if (linkedMe) "Linked to your account" else "Not linked to your account", style = t.cardTitle, color = c.ink, modifier = Modifier.weight(1f))
                            StatusBadge(statusLabel(st), statusTone(st))
                        }
                        Spacer(Modifier.size(Space.xs))
                        Text(when {
                            st == "needs_platform_credentials" -> "Alexa isn't set up on this HomeHub server yet. A HomeHub administrator needs to add the Alexa skill credentials."
                            linkedMe -> "Say “Alexa, ask Home Hub what's on the shopping list”, or control devices you've shared. Alexa can lock doors but never unlock them."
                            else -> "In the Alexa app, open Skills, find HomeHub, choose Enable, then sign in with your HomeHub email. Only adults can link."
                        }, style = t.bodyCompact, color = c.inkSecondary)
                        Spacer(Modifier.size(Space.sm))
                        Text("HomeHub never receives or stores voice recordings — only the request type, time and result.", style = t.caption, color = c.inkTertiary)
                        Spacer(Modifier.size(Space.sm))
                        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                            HomeHubButton("Choose devices", { nav.go(Routes.DEVICES) }, kind = ButtonKind.Secondary)
                            if (linkedMe) HomeHubButton("Disconnect", { confirm = true }, kind = ButtonKind.Tertiary)
                        }
                    }
                    SectionHeader("All channels")
                    GroupedList {
                        channels.filter { it.str("type") != "alexa" }.forEachIndexed { i, ch ->
                            if (i > 0) Divider()
                            val st = ch.str("status")
                            HomeHubListTile(CHANNEL_NAMES[ch.str("type")] ?: humanize(ch.str("type")),
                                subtitle = when (ch.str("type")) { "webhook" -> "Set up in Integrations"; "app", "push" -> "Always on for members"; else -> if (!ch.bool("implemented")) "Not built yet" else null },
                                trailing = { StatusBadge(statusLabel(st), statusTone(st)) },
                                onClick = if (ch.str("type") == "webhook") ({ nav.go(Routes.INTEGRATIONS) }) else null)
                        }
                    }
                }
            }
        }
    }
    if (confirm) ConfirmationDialog("Disconnect Alexa?", "Alexa stops working with HomeHub for your account immediately. You can link again from the Alexa app.", "Disconnect", destructive = true,
        onConfirm = { confirm = false; scope.launch { runCatching { graph.connect.disconnectAlexa(h.hid) }.onSuccess { nav.toast("Alexa disconnected") }.onFailure { nav.toast(friendly(it)) }; reload() } },
        onDismiss = { confirm = false })
}

// ---------------------------------------------------------------------------------------------
// Agents and skills
// ---------------------------------------------------------------------------------------------

@Composable
fun AgentsScreen() {
    val h = LocalHousehold.current
    val nav = LocalActions.current
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    val (data, reload) = rememberRemote(h.hid) { graph.connect.agents(h.hid) }
    ListScreen("Agents and skills", subtitle = "What the assistant can do") {
        item {
            RemoteBody(data, reload) { d ->
                Column {
                    SectionHeader("Agents")
                    GroupedList {
                        d.arr("agents").objects().forEachIndexed { i, a ->
                            if (i > 0) Divider()
                            HomeHubListTile(a.str("name") ?: "", subtitle = a.str("description"), leadingIcon = Icons.Outlined.Psychology,
                                trailing = { StatusBadge(statusLabel(a.str("status")), statusTone(a.str("status"))) })
                        }
                    }
                    Spacer(Modifier.size(Space.xs))
                    Text(d.str("specialists") ?: "", style = t.caption, color = c.inkTertiary)
                    SectionHeader("Skills")
                    GroupedList {
                        d.arr("skills").objects().forEachIndexed { i, s ->
                            if (i > 0) Divider()
                            val u = s.obj("usage30d")
                            val locked = s.str("name") == "household-manager"
                            HomeHubListTile(humanize(s.str("name")), subtitle = "${s.str("description")} · ${u.num("runs")?.toInt() ?: 0} runs in 30 days",
                                trailing = {
                                    if (h.role.isManager) Switch(s.bool("enabled"), { v ->
                                        scope.launch { runCatching { graph.connect.setSkill(h.hid, s.str("name")!!, v) }.onFailure { nav.toast(friendly(it)) }; reload() }
                                    }, enabled = !locked, modifier = Modifier.semantics { contentDescription = "${humanize(s.str("name"))} enabled" }, colors = SwitchDefaults.colors(checkedTrackColor = c.brand))
                                    else StatusBadge(if (s.bool("enabled")) "On" else "Off", if (s.bool("enabled")) Tone.Success else Tone.Neutral)
                                })
                        }
                    }
                    Spacer(Modifier.size(Space.xs))
                    Text("Household manager is the fallback skill and stays on. Turning a skill off sends its requests to the household manager instead.", style = t.caption, color = c.inkTertiary)
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Activity and audit
// ---------------------------------------------------------------------------------------------

private val AUDIT_FILTERS = listOf<Pair<String, String?>>("All" to null, "App" to "app", "Alexa" to "alexa", "Automations" to "automation", "Assistant" to "agent", "Webhooks" to "webhook")

@Composable
fun ActivityScreen() {
    val h = LocalHousehold.current
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    var filter by remember { mutableIntStateOf(0) }
    val (data, reload) = rememberRemote(h.hid, filter) { graph.connect.audit(h.hid, AUDIT_FILTERS[filter].second, null).objects() }
    var more by remember(filter) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var loadingMore by remember { mutableStateOf(false) }
    ListScreen("Activity and audit", subtitle = if (h.role.isManager) "Everything that happened in ${h.household.name}" else "Your actions") {
        item { Column { Spacer(Modifier.size(Space.md)); SegmentedFilter(AUDIT_FILTERS.map { it.first }, filter, { filter = it }) } }
        item {
            RemoteBody(data, reload) { first ->
                val all = first + more
                if (all.isEmpty()) EmptyState(Icons.Outlined.History, "Nothing here yet", "Actions by people, the assistant, automations and Alexa appear here.")
                else Column {
                    Spacer(Modifier.size(Space.sm))
                    GroupedList { all.forEachIndexed { i, e -> if (i > 0) Divider(); AuditRow(e, h.zone) } }
                    if (all.size % 50 == 0) HomeHubButton("Load more", {
                        loadingMore = true
                        scope.launch { runCatching { graph.connect.audit(h.hid, AUDIT_FILTERS[filter].second, all.last().str("createdAt")).objects() }.onSuccess { more = more + it }; loadingMore = false }
                    }, Modifier.fillMaxWidth().padding(top = Space.sm), kind = ButtonKind.Tertiary, loading = loadingMore)
                    Text("Kept for the household's audit trail. Voice audio is never stored.", style = t.caption, color = c.inkTertiary, modifier = Modifier.padding(top = Space.sm))
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Privacy and permissions
// ---------------------------------------------------------------------------------------------

@Composable
fun PrivacyScreen() {
    val h = LocalHousehold.current
    val nav = LocalActions.current
    val graph = AppGraph.get(LocalContext.current)
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    val (data, reload) = rememberRemote(h.hid) { graph.connect.privacy(h.hid) }
    ListScreen("Privacy and permissions", subtitle = "What each connection can see and keep") {
        item {
            RemoteBody(data, reload) { d ->
                val list = d.arr("integrations").objects()
                Column {
                    SectionHeader("Connections")
                    if (list.isEmpty()) Text("Nothing is connected. HomeHub's own data stays in your household.", style = t.bodyCompact, color = c.inkSecondary)
                    else GroupedList {
                        list.forEachIndexed { i, x ->
                            if (i > 0) Divider()
                            Column(Modifier.padding(horizontal = Space.md, vertical = Space.sm)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(x.str("name") ?: "", style = t.cardTitle, color = c.ink, modifier = Modifier.weight(1f))
                                    StatusBadge(if (x.str("scope") == "personal") "Only you" else "Household", Tone.Neutral)
                                }
                                x.strList("dataCategories").takeIf { it.isNotEmpty() }?.let { Text("Uses: ${it.joinToString(", ")}", style = t.bodyCompact, color = c.inkSecondary) }
                                x.str("retention")?.let { Text(it, style = t.caption, color = c.inkSecondary) }
                                Text(listOfNotNull(if (x.bool("credentialsStored")) "Credentials in Secret Manager" else "No credentials stored",
                                    x.str("consentedAt")?.let { "allowed ${whenText(it, h.zone)}" }).joinToString(" · "), style = t.caption, color = c.inkTertiary)
                            }
                        }
                    }
                    SectionHeader("Alexa")
                    Text(d.obj("alexa").str("note") ?: "", style = t.bodyCompact, color = c.inkSecondary)
                    SectionHeader("Your data")
                    GroupedList {
                        HomeHubListTile("Export or delete your data", subtitle = "In Settings", leadingIcon = Icons.Outlined.PrivacyTip, onClick = { nav.go(Routes.SETTINGS) })
                        Divider()
                        HomeHubListTile("See every action", subtitle = "Activity and audit", leadingIcon = Icons.Outlined.History, onClick = { nav.go(Routes.ACTIVITY) })
                    }
                }
            }
        }
    }
}

