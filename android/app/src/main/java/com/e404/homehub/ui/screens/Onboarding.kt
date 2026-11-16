package com.e404.homehub.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.e404.homehub.AppGraph
import com.e404.homehub.data.model.Money
import com.e404.homehub.data.model.Role as HhRole
import com.e404.homehub.data.repo.UserProfile
import com.e404.homehub.ui.components.ButtonKind
import com.e404.homehub.ui.components.HomeHubButton
import com.e404.homehub.ui.components.HomeHubTextField
import com.e404.homehub.ui.theme.HomeHubTheme
import com.e404.homehub.ui.theme.Radius
import com.e404.homehub.ui.theme.Space
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale

private val STEPS = listOf("household", "location", "invite", "budget", "preferences", "autonomy")
val CURRENCIES = listOf("INR", "USD", "EUR", "GBP", "AED", "SGD", "AUD", "CAD", "JPY", "CHF", "SAR", "ZAR", "NZD", "KWD")

/**
 * Onboarding (claude.md §17). Each step is persisted to users/{uid}.onboarding.step so the
 * flow resumes where the person left off; optional steps can be skipped.
 */
@Composable
fun OnboardingFlow(uid: String, profile: UserProfile?) {
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val hid = profile?.activeHouseholdId
    val initial = profile?.onboardingStep?.takeIf { it in STEPS }?.let { if (hid == null && STEPS.indexOf(it) > 1) "household" else it } ?: "household"
    var step by rememberSaveable { mutableStateOf(initial) }
    var draftName by rememberSaveable { mutableStateOf("") }
    fun goTo(s: String) { step = s; scope.launch { runCatching { graph.session.setOnboarding(uid, s, false) } } }
    fun finish() { scope.launch { graph.session.setOnboarding(uid, "done", true) } }
    BackHandler(STEPS.indexOf(step) in 1..1) { step = "household" }

    val c = HomeHubTheme.colors
    Box(Modifier.fillMaxSize().background(c.canvas).windowInsetsPadding(WindowInsets.safeDrawing)) {
        CenteredColumn(Modifier.verticalScroll(rememberScrollState())) {
            Gap(24)
            val idx = STEPS.indexOf(step)
            Text("Step ${idx + 1} of ${STEPS.size}", style = HomeHubTheme.type.caption, color = c.inkSecondary)
            Gap(6)
            LinearProgressIndicator(progress = { (idx + 1f) / STEPS.size }, Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)), color = c.brand, trackColor = c.surfaceSubtle, drawStopIndicator = {})
            Gap(24)
            when (step) {
                "household" -> HouseholdStep(draftName, { draftName = it }, onCreate = { goTo("location") }, onJoined = { finish() })
                "location" -> LocationStep(draftName, onCreated = { goTo("invite") })
                "invite" -> if (hid != null) InviteStep(hid, onNext = { goTo("budget") }) else Text("Setting up…")
                "budget" -> if (hid != null) BudgetStep(hid, profile, onNext = { goTo("preferences") }) else Text("Setting up…")
                "preferences" -> if (hid != null) PreferencesStep(hid, onNext = { goTo("autonomy") }) else Text("Setting up…")
                "autonomy" -> if (hid != null) AutonomyStep(hid, onDone = { finish() }) else Text("Setting up…")
            }
            Gap(32)
        }
    }
}

@Composable
private fun StepTitle(title: String, why: String) {
    Text(title, style = HomeHubTheme.type.screenTitle, color = HomeHubTheme.colors.ink)
    Gap(4)
    Text(why, style = HomeHubTheme.type.bodyCompact, color = HomeHubTheme.colors.inkSecondary)
    Gap(20)
}

@Composable
private fun HouseholdStep(name: String, onName: (String) -> Unit, onCreate: () -> Unit, onJoined: () -> Unit) {
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    var code by rememberSaveable { mutableStateOf("") }
    var joining by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var tried by remember { mutableStateOf(false) }
    StepTitle("Set up your household", "Create a new household, or join one you were invited to.")
    HomeHubTextField("Household name", name, onName, placeholder = "e.g. Sharma Home", error = if (tried && name.isBlank()) "Give your household a name." else null)
    Gap(16)
    HomeHubButton("Continue", { tried = true; if (name.isNotBlank()) onCreate() }, Modifier.fillMaxWidth())
    Gap(32)
    Text("Have an invitation code?", style = HomeHubTheme.type.cardTitle, color = HomeHubTheme.colors.ink)
    Gap(8)
    HomeHubTextField("Invitation code", code, { code = it.trim() }, helper = "Paste the code a household member shared with you.", error = error)
    Gap(12)
    HomeHubButton("Join household", {
        if (code.length < 20) { error = "That code looks too short. Paste the full code."; return@HomeHubButton }
        joining = true; error = null
        scope.launch { runCatching { graph.session.acceptInvitation(code) }.onSuccess { onJoined() }.onFailure { error = it.message }; joining = false }
    }, Modifier.fillMaxWidth(), kind = ButtonKind.Secondary, loading = joining)
}

@Composable
private fun LocationStep(name: String, onCreated: () -> Unit) {
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val locale = Locale.getDefault()
    var currency by rememberSaveable { mutableStateOf(runCatching { java.util.Currency.getInstance(locale).currencyCode }.getOrNull()?.takeIf { it in CURRENCIES } ?: "INR") }
    var timezone by rememberSaveable { mutableStateOf(ZoneId.systemDefault().id) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    StepTitle("Location, currency and time", "Amounts are recorded in this currency, and reminders follow this time zone.")
    Text("Currency", style = HomeHubTheme.type.label, color = HomeHubTheme.colors.ink)
    Gap(6)
    ChoiceGrid(CURRENCIES, currency) { currency = it }
    Gap(16)
    HomeHubTextField("Time zone", timezone, { timezone = it }, helper = "Detected from this device. Use an IANA name such as Asia/Kolkata.",
        error = if (runCatching { ZoneId.of(timezone) }.isFailure) "Unknown time zone" else null)
    Gap(16)
    if (error != null) { Text(error!!, color = HomeHubTheme.colors.danger, style = HomeHubTheme.type.bodyCompact); Gap(8) }
    HomeHubButton("Create household", {
        if (runCatching { ZoneId.of(timezone) }.isFailure) return@HomeHubButton
        busy = true; error = null
        scope.launch {
            runCatching { graph.session.createHousehold(name, currency, timezone, locale.toLanguageTag(), locale.country.ifEmpty { null }) }
                .onSuccess { onCreated() }.onFailure { error = it.message }
            busy = false
        }
    }, Modifier.fillMaxWidth(), loading = busy)
}

@Composable
fun ChoiceGrid(options: List<String>, selected: String, onSelect: (String) -> Unit) {
    val c = HomeHubTheme.colors
    Column {
        options.chunked(4).forEach { row ->
            Row(Modifier.fillMaxWidth()) {
                row.forEach { o ->
                    val sel = o == selected
                    Box(
                        Modifier.weight(1f).padding(3.dp).height(48.dp).clip(RoundedCornerShape(Radius.control))
                            .background(if (sel) c.brandTint else c.surface).border(1.dp, if (sel) c.brand else c.border, RoundedCornerShape(Radius.control))
                            .selectable(sel, role = Role.RadioButton) { onSelect(o) },
                        contentAlignment = Alignment.Center,
                    ) { Text(o, style = HomeHubTheme.type.label, color = c.ink) }
                }
                repeat(4 - row.size) { Box(Modifier.weight(1f)) }
            }
        }
    }
}

val ROLE_HELP = mapOf(
    HhRole.Admin to "Manages members, settings and the assistant. Sees everything.",
    HhRole.Adult to "Full household access, including finance unless you restrict it.",
    HhRole.Child to "Sees and completes their own tasks, shared events and notes. No finance.",
    HhRole.Staff to "Sees only assigned work — tasks, cleaning, shopping and pantry. No finance or documents.",
)

@Composable
fun RolePicker(selected: HhRole, onSelect: (HhRole) -> Unit) {
    val c = HomeHubTheme.colors
    Column {
        ROLE_HELP.forEach { (role, help) ->
            Row(
                Modifier.fillMaxWidth().selectable(role == selected, role = Role.RadioButton) { onSelect(role) }.padding(vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(role == selected, null, colors = RadioButtonDefaults.colors(selectedColor = c.brand))
                Column(Modifier.padding(start = 8.dp)) {
                    Text(role.label, style = HomeHubTheme.type.cardTitle, color = c.ink)
                    Text(help, style = HomeHubTheme.type.caption, color = c.inkSecondary)
                }
            }
        }
    }
}

/** Invite form used in onboarding and in Family. Shows a one-time code to share. */
@Composable
fun InviteForm(hid: String, onInvited: (() -> Unit)? = null) {
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    var name by rememberSaveable { mutableStateOf("") }
    var email by rememberSaveable { mutableStateOf("") }
    var role by remember { mutableStateOf(HhRole.Adult) }
    var busy by remember { mutableStateOf(false) }
    var code by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    HomeHubTextField("Name", name, { name = it }, optional = true)
    Gap()
    HomeHubTextField("Email", email, { email = it }, optional = true, keyboardType = KeyboardType.Email,
        helper = "If you add an email, only that person can use the invitation.")
    Gap()
    Text("Role", style = HomeHubTheme.type.label, color = HomeHubTheme.colors.ink)
    RolePicker(role) { role = it }
    Gap()
    if (code != null) {
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.input)).background(HomeHubTheme.colors.brandTint).padding(Space.md)) {
            Text("Share this code. It works once and expires in 7 days.", style = HomeHubTheme.type.caption, color = HomeHubTheme.colors.inkSecondary)
            Gap(6)
            Text(code!!, style = HomeHubTheme.type.numeric, color = HomeHubTheme.colors.ink, modifier = Modifier.semantics { contentDescription = "Invitation code" })
            TextButton({ clipboard.setText(AnnotatedString(code!!)) }) { Text("Copy code", color = HomeHubTheme.colors.brand) }
        }
        Gap()
    }
    if (error != null) { Text(error!!, color = HomeHubTheme.colors.danger, style = HomeHubTheme.type.bodyCompact); Gap(8) }
    HomeHubButton(if (code == null) "Create invitation" else "Invite someone else", {
        busy = true; error = null
        scope.launch {
            runCatching { graph.session.invite(hid, role, email.ifBlank { null }, name.ifBlank { null }) }
                .onSuccess { code = it; name = ""; email = ""; onInvited?.invoke() }.onFailure { error = it.message }
            busy = false
        }
    }, Modifier.fillMaxWidth(), kind = if (code == null) ButtonKind.Primary else ButtonKind.Secondary, loading = busy)
}

@Composable
private fun InviteStep(hid: String, onNext: () -> Unit) {
    StepTitle("Invite your household", "Add family members or staff. Each role only sees what it needs. You can do this later in Family.")
    InviteForm(hid)
    Gap(16)
    HomeHubButton("Continue", onNext, Modifier.fillMaxWidth(), kind = ButtonKind.Tertiary)
}

@Composable
private fun BudgetStep(hid: String, profile: UserProfile?, onNext: () -> Unit) {
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val currency = remember { mutableStateOf("INR") }
    androidx.compose.runtime.LaunchedEffect(hid) { graph.firestore.document("households/$hid").get().addOnSuccessListener { currency.value = it.getString("currency") ?: "INR" } }
    var budget by rememberSaveable { mutableStateOf("") }
    var billName by rememberSaveable { mutableStateOf("") }
    var billAmount by rememberSaveable { mutableStateOf("") }
    var billDay by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    StepTitle("Budget and recurring bills", "Optional. A monthly budget lets HomeHub flag overspending; bills get reminders before they're due.")
    HomeHubTextField("Monthly household budget (${currency.value})", budget, { budget = it }, optional = true, keyboardType = KeyboardType.Decimal)
    Gap()
    HomeHubTextField("A recurring bill", billName, { billName = it }, optional = true, placeholder = "e.g. Electricity")
    Gap()
    Row {
        HomeHubTextField("Amount", billAmount, { billAmount = it }, Modifier.weight(1f), optional = true, keyboardType = KeyboardType.Decimal)
        Box(Modifier.padding(4.dp))
        HomeHubTextField("Due day (1–28)", billDay, { billDay = it }, Modifier.weight(1f), optional = true, keyboardType = KeyboardType.Number)
    }
    Gap()
    if (error != null) { Text(error!!, color = HomeHubTheme.colors.danger, style = HomeHubTheme.type.bodyCompact); Gap(8) }
    HomeHubButton("Save and continue", {
        error = null
        val limit = budget.takeIf { it.isNotBlank() }?.let { Money.parse(it, currency.value) ?: run { error = "Budget isn't a valid amount."; return@HomeHubButton } }
        val amt = billAmount.takeIf { it.isNotBlank() }?.let { Money.parse(it, currency.value) ?: run { error = "Bill amount isn't valid."; return@HomeHubButton } }
        val day = billDay.toIntOrNull()
        if (billName.isNotBlank() && (amt == null || day == null || day !in 1..28)) { error = "Add the bill's amount and a due day between 1 and 28."; return@HomeHubButton }
        busy = true
        scope.launch {
            runCatching {
                val period = LocalDate.now().toString().substring(0, 7)
                if (limit != null) graph.data.create(hid, "budgets", mapOf("period" to period, "category" to "*", "limitMinor" to limit, "currency" to currency.value), "$period-all")
                if (billName.isNotBlank() && amt != null && day != null) {
                    val zone = ZoneId.systemDefault()
                    var due = LocalDate.now().withDayOfMonth(day)
                    if (due.isBefore(LocalDate.now())) due = due.plusMonths(1)
                    val ts = com.google.firebase.Timestamp(java.util.Date.from(due.atTime(10, 0).atZone(zone).toInstant()))
                    graph.data.create(hid, "bills", mapOf("name" to billName.trim(), "category" to "Utilities", "amountMinor" to amt, "currency" to currency.value,
                        "nextDueAt" to ts, "seriesStartAt" to ts, "recurrence" to mapOf("freq" to "monthly"), "reminderDaysBefore" to 3, "active" to true, "status" to "upcoming", "provider" to null))
                }
            }.onSuccess { onNext() }.onFailure { error = it.message ?: "Couldn't save. Try again." }
            busy = false
        }
    }, Modifier.fillMaxWidth(), loading = busy)
    HomeHubButton("Skip for now", onNext, Modifier.fillMaxWidth(), kind = ButtonKind.Tertiary)
}

@Composable
private fun PreferencesStep(hid: String, onNext: () -> Unit) {
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    var diet by rememberSaveable { mutableStateOf("") }
    var allergies by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    StepTitle("Household preferences", "Optional. The assistant uses only what you write here — it never guesses diets or allergies.")
    HomeHubTextField("Food preferences", diet, { diet = it }, optional = true, singleLine = false, minLines = 2, placeholder = "e.g. Vegetarian on Tuesdays, less spicy for kids")
    Gap()
    HomeHubTextField("Allergies", allergies, { allergies = it }, optional = true, singleLine = false, minLines = 2, helper = "Recorded exactly as entered. Shared with adults in your household.")
    Gap(16)
    HomeHubButton("Save and continue", {
        busy = true
        scope.launch {
            runCatching {
                if (diet.isNotBlank() || allergies.isNotBlank())
                    graph.firestore.document("households/$hid/preferences/dietary").set(mapOf("notes" to diet.trim(), "allergies" to allergies.split(',').map { it.trim() }.filter { it.isNotEmpty() }, "source" to "user")).await()
            }
            busy = false; onNext()
        }
    }, Modifier.fillMaxWidth(), loading = busy)
    HomeHubButton("Skip for now", onNext, Modifier.fillMaxWidth(), kind = ButtonKind.Tertiary)
}

val AUTONOMY = listOf(
    "assistant" to ("Assistant" to "Only suggests. Every change waits for your approval."),
    "copilot" to ("Copilot" to "Prepares changes; you approve each one."),
    "routine" to ("Routine (recommended)" to "Handles safe, reversible chores — tasks, lists, reminders — on its own."),
    "advanced" to ("Advanced" to "Also makes bounded changes like meal plans. Purchases, payments and bookings still need approval."),
)

@Composable
fun AutonomyPicker(selected: String, onSelect: (String) -> Unit) {
    val c = HomeHubTheme.colors
    AUTONOMY.forEach { (id, pair) ->
        Row(Modifier.fillMaxWidth().selectable(id == selected, role = Role.RadioButton) { onSelect(id) }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            RadioButton(id == selected, null, colors = RadioButtonDefaults.colors(selectedColor = c.brand))
            Column(Modifier.padding(start = 8.dp)) {
                Text(pair.first, style = HomeHubTheme.type.cardTitle, color = c.ink)
                Text(pair.second, style = HomeHubTheme.type.caption, color = c.inkSecondary)
            }
        }
    }
}

@Composable
private fun AutonomyStep(hid: String, onDone: () -> Unit) {
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    var mode by rememberSaveable { mutableStateOf("routine") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    StepTitle("How much should the assistant do?", "You can change this or pause the assistant at any time in Settings.")
    AutonomyPicker(mode) { mode = it }
    Gap(16)
    if (error != null) { Text(error!!, color = HomeHubTheme.colors.danger, style = HomeHubTheme.type.bodyCompact); Gap(8) }
    HomeHubButton("Finish setup", {
        busy = true; error = null
        scope.launch { runCatching { graph.agent.setAutonomy(hid, mode = mode) }.onSuccess { onDone() }.onFailure { error = it.message }; busy = false }
    }, Modifier.fillMaxWidth(), loading = busy)
}
