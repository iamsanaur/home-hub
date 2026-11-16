package com.e404.homehub.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.e404.homehub.AppGraph
import com.e404.homehub.data.model.Bill
import com.e404.homehub.data.model.Money
import com.e404.homehub.ui.LocalActions
import com.e404.homehub.ui.LocalHousehold
import com.e404.homehub.ui.components.ButtonKind
import com.e404.homehub.ui.components.HomeHubButton
import com.e404.homehub.ui.components.HomeHubIconButton
import com.e404.homehub.ui.components.HomeHubTextField
import com.e404.homehub.ui.components.SegmentedFilter
import com.e404.homehub.ui.theme.HomeHubTheme
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.time.LocalDate
import java.time.YearMonth

private val WEEKDAYS = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
private val UNITS = listOf("l" to "Liters", "copies" to "Copies", "days" to "Days", "cans" to "Cans", "meals" to "Meals")

private fun trimQty(q: Double) = if (q % 1.0 == 0.0) q.toLong().toString() else q.toString()

/** Add form for a bill charged per delivery (milk, newspaper, maid, water cans, tiffin). */
@Composable
fun AddVendorBillForm(onDone: () -> Unit) {
    val h = LocalHousehold.current
    val graph = AppGraph.get(LocalContext.current)
    val nav = LocalActions.current
    val scope = rememberCoroutineScope()
    var name by rememberSaveable { mutableStateOf("") }
    var vendor by rememberSaveable { mutableStateOf("") }
    var unit by rememberSaveable { mutableStateOf("l") }
    var rate by rememberSaveable { mutableStateOf("") }
    var qty by rememberSaveable { mutableStateOf("1") }
    var days by rememberSaveable { mutableStateOf(setOf(1, 2, 3, 4, 5, 6, 7)) }
    var dueDay by rememberSaveable { mutableStateOf("5") }
    var tried by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val rateMinor = Money.parse(rate, h.currency)?.takeIf { it > 0 }
    val q = qty.toDoubleOrNull()?.takeIf { it >= 0 }
    val due = dueDay.toIntOrNull()?.takeIf { it in 1..28 }
    HomeHubTextField("Bill name", name, { name = it }, placeholder = "e.g. Milk", error = if (tried && name.isBlank()) "Name the bill." else null)
    HomeHubTextField("Vendor (optional)", vendor, { vendor = it }, placeholder = "e.g. Ramesh")
    Text("Charged per", style = HomeHubTheme.type.label, color = HomeHubTheme.colors.ink)
    SegmentedFilter(UNITS.map { it.second }, UNITS.indexOfFirst { it.first == unit }.coerceAtLeast(0), { unit = UNITS[it].first })
    HomeHubTextField("Price per $unit (${h.currency})", rate, { rate = it }, keyboardType = KeyboardType.Decimal, error = if (tried && rateMinor == null) "Enter the price for one $unit." else null)
    HomeHubTextField("Usual quantity per delivery", qty, { qty = it }, keyboardType = KeyboardType.Decimal, error = if (tried && q == null) "Enter a number." else null)
    Text("Delivery days", style = HomeHubTheme.type.label, color = HomeHubTheme.colors.ink)
    DayChips(days) { days = it }
    HomeHubTextField("Pay on day of the next month (1–28)", dueDay, { dueDay = it }, keyboardType = KeyboardType.Number, error = if (tried && due == null) "Use 1 to 28." else null)
    HomeHubButton("Add bill", {
        tried = true
        if (name.isBlank() || rateMinor == null || q == null || due == null || days.isEmpty()) return@HomeHubButton
        busy = true
        scope.launch {
            runCatching {
                graph.agent.createVendorBill(h.hid, buildJsonObject {
                    put("name", name.trim()); if (vendor.isNotBlank()) put("vendor", vendor.trim())
                    put("unit", unit); put("rateMinor", rateMinor); put("defaultQuantity", q); put("dueDay", due)
                    putJsonArray("weekdays") { days.sorted().forEach { add(JsonPrimitive(it)) } }
                })
            }.onSuccess { nav.toast("Bill added"); onDone() }.onFailure { nav.toast(it.message ?: "Couldn't add bill"); busy = false }
        }
    }, Modifier.fillMaxWidth(), loading = busy)
}

@Composable
private fun DayChips(selected: Set<Int>, onChange: (Set<Int>) -> Unit) {
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        WEEKDAYS.forEachIndexed { i, label ->
            val iso = i + 1
            val on = iso in selected
            Box(
                Modifier.weight(1f).clickable { onChange(if (on && selected.size > 1) selected - iso else selected + iso) }
                    .background(if (on) c.brand else c.surfaceSubtle, RoundedCornerShape(10.dp)).padding(vertical = 10.dp)
                    .semantics { contentDescription = "$label ${if (on) "delivered" else "not delivered"}" },
                contentAlignment = Alignment.Center,
            ) { Text(label, style = t.caption, color = if (on) c.onBrand else c.ink) }
        }
    }
}

/**
 * The month for a pay-per-delivery bill: a day grid you can tap to mark "didn't come" or change the quantity, with the
 * total underneath. [onTotal] reports the month's total (minor units) so "I've paid" can prefill it.
 */
@Composable
fun VendorLedgerSection(bill: Bill, onTotal: (Long) -> Unit) {
    val h = LocalHousehold.current
    val graph = AppGraph.get(LocalContext.current)
    val nav = LocalActions.current
    val scope = rememberCoroutineScope()
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    var month by rememberSaveable(bill.id) { mutableStateOf<String?>(null) }
    var ledger by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableStateOf(0) }
    var picked by remember { mutableStateOf<String?>(null) }
    var custom by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(bill.id, month, reload) {
        error = null
        runCatching { graph.agent.billLedger(h.hid, bill.id, month) }
            .onSuccess { ledger = it; if (month == null) month = it["month"]?.jsonPrimitive?.contentOrNull; it["totals"]?.jsonObject?.get("totalMinor")?.jsonPrimitive?.longOrNull?.let(onTotal) }
            .onFailure { error = it.message ?: "Couldn't load the month" }
    }
    val l = ledger
    val unit = l?.get("bill")?.jsonObject?.get("unit")?.jsonPrimitive?.contentOrNull ?: bill.meterUnit ?: ""
    val editable = l?.get("editable")?.jsonPrimitive?.contentOrNull == "true"
    val totals = l?.get("totals")?.jsonObject

    fun save(date: String, q: Double?) {
        busy = true
        scope.launch {
            runCatching { graph.agent.setDeliveries(h.hid, bill.id, listOf(date to q)) }
                .onSuccess { picked = null; reload++ }.onFailure { nav.toast(it.message ?: "Couldn't update") }
            busy = false
        }
    }

    Text("Deliveries", style = t.label, color = c.ink)
    if (l == null) { Text(error ?: "Loading…", style = t.bodyCompact, color = c.inkSecondary); return }
    val ym = YearMonth.parse(month ?: l["month"]!!.jsonPrimitive.content)
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
        HomeHubIconButton(Icons.AutoMirrored.Outlined.KeyboardArrowLeft, "Previous month", { month = ym.minusMonths(1).toString() })
        Text("${ym.month.name.lowercase().replaceFirstChar { it.uppercase() }} ${ym.year}" + if (l["paid"]?.jsonPrimitive?.contentOrNull == "true") " · paid" else "", style = t.label, color = c.ink)
        HomeHubIconButton(Icons.AutoMirrored.Outlined.KeyboardArrowRight, "Next month", { month = ym.plusMonths(1).toString() })
    }
    val days = l["days"]!!.jsonArray.map { it.jsonObject }
    val lead = LocalDate.parse(days.first()["date"]!!.jsonPrimitive.content).dayOfWeek.value - 1
    val cells: List<JsonObject?> = List(lead) { null } + days
    cells.chunked(7).forEach { week ->
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            for (i in 0 until 7) {
                val d = week.getOrNull(i)
                if (d == null) { Box(Modifier.weight(1f).size(44.dp)); continue }
                val date = d["date"]!!.jsonPrimitive.content
                val status = d["status"]!!.jsonPrimitive.content
                val qv = d["quantity"]!!.jsonPrimitive.doubleOrNull ?: 0.0
                val bg = when (status) { "skipped" -> c.danger.copy(alpha = 0.18f); "extra" -> c.brand.copy(alpha = 0.22f); "delivered" -> c.brand.copy(alpha = 0.08f); else -> c.surfaceSubtle }
                val desc = when (status) { "skipped" -> "not delivered"; "extra" -> "${trimQty(qv)} $unit, changed"; "delivered" -> "${trimQty(qv)} $unit delivered"; "planned" -> "planned ${trimQty(qv)} $unit"; else -> "no delivery" }
                Box(
                    Modifier.weight(1f).size(44.dp).background(bg, RoundedCornerShape(10.dp))
                        .then(if (editable) Modifier.clickable { picked = date; custom = trimQty(qv) } else Modifier)
                        .semantics { contentDescription = "${date.takeLast(2).trimStart('0')}, $desc" },
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(date.takeLast(2).trimStart('0'), style = t.caption, color = c.ink)
                        if (status != "none") Text(if (status == "skipped") "–" else trimQty(qv), style = t.caption, color = if (status == "skipped") c.danger else c.inkSecondary)
                    }
                }
            }
        }
    }
    picked?.let { date ->
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(LocalDate.parse(date).let { "${it.dayOfMonth} ${it.month.name.lowercase().replaceFirstChar { c0 -> c0.uppercase() }}" }, style = t.label, color = c.ink)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                HomeHubButton("Didn't come", { save(date, 0.0) }, Modifier.weight(1f), kind = ButtonKind.Secondary, enabled = !busy)
                HomeHubButton("Normal", { save(date, null) }, Modifier.weight(1f), kind = ButtonKind.Secondary, enabled = !busy)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
                HomeHubTextField("Quantity ($unit)", custom, { custom = it }, Modifier.weight(1f), keyboardType = KeyboardType.Decimal)
                HomeHubButton("Set", { custom.toDoubleOrNull()?.takeIf { it >= 0 }?.let { save(date, it) } }, enabled = !busy && custom.toDoubleOrNull() != null)
            }
        }
    } ?: if (editable) Text("Tap a day to mark it as not delivered or change the quantity.", style = t.caption, color = c.inkSecondary) else Text("This month is closed.", style = t.caption, color = c.inkSecondary)
    if (totals != null) {
        val delivered = totals["deliveredDays"]?.jsonPrimitive?.intOrNull ?: 0
        val skipped = totals["skippedDays"]?.jsonPrimitive?.intOrNull ?: 0
        val planned = totals["plannedDays"]?.jsonPrimitive?.intOrNull ?: 0
        val qty = totals["quantity"]?.jsonPrimitive?.doubleOrNull ?: 0.0
        val total = totals["totalMinor"]?.jsonPrimitive?.longOrNull ?: 0
        Text("${delivered + planned} days delivered · $skipped skipped · ${trimQty(qty)} $unit × ${Money.format(bill.meterRateMinor, bill.currency)} = ${Money.format(total, bill.currency)}", style = t.numeric, color = c.ink)
    }

    var newRate by remember(bill.id) { mutableStateOf("") }
    val newMinor = Money.parse(newRate, bill.currency)?.takeIf { it > 0 }
    fun reprice(thisMonth: Boolean) {
        busy = true
        scope.launch {
            runCatching { graph.agent.updateVendorBill(h.hid, bill.id, buildJsonObject { put("rateMinor", newMinor!!); put("applyToCurrentMonth", thisMonth) }) }
                .onSuccess { nav.toast(if (thisMonth) "Price changed for this month on" else "New price starts next month"); newRate = ""; reload++ }
                .onFailure { nav.toast(it.message ?: "Couldn't change the price") }
            busy = false
        }
    }
    HomeHubTextField("Change price per $unit (${bill.currency})", newRate, { newRate = it }, keyboardType = KeyboardType.Decimal, helper = "Takes effect next month unless you apply it to this month.")
    if (newMinor != null) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        HomeHubButton("From next month", { reprice(false) }, Modifier.weight(1f), kind = ButtonKind.Secondary, enabled = !busy)
        HomeHubButton("This month too", { reprice(true) }, Modifier.weight(1f), enabled = !busy && editable)
    }
}
