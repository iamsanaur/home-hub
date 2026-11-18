package com.e404.homehub.ui.screens

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.e404.homehub.AppGraph
import com.e404.homehub.data.model.Money
import com.e404.homehub.spend.StatementImportApi
import com.e404.homehub.spend.StatementParse
import com.e404.homehub.spend.StatementParser
import com.e404.homehub.spend.StatementPasswordRequired
import com.e404.homehub.spend.StatementReader
import com.e404.homehub.spend.StatementUnreadable
import com.e404.homehub.ui.LocalHousehold
import com.e404.homehub.ui.components.ButtonKind
import com.e404.homehub.ui.components.HomeHubButton
import com.e404.homehub.ui.components.HomeHubTextField
import com.e404.homehub.ui.components.StatusBadge
import com.e404.homehub.ui.components.Tone
import com.e404.homehub.ui.theme.HomeHubTheme
import com.e404.homehub.ui.theme.Space
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.util.Locale

private sealed interface Stage {
    data object Pick : Stage
    data class Working(val message: String) : Stage
    data class Password(val uri: Uri, val wrong: Boolean) : Stage
    data class Review(val parse: StatementParse, val verdicts: List<StatementImportApi.Verdict>, val selected: Set<Int>) : Stage
    data class Done(val imported: Int) : Stage
    data class Failed(val message: String) : Stage
}

/**
 * Import a PhonePe / Google Pay / Paytm / bank statement PDF. The PDF is read on this phone; only the payments the
 * person ticks are sent, and they land in "To review" — nothing is booked until confirmed there.
 */
@Composable
fun StatementImportSheet(onDismiss: () -> Unit, onImported: () -> Unit) {
    val h = LocalHousehold.current
    val context = LocalContext.current
    val graph = AppGraph.get(context)
    val api = remember { StatementImportApi(graph.gateway) }
    val scope = rememberCoroutineScope()
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    var stage by remember { mutableStateOf<Stage>(Stage.Pick) }
    var password by remember { mutableStateOf("") }
    var source by remember { mutableStateOf<Uri?>(null) }

    fun open(uri: Uri, pw: String?) {
        source = uri
        stage = Stage.Working("Reading the statement on this phone…")
        scope.launch {
            try {
                val lines = StatementReader.lines(context, uri, pw)
                val parse = StatementParser.parse(lines, h.zone)
                android.util.Log.i("HomeHubStatement", "read ${lines.size} lines → ${parse.app.wire}, ${parse.rows.size} payments, ${parse.skipped} skipped") // counts only, never content
                if (parse.rows.isEmpty()) {
                    stage = Stage.Failed(
                        if (parse.skipped > 0) "Found ${parse.skipped} payments, but couldn't tell whether money went out or came in, so nothing was imported. Download the statement from the PhonePe, Google Pay or Paytm app instead."
                        else "Couldn't find any payments in this PDF. Use the transaction statement from PhonePe, Google Pay or Paytm, or your bank's account statement.")
                    return@launch
                }
                stage = Stage.Working("Checking ${parse.rows.size} payments against what HomeHub already has…")
                val out = api.run(h.hid, parse.app, parse.rows, dryRun = true)
                stage = Stage.Review(parse, out.verdicts, parse.rows.indices.filter { out.verdicts.getOrNull(it)?.status == "new" }.toSet())
            } catch (e: StatementPasswordRequired) {
                password = ""; stage = Stage.Password(uri, e.wrong)
            } catch (e: StatementUnreadable) {
                stage = Stage.Failed(e.message ?: "Couldn't read that file.")
            } catch (e: Exception) {
                stage = Stage.Failed(e.message ?: "Something went wrong. Check your connection and try again.")
            }
        }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> if (uri != null) open(uri, null) }

    FormSheet("Import a statement", onDismiss) {
        when (val s = stage) {
            Stage.Pick -> {
                Text("Pick a statement PDF from PhonePe, Google Pay, Paytm or your bank. It's read on this phone — the file itself is never uploaded. You'll see every payment first, and anything already in HomeHub is left out.", style = t.body, color = c.inkSecondary)
                HomeHubButton("Choose a PDF", { picker.launch(arrayOf("application/pdf")) }, Modifier.fillMaxWidth())
            }
            is Stage.Working -> {
                Text(s.message, style = t.body, color = c.inkSecondary)
                HomeHubButton("Working…", {}, Modifier.fillMaxWidth(), loading = true, enabled = false)
            }
            is Stage.Password -> {
                Text(if (s.wrong) "That password didn't open the statement. Try again." else "This statement is password-protected. Statements from banks and UPI apps are usually locked with a password they showed you when you downloaded it — often your date of birth or phone number.",
                    style = t.body, color = if (s.wrong) c.danger else c.inkSecondary)
                HomeHubTextField("PDF password", password, { password = it }, password = true, imeAction = androidx.compose.ui.text.input.ImeAction.Done)
                HomeHubButton("Open statement", { open(s.uri, password) }, Modifier.fillMaxWidth(), enabled = password.isNotEmpty())
            }
            is Stage.Failed -> {
                Text(s.message, style = t.body, color = c.danger)
                HomeHubButton("Choose another PDF", { stage = Stage.Pick }, Modifier.fillMaxWidth(), kind = ButtonKind.Secondary)
            }
            is Stage.Done -> {
                Text(if (s.imported == 0) "Nothing new to add." else "Added ${s.imported} ${if (s.imported == 1) "payment" else "payments"} to To review. Confirm each one to put it in Finance.", style = t.body, color = c.ink)
                HomeHubButton("Done", { onImported(); onDismiss() }, Modifier.fillMaxWidth())
            }
            is Stage.Review -> {
                val v = s.verdicts
                fun count(st: String) = v.count { it.status == st }
                val actionable = s.parse.rows.indices.filter { v.getOrNull(it)?.status.let { st -> st == "new" || st == "possible_duplicate" } }
                val already = count("already_captured") + count("duplicate_in_file")
                var adding by remember { mutableStateOf(false) }
                Text("Found ${s.parse.rows.size} payments in your ${s.parse.app.label}.", style = t.cardTitle, color = c.ink)
                Text(listOfNotNull(
                    "${count("new")} new",
                    if (already > 0) "$already already in HomeHub or listed twice — left out" else null,
                    if (count("possible_duplicate") > 0) "${count("possible_duplicate")} may match something you entered by hand — not ticked" else null,
                    if (count("invalid") > 0) "${count("invalid")} with an unusual date — left out" else null,
                    if (s.parse.skipped > 0) "${s.parse.skipped} skipped: couldn't tell money in from money out" else null,
                ).joinToString("\n"), style = t.bodyCompact, color = c.inkSecondary)
                if (actionable.isEmpty()) {
                    Text("There's nothing new to import from this statement.", style = t.body, color = c.ink)
                    HomeHubButton("Close", onDismiss, Modifier.fillMaxWidth(), kind = ButtonKind.Secondary)
                } else {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Text("${s.selected.size} of ${actionable.size} selected", style = t.caption, color = c.inkTertiary)
                        val all = s.selected.size == actionable.size
                        Text(if (all) "Clear all" else "Select all", style = t.label, color = c.brand, modifier = Modifier.clickable {
                            stage = s.copy(selected = if (all) emptySet() else actionable.toSet())
                        }.padding(Space.xs))
                    }
                    LazyColumn(Modifier.fillMaxWidth().heightIn(max = 340.dp)) {
                        itemsIndexed(actionable) { _, i ->
                            val r = s.parse.rows[i]; val dup = v[i].status == "possible_duplicate"
                            Row(Modifier.fillMaxWidth().clickable { stage = s.copy(selected = if (i in s.selected) s.selected - i else s.selected + i) }.padding(vertical = Space.xs), verticalAlignment = Alignment.CenterVertically) {
                                Checkbox(i in s.selected, { stage = s.copy(selected = if (it) s.selected + i else s.selected - i) }, colors = CheckboxDefaults.colors(checkedColor = c.brand))
                                Column(Modifier.weight(1f)) {
                                    Text(r.merchant ?: if (r.direction == "credit") "Money received" else "Payment", style = t.cardTitle, color = c.ink)
                                    Text(DATE.format(Instant.parse(r.occurredAt.let { java.time.OffsetDateTime.parse(it).toInstant().toString() }).atZone(h.zone)), style = t.caption, color = c.inkSecondary)
                                    if (dup) StatusBadge("Possibly already recorded", Tone.Warning, Icons.Outlined.ContentCopy)
                                }
                                Text((if (r.direction == "credit") "+" else "") + Money.format(r.amountMinor, "INR"), style = t.numeric.copy(fontSize = t.cardTitle.fontSize), color = if (r.direction == "credit") c.success else c.ink)
                            }
                        }
                    }
                    HomeHubButton("Add ${s.selected.size} to To review", {
                        adding = true
                        scope.launch {
                            try {
                                val rows = s.selected.sorted().map { s.parse.rows[it] }
                                stage = Stage.Done(api.run(h.hid, s.parse.app, rows, dryRun = false).imported)
                            } catch (e: Exception) {
                                adding = false; stage = Stage.Failed(e.message ?: "Couldn't import. Nothing was added twice — you can try again.")
                            }
                        }
                    }, Modifier.fillMaxWidth(), enabled = s.selected.isNotEmpty(), loading = adding)
                    Text("Nothing is added to Finance yet. Each payment waits in To review until you confirm it.", style = t.caption, color = c.inkTertiary)
                }
            }
        }
    }
}

private val DATE: DateTimeFormatter = DateTimeFormatter.ofPattern("d MMM yyyy", Locale.getDefault())
