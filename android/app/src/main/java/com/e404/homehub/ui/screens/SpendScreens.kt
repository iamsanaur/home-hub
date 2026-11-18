package com.e404.homehub.ui.screens

import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.ReceiptLong
import androidx.compose.material.icons.outlined.UploadFile
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import com.e404.homehub.AppGraph
import com.e404.homehub.data.repo.bool
import com.e404.homehub.data.repo.num
import com.e404.homehub.data.repo.str
import com.e404.homehub.spend.SpendCapture
import com.e404.homehub.ui.LocalActions
import com.e404.homehub.ui.LocalHousehold
import com.e404.homehub.ui.components.ButtonKind
import com.e404.homehub.ui.components.ConfirmationDialog
import com.e404.homehub.ui.components.Divider
import com.e404.homehub.ui.components.EmptyState
import com.e404.homehub.ui.components.ErrorState
import com.e404.homehub.ui.components.GroupedList
import com.e404.homehub.ui.components.HomeHubButton
import com.e404.homehub.ui.components.HomeHubCard
import com.e404.homehub.ui.components.HomeHubListTile
import com.e404.homehub.ui.components.LoadingSkeleton
import com.e404.homehub.ui.components.SectionHeader
import com.e404.homehub.ui.components.SegmentedFilter
import com.e404.homehub.ui.components.StatusBadge
import com.e404.homehub.ui.components.Tone
import com.e404.homehub.ui.theme.HomeHubTheme
import com.e404.homehub.ui.theme.Space
import com.e404.homehub.ui.util.Dates
import com.e404.homehub.data.model.Money
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.time.Instant

/** Income categories, matching the manual "Add transaction" form (expense categories live in MoneyScreens). */
val INCOME_CATEGORIES = listOf("Salary", "Business", "Interest", "Gift", "Other")

/** "To review" inbox for automatically captured payments. Nothing is booked until confirmed here. */
@Composable
fun SpendReviewScreen() {
    val h = LocalHousehold.current
    val nav = LocalActions.current
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    var items by remember { mutableStateOf<List<JsonObject>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var tick by remember { mutableIntStateOf(0) }
    val chosen = remember { mutableStateMapOf<String, String>() }
    var busy by remember { mutableStateOf<String?>(null) }
    var dismissing by remember { mutableStateOf<JsonObject?>(null) }
    var importing by remember { mutableStateOf(false) }
    LaunchedEffect(h.hid, tick) {
        runCatching { graph.spend.pending(h.hid) }.onSuccess { items = it; error = null }.onFailure { error = it.message }
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { tick++ }

    ListScreen("To review", subtitle = "Payments captured automatically") {
        item {
            GroupedList {
                HomeHubListTile("Import a statement", subtitle = "PhonePe, Google Pay, Paytm or a bank PDF — read on this phone", leadingIcon = Icons.Outlined.UploadFile, onClick = { importing = true })
            }
        }
        item {
            val list = items
            when {
                list == null && error != null -> ErrorState(error!!, onRetry = { tick++ })
                list == null -> LoadingSkeleton(3, Modifier.padding(top = Space.lg))
                list.isEmpty() -> EmptyState(Icons.Outlined.Inbox, "Nothing to review", "Payments captured from your notifications or bank SMS appear here. Nothing is added to Finance until you confirm it.")
                else -> Column(verticalArrangement = Arrangement.spacedBy(Space.sm), modifier = Modifier.padding(top = Space.md)) {
                    list.forEach { x ->
                        val id = x.str("id")!!
                        val credit = x.str("direction") == "credit"
                        val cats = if (credit) INCOME_CATEGORIES else EXPENSE_CATEGORIES
                        val cat = chosen[id] ?: x.str("suggestedCategory")?.takeIf { it in cats } ?: "Other"
                        HomeHubCard {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(x.str("merchant") ?: if (credit) "Money received" else "Payment", style = t.cardTitle, color = c.ink)
                                    Text(listOfNotNull(
                                        x.str("occurredAt")?.let { runCatching { Dates.relative(Instant.parse(it), h.zone) }.getOrNull() },
                                        x.str("method")?.let { m -> mapOf("upi" to "UPI", "card" to "Card", "bank_transfer" to "Bank transfer", "wallet" to "Wallet")[m] },
                                        x.str("accountLast4")?.let { "a/c ••$it" },
                                    ).joinToString(" · "), style = t.caption, color = c.inkSecondary)
                                }
                                Text((if (credit) "+" else "") + Money.format(x.num("amountMinor")?.toLong() ?: 0, x.str("currency") ?: h.currency), style = t.numeric.copy(fontSize = t.cardTitle.fontSize), color = if (credit) c.success else c.ink)
                            }
                            if (x["possibleDuplicateOf"] != null && x.str("possibleDuplicateOf") != null) {
                                StatusBadge("Possibly already recorded", Tone.Warning, Icons.Outlined.ContentCopy)
                            }
                            SegmentedFilter(cats, cats.indexOf(cat).coerceAtLeast(0), { chosen[id] = cats[it] })
                            Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                                HomeHubButton(if (credit) "Add income" else "Add expense", {
                                    busy = id
                                    scope.launch {
                                        runCatching { graph.spend.confirm(h.hid, id, cat) }
                                            .onSuccess { nav.toast("Added to Finance"); items = items?.filterNot { it.str("id") == id } }
                                            .onFailure { nav.toast(it.message ?: "Couldn't add it") }
                                        busy = null
                                    }
                                }, Modifier.weight(1f), loading = busy == id)
                                HomeHubButton("Dismiss", { dismissing = x }, kind = ButtonKind.Secondary)
                            }
                        }
                    }
                    Text("Your choice of category is remembered for the next payment to the same merchant.", style = t.caption, color = c.inkTertiary)
                }
            }
        }
    }
    if (importing) StatementImportSheet(onDismiss = { importing = false }, onImported = { tick++ })
    dismissing?.let { x ->
        ConfirmationDialog("Dismiss this payment?", "It won't be added to Finance. You can still add it by hand.", "Dismiss",
            onConfirm = {
                val id = x.str("id")!!; dismissing = null
                scope.launch { runCatching { graph.spend.dismiss(h.hid, id) }.onSuccess { items = items?.filterNot { it.str("id") == id } }.onFailure { nav.toast(it.message ?: "Couldn't dismiss") } }
            }, onDismiss = { dismissing = null })
    }
}

/** Settings → Automatic spending. Opt-in with a clear disclosure before asking for notification access. */
@Composable
fun SpendCaptureSettings() {
    val h = LocalHousehold.current
    val context = LocalContext.current
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    var enabled by remember { mutableStateOf(SpendCapture.isEnabled(context)) }
    var access by remember { mutableStateOf(SpendCapture.hasAccess(context)) }
    var disclosing by remember { mutableStateOf(false) }
    var refresh by remember { mutableStateOf(0) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { access = SpendCapture.hasAccess(context); enabled = SpendCapture.isEnabled(context); refresh++ }
    if (!h.canFinance) return
    Column {
        SectionHeader("Automatic spending")
        GroupedList {
            Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = Space.md, vertical = Space.sm), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Capture from payment notifications", style = t.cardTitle, color = c.ink)
                    Text(when {
                        enabled && access -> "On · payments go to Finance → To review"
                        enabled -> "Waiting for notification access"
                        else -> "UPI apps, bank apps and bank SMS"
                    }, style = t.bodyCompact, color = if (enabled && !access) c.warning else c.inkSecondary)
                }
                Switch(enabled, { on -> if (on) disclosing = true else { SpendCapture.disable(context); enabled = false } },
                    colors = SwitchDefaults.colors(checkedTrackColor = c.brand))
            }
            if (enabled && access) {
                Divider()
                Column(Modifier.fillMaxWidth().padding(horizontal = Space.md, vertical = Space.sm)) {
                    val seen = remember(refresh) { SpendCapture.trail(context, "seen") }
                    val upload = remember(refresh) { SpendCapture.trail(context, "upload") }
                    Text("Last notification seen", style = t.caption, color = c.inkTertiary)
                    Text(seen ?: "None yet — nothing from a payment or SMS app has arrived since capture was switched on", style = t.bodyCompact, color = c.inkSecondary)
                    Text("Last upload", style = t.caption, color = c.inkTertiary, modifier = Modifier.padding(top = Space.xs))
                    Text(upload ?: "None yet", style = t.bodyCompact, color = c.inkSecondary)
                }
            }
            if (enabled && !access) {
                Divider()
                HomeHubListTile("Allow notification access", subtitle = "Opens Android settings — turn on HomeHub spending capture", leadingIcon = Icons.Outlined.ReceiptLong,
                    onClick = { context.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) })
            }
        }
        Text("Only notifications from payment and banking apps that look like a completed payment leave this phone. HomeHub keeps the amount, merchant and date — never the message itself.",
            style = t.caption, color = c.inkTertiary, modifier = Modifier.padding(top = Space.xs))
    }
    if (disclosing) ConfirmationDialog(
        "Capture spending automatically?",
        "HomeHub will read notifications from UPI, banking and SMS apps on this phone to find completed payments. Matching payments are sent to HomeHub's server for ${h.household.name} and wait in To review until you confirm them. Other notifications are ignored on the phone. You can turn this off at any time.",
        "Continue",
        onConfirm = {
            disclosing = false
            SpendCapture.enable(context, h.hid); enabled = true
            if (!SpendCapture.hasAccess(context)) context.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        },
        onDismiss = { disclosing = false },
    )
}
