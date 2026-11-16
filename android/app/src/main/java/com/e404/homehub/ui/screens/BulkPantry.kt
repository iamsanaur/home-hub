package com.e404.homehub.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import com.e404.homehub.AppGraph
import com.e404.homehub.data.model.PantryItem
import com.e404.homehub.ui.LocalActions
import com.e404.homehub.ui.LocalHousehold
import com.e404.homehub.ui.components.ButtonKind
import com.e404.homehub.ui.components.Divider
import com.e404.homehub.ui.components.GroupedList
import com.e404.homehub.ui.components.HomeHubButton
import com.e404.homehub.ui.components.HomeHubTextField
import com.e404.homehub.ui.components.SegmentedFilter
import com.e404.homehub.ui.components.StatusBadge
import com.e404.homehub.ui.components.Tone
import com.e404.homehub.ui.theme.HomeHubTheme
import com.e404.homehub.ui.theme.Space
import com.e404.homehub.ui.util.Dates
import com.e404.homehub.ui.util.PantryParser
import kotlinx.coroutines.launch

/**
 * "Add several items": paste or type a list (one item per line), check the preview, save everything at once.
 * Items already in the pantry (same name and unit) get the quantity added instead of a duplicate entry.
 */
@Composable
fun BulkPantrySheet(existing: List<PantryItem>, onDismiss: () -> Unit) {
    val h = LocalHousehold.current
    val graph = AppGraph.get(LocalContext.current)
    val nav = LocalActions.current
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    var text by rememberSaveable { mutableStateOf("") }
    val locations = remember(existing) { (existing.mapNotNull { it.location?.takeIf { l -> l.isNotBlank() } } + "Pantry shelf").distinct().take(6) }
    var location by rememberSaveable { mutableStateOf(locations.first()) }
    var saving by remember { mutableStateOf(false) }

    val rawLines = remember(text) { PantryParser.parse(text) }
    val lines = remember(text) { PantryParser.mergeDuplicates(rawLines.take(PantryParser.MAX_ITEMS)) }
    val good = lines.filter { it.problem == null }
    val bad = lines.filter { it.problem != null }
    fun match(name: String, unit: String) = existing.firstOrNull { it.name.trim().equals(name, ignoreCase = true) && it.unit == unit }

    FormSheet("Add several items", onDismiss) {
        HomeHubTextField("Your list", text, { text = it }, singleLine = false, minLines = 6,
            placeholder = "2 kg rice\nmilk 2 l\neggs x12\n- salt",
            helper = "One item per line: quantity and unit are optional and can come before or after the name.")
        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            HomeHubButton("Paste", { clipboard.getText()?.text?.let { p -> text = if (text.isBlank()) p else text.trimEnd() + "\n" + p } }, kind = ButtonKind.Secondary, icon = Icons.Outlined.ContentPaste)
            if (text.isNotBlank()) HomeHubButton("Clear", { text = "" }, kind = ButtonKind.Tertiary)
        }
        if (rawLines.size > PantryParser.MAX_ITEMS) Text("Only the first ${PantryParser.MAX_ITEMS} lines are used. Add the rest in a second batch.", style = t.caption, color = c.warning)

        if (good.isNotEmpty()) {
            Text("${good.size} item${if (good.size == 1) "" else "s"} to add", style = t.label, color = c.ink)
            GroupedList {
                good.forEachIndexed { i, l ->
                    if (i > 0) Divider()
                    val m = match(l.name, l.unit)
                    Row(Modifier.fillMaxWidth().padding(horizontal = Space.md, vertical = Space.xs), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(l.name, style = t.cardTitle, color = c.ink)
                            Text("${Dates.qty(l.quantity)} ${l.unit}" + (m?.let { " · now ${Dates.qty(it.quantity + l.quantity)} ${it.unit}" } ?: ""), style = t.caption, color = c.inkSecondary)
                        }
                        StatusBadge(if (m != null) "Adds to existing" else "New", if (m != null) Tone.Info else Tone.Success)
                    }
                }
            }
        }
        if (bad.isNotEmpty()) {
            Text("Couldn't read ${bad.size} line${if (bad.size == 1) "" else "s"} — they'll be skipped", style = t.label, color = c.warning)
            bad.forEach { Row { androidx.compose.material3.Icon(Icons.Outlined.WarningAmber, null, tint = c.warning); Text("  “${it.raw}” — ${it.problem}", style = t.caption, color = c.inkSecondary) } }
        }
        if (good.isNotEmpty()) {
            Text("Storage location for new items", style = t.label, color = c.ink)
            SegmentedFilter(locations, locations.indexOf(location).coerceAtLeast(0), { location = locations[it] })
        }
        val newCount = good.count { match(it.name, it.unit) == null }
        val mergeCount = good.size - newCount
        HomeHubButton(when {
            good.isEmpty() -> "Add items"
            mergeCount == 0 -> "Add $newCount item${if (newCount == 1) "" else "s"}"
            newCount == 0 -> "Update $mergeCount item${if (mergeCount == 1) "" else "s"}"
            else -> "Add $newCount, update $mergeCount"
        }, {
            saving = true
            scope.launch {
                runCatching {
                    val fresh = good.filter { match(it.name, it.unit) == null }.map { l ->
                        mapOf("name" to l.name, "nameKey" to l.name.lowercase(), "quantity" to l.quantity, "unit" to l.unit, "minQuantity" to null, "lowStock" to false, "location" to location.trim(), "expiresAt" to null)
                    }
                    if (fresh.isNotEmpty()) graph.data.createMany(h.hid, "pantryItems", fresh)
                    good.forEach { l ->
                        val m = match(l.name, l.unit) ?: return@forEach
                        graph.data.append("households/${h.hid}/pantryMovements", mapOf("householdId" to h.hid, "createdBy" to h.uid, "itemId" to m.id, "name" to m.name, "kind" to "restock", "delta" to l.quantity, "unit" to m.unit))
                        val next = m.quantity + l.quantity
                        graph.data.update(h.hid, "pantryItems", m.id, mapOf("quantity" to next, "lowStock" to (m.minQuantity != null && next <= m.minQuantity)))
                    }
                }.onSuccess { nav.toast("Pantry updated: ${good.size} item${if (good.size == 1) "" else "s"}"); onDismiss() }
                    .onFailure { nav.toast(it.message ?: "Couldn't save"); saving = false }
            }
        }, Modifier.fillMaxWidth(), enabled = good.isNotEmpty(), loading = saving)
    }
}
