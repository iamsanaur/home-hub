package com.e404.homehub.ui.screens

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import com.e404.homehub.ui.components.HomeHubListTile
import com.e404.homehub.ui.Routes
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.ReceiptLong
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.e404.homehub.AppGraph
import com.e404.homehub.data.model.Bill
import com.e404.homehub.data.model.BillPayment
import com.e404.homehub.data.model.Budget
import com.e404.homehub.data.model.Money
import com.e404.homehub.data.model.Txn
import com.e404.homehub.data.repo.Loadable
import com.e404.homehub.ui.LocalActions
import com.e404.homehub.ui.LocalHousehold
import com.e404.homehub.ui.components.BillRow
import com.e404.homehub.ui.components.BillState
import com.e404.homehub.ui.components.BudgetSummary
import com.e404.homehub.ui.components.ButtonKind
import com.e404.homehub.ui.components.Divider
import com.e404.homehub.ui.components.EmptyState
import com.e404.homehub.ui.components.ErrorState
import com.e404.homehub.ui.components.GroupedList
import com.e404.homehub.ui.components.HomeHubButton
import com.e404.homehub.ui.components.HomeHubCard
import com.e404.homehub.ui.components.HomeHubIconButton
import com.e404.homehub.ui.components.HomeHubTextField
import com.e404.homehub.ui.components.LoadingSkeleton
import com.e404.homehub.ui.components.ProgressRow
import com.e404.homehub.ui.components.SectionHeader
import com.e404.homehub.ui.components.SegmentedFilter
import com.e404.homehub.ui.components.Tone
import com.e404.homehub.ui.components.billState
import com.e404.homehub.ui.theme.HomeHubTheme
import com.e404.homehub.ui.theme.Space
import com.e404.homehub.ui.util.Dates
import com.google.firebase.Timestamp
import com.google.firebase.firestore.Query
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.util.Date
import java.util.Locale

val PAYMENT_METHODS = listOf("upi" to "UPI", "card" to "Card", "cash" to "Cash", "bank_transfer" to "Bank transfer", "wallet" to "Wallet", "other" to "Other")
val EXPENSE_CATEGORIES = listOf("Groceries", "Utilities", "Rent", "Transport", "Dining", "Health", "Education", "Household", "Repairs", "Entertainment", "Other")

@Composable
private fun RestrictedNotice() = EmptyState(Icons.Outlined.Lock, "Finance is private", "Your role doesn't include household finance. Ask an owner or administrator if you need access.")

@Composable
fun FinanceScreen() {
    val h = LocalHousehold.current
    val graph = AppGraph.get(LocalContext.current)
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    var month by rememberSaveable { mutableStateOf(YearMonth.now(h.zone).toString()) }
    var adding by remember { mutableStateOf(false) }
    if (!h.canFinance) { ListScreen("Finance") { item { RestrictedNotice() } }; return }
    val ym = YearMonth.parse(month)
    val start = ym.atDay(1).atStartOfDay(h.zone).toInstant()
    val end = ym.plusMonths(1).atDay(1).atStartOfDay(h.zone).toInstant()
    val txns by remember(h.hid, month) {
        graph.data.observe(h.hid, "transactions", { it.whereGreaterThanOrEqualTo("occurredAt", Timestamp(Date.from(start))).whereLessThan("occurredAt", Timestamp(Date.from(end))).orderBy("occurredAt", Query.Direction.DESCENDING) }, Txn::from)
    }.collectAsStateWithLifecycle(Loadable.Loading)
    val budgets by remember(h.hid, month) { graph.data.observe(h.hid, "budgets", { it.whereEqualTo("period", month) }, Budget::from) }.collectAsStateWithLifecycle(Loadable.Loading)

    val toReview by remember(h.hid) { graph.data.records(h.hid, "spendCaptures") { it.whereEqualTo("status", "pending").limit(50) } }.collectAsStateWithLifecycle(Loadable.Loading)
    val nav = com.e404.homehub.ui.LocalActions.current
    ListScreen("Finance", subtitle = ym.format(DateTimeFormatter.ofPattern("MMMM yyyy", Locale.getDefault())), fabIcon = Icons.Outlined.Add, fabLabel = "Add transaction", onFab = { adding = true }, actions = {
        HomeHubIconButton(Icons.AutoMirrored.Outlined.KeyboardArrowLeft, "Previous month", { month = ym.minusMonths(1).toString() }, tint = c.ink)
        HomeHubIconButton(Icons.AutoMirrored.Outlined.KeyboardArrowRight, "Next month", { month = ym.plusMonths(1).toString() }, tint = c.ink, enabled = ym < YearMonth.now(h.zone))
    }) {
        // Automatically captured payments waiting for a decision (Settings → Automatic spending).
        val pendingCount = (toReview as? Loadable.Ready)?.value?.size ?: 0
        if (pendingCount > 0) item {
            HomeHubCard(Modifier.padding(top = Space.sm), onClick = { nav.go(Routes.SPEND_REVIEW) }, padding = androidx.compose.foundation.layout.PaddingValues(vertical = Space.xs)) {
                HomeHubListTile("$pendingCount payment${if (pendingCount > 1) "s" else ""} to review", subtitle = "Captured automatically — confirm to add them", leadingIcon = Icons.Outlined.Inbox, chevron = true)
            }
        }
        item { Spacer(Modifier.height(Space.sm)) }
        when (val tx = txns) {
            Loadable.Loading -> item { LoadingSkeleton() }
            is Loadable.Failed -> item { ErrorState(tx.message) }
            is Loadable.Ready -> {
                // Integer sums in minor units; other-currency records are listed but never mixed into totals.
                val own = tx.value.filter { it.currency == h.currency }
                val spent = own.filter { it.type == "expense" }.sumOf { it.amountMinor }
                val income = own.filter { it.type == "income" }.sumOf { it.amountMinor }
                val bud = (budgets as? Loadable.Ready)?.value.orEmpty()
                val overall = bud.firstOrNull { it.category == "*" || it.category == null }?.limitMinor
                item {
                    HomeHubCard {
                        BudgetSummary(spent, overall, income, h.currency)
                        Spacer(Modifier.height(Space.sm))
                        Row(Modifier.fillMaxWidth()) {
                            KpiCell("Income", Money.format(income, h.currency), Modifier.weight(1f))
                            KpiCell("Spending", Money.format(spent, h.currency), Modifier.weight(1f))
                            KpiCell(if (overall != null) "Remaining budget" else "Net", Money.format(if (overall != null) overall - spent else income - spent, h.currency), Modifier.weight(1f))
                        }
                    }
                }
                val byCat = own.filter { it.type == "expense" }.groupBy { it.category }.mapValues { e -> e.value.sumOf { it.amountMinor } }.toList().sortedByDescending { it.second }
                if (byCat.isNotEmpty()) item {
                    Column {
                        SectionHeader("By category")
                        // Accessible textual summary + exact values (no colour-only chart).
                        HomeHubCard(Modifier.semantics(mergeDescendants = true) { contentDescription = byCat.joinToString("; ") { "${it.first} ${Money.format(it.second, h.currency)}" } }) {
                            byCat.forEach { (cat, amt) ->
                                val limit = bud.firstOrNull { it.category == cat }?.limitMinor
                                val pct = if (limit != null) Money.percent(amt, limit) else Money.percent(amt, spent.coerceAtLeast(1))
                                ProgressRow(cat, pct / 100f, Money.format(amt, h.currency) + (limit?.let { " of ${Money.format(it, h.currency)}" } ?: " · $pct% of spend"),
                                    if (limit != null && pct > 100) Tone.Danger else if (limit != null && pct >= 85) Tone.Warning else Tone.Brand, Modifier.padding(vertical = 6.dp))
                            }
                        }
                    }
                }
                item { SectionHeader("Transactions") }
                if (tx.value.isEmpty()) item { EmptyState(Icons.Outlined.ReceiptLong, "No transactions this month", "Record income and expenses to see where the money goes.", actionLabel = "Add transaction", onAction = { adding = true }) }
                else item {
                    GroupedList {
                        tx.value.forEachIndexed { i, x ->
                            if (i > 0) Divider()
                            Row(Modifier.fillMaxWidth().defaultMinSize(minHeight = 56.dp).padding(horizontal = Space.md, vertical = Space.sm), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(x.description ?: x.category, style = t.cardTitle, color = c.ink)
                                    Text("${x.category} · ${PAYMENT_METHODS.firstOrNull { it.first == x.paymentMethod }?.second ?: x.paymentMethod}" + (x.occurredAt?.let { " · ${Dates.shortDate(it, h.zone)}" } ?: ""), style = t.caption, color = c.inkSecondary)
                                }
                                if (x.locked) Icon(Icons.Outlined.Lock, "Locked record", tint = c.inkTertiary, modifier = Modifier.padding(end = 6.dp))
                                Text((if (x.type == "income") "+" else "−") + Money.format(x.amountMinor, x.currency), style = t.numeric, color = if (x.type == "income") c.success else c.ink)
                            }
                        }
                    }
                }
            }
        }
    }
    if (adding) AddTransactionSheet { adding = false }
}

@Composable
private fun KpiCell(label: String, value: String, modifier: Modifier) {
    Column(modifier) {
        Text(label, style = HomeHubTheme.type.caption, color = HomeHubTheme.colors.inkSecondary)
        Text(value, style = HomeHubTheme.type.numeric, color = HomeHubTheme.colors.ink)
    }
}

@Composable
private fun AddTransactionSheet(onDismiss: () -> Unit) {
    val h = LocalHousehold.current
    val graph = AppGraph.get(LocalContext.current)
    val nav = LocalActions.current
    val scope = rememberCoroutineScope()
    var type by rememberSaveable { mutableStateOf("expense") }
    var amount by rememberSaveable { mutableStateOf("") }
    var category by rememberSaveable { mutableStateOf("Groceries") }
    var method by rememberSaveable { mutableStateOf("upi") }
    var description by rememberSaveable { mutableStateOf("") }
    var date by rememberSaveable { mutableStateOf(LocalDate.now(h.zone).toString()) }
    var busy by remember { mutableStateOf(false) }
    var tried by remember { mutableStateOf(false) }
    val minor = Money.parse(amount, h.currency)?.takeIf { it > 0 }
    val d = runCatching { LocalDate.parse(date) }.getOrNull()
    FormSheet("Add transaction", onDismiss) {
        SegmentedFilter(listOf("Expense", "Income"), if (type == "expense") 0 else 1, { type = if (it == 0) "expense" else "income" })
        HomeHubTextField("Amount (${h.currency})", amount, { amount = it }, keyboardType = KeyboardType.Decimal,
            error = if (tried && minor == null) "Enter an amount, e.g. 450 or 450.50" else null)
        Text("Category", style = HomeHubTheme.type.label, color = HomeHubTheme.colors.ink)
        val cats = if (type == "income") listOf("Salary", "Business", "Interest", "Gift", "Other") else EXPENSE_CATEGORIES
        SegmentedFilter(cats, cats.indexOf(category).coerceAtLeast(0), { category = cats[it] })
        Text("Paid with", style = HomeHubTheme.type.label, color = HomeHubTheme.colors.ink)
        SegmentedFilter(PAYMENT_METHODS.map { it.second }, PAYMENT_METHODS.indexOfFirst { it.first == method }, { method = PAYMENT_METHODS[it].first })
        HomeHubTextField("Description", description, { description = it }, optional = true)
        HomeHubTextField("Date", date, { date = it }, placeholder = "YYYY-MM-DD", error = if (d == null) "Use YYYY-MM-DD" else null)
        HomeHubButton("Save transaction", {
            tried = true
            if (minor == null || d == null) return@HomeHubButton
            busy = true
            val cat = if (category in cats) category else cats.first()
            scope.launch {
                runCatching {
                    graph.data.create(h.hid, "transactions", mapOf("type" to type, "amountMinor" to minor, "currency" to h.currency, "category" to cat,
                        "description" to description.ifBlank { null }, "paymentMethod" to method, "occurredAt" to Timestamp(Date.from(d.atTime(12, 0).atZone(h.zone).toInstant())),
                        "locked" to false, "receiptPath" to null))
                }.onSuccess { onDismiss(); nav.toast("Saved ${Money.format(minor, h.currency)}") }.onFailure { nav.toast(it.message ?: "Couldn't save") }
                busy = false
            }
        }, Modifier.fillMaxWidth(), loading = busy)
    }
}

@Composable
fun BillsScreen() {
    val h = LocalHousehold.current
    val graph = AppGraph.get(LocalContext.current)
    val c = HomeHubTheme.colors
    var selected by remember { mutableStateOf<Bill?>(null) }
    var adding by remember { mutableStateOf(false) }
    if (!h.canFinance) { ListScreen("Bills") { item { RestrictedNotice() } }; return }
    val bills by remember(h.hid) { graph.data.observe(h.hid, "bills", { it.orderBy("nextDueAt") }, Bill::from) }.collectAsStateWithLifecycle(Loadable.Loading)
    ListScreen("Bills", fabIcon = Icons.Outlined.Add, fabLabel = "Add bill", onFab = { adding = true }) {
        when (val b = bills) {
            Loadable.Loading -> item { LoadingSkeleton() }
            is Loadable.Failed -> item { ErrorState(b.message) }
            is Loadable.Ready -> {
                val active = b.value.filter { it.active }
                if (active.isEmpty()) item { EmptyState(Icons.Outlined.ReceiptLong, "No bills yet", "Add recurring bills to get reminders before they're due.", actionLabel = "Add a bill", onAction = { adding = true }) }
                BillState.entries.forEach { state ->
                    val rows = active.filter { billState(it, h.zone) == state }
                    if (rows.isNotEmpty()) item {
                        Column {
                            SectionHeader(state.label)
                            GroupedList { rows.forEachIndexed { i, bill -> if (i > 0) Divider(); BillRow(bill, h.zone) { selected = bill } } }
                        }
                    }
                }
                item { Text("Payments are recorded only when you confirm them. HomeHub never pays bills.", style = HomeHubTheme.type.caption, color = c.inkSecondary, modifier = Modifier.padding(top = Space.md)) }
            }
        }
    }
    selected?.let { BillDetailSheet(it) { selected = null } }
    if (adding) AddBillSheet { adding = false }
}

@Composable
private fun BillDetailSheet(bill: Bill, onDismiss: () -> Unit) {
    val h = LocalHousehold.current
    val graph = AppGraph.get(LocalContext.current)
    val nav = LocalActions.current
    val scope = rememberCoroutineScope()
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    val payments by remember(bill.id) { graph.data.observe(h.hid, "billPayments", { it.whereEqualTo("billId", bill.id).orderBy("paidAt", Query.Direction.DESCENDING).limit(12) }, BillPayment::from) }.collectAsStateWithLifecycle(Loadable.Loading)
    var amount by rememberSaveable(bill.id) { mutableStateOf(Money.toInput(bill.amountMinor, bill.currency)) }
    var method by rememberSaveable { mutableStateOf("upi") }
    var confirming by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val minor = Money.parse(amount, bill.currency)?.takeIf { it > 0 }
    FormSheet(bill.name, onDismiss) {
        Text("${Money.format(bill.amountMinor, bill.currency)} · " + (bill.nextDueAt?.let { "due ${Dates.relative(it, h.zone)}" } ?: "no due date") + (bill.recurrence?.let { " · repeats $it" } ?: ""), style = t.body, color = c.ink)
        Text("Record a payment", style = t.label, color = c.ink)
        HomeHubTextField("Amount paid (${bill.currency})", amount, { amount = it }, keyboardType = KeyboardType.Decimal, error = if (minor == null) "Enter the amount you paid." else null)
        SegmentedFilter(PAYMENT_METHODS.map { it.second }, PAYMENT_METHODS.indexOfFirst { it.first == method }, { method = PAYMENT_METHODS[it].first })
        if (!confirming) HomeHubButton("I've paid this bill", { if (minor != null) confirming = true }, Modifier.fillMaxWidth(), enabled = minor != null)
        else {
            Text("Confirm: you paid ${Money.format(minor ?: 0, bill.currency)} for ${bill.name} today by ${PAYMENT_METHODS.first { it.first == method }.second}. This adds an expense and moves the next due date.", style = t.bodyCompact, color = c.inkSecondary)
            Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                HomeHubButton("Cancel", { confirming = false }, Modifier.weight(1f), kind = ButtonKind.Secondary)
                HomeHubButton("Confirm payment", {
                    busy = true
                    scope.launch {
                        runCatching { graph.agent.recordBillPayment(h.hid, bill.id, minor!!, bill.currency, Instant.now().toString(), method) }
                            .onSuccess { onDismiss(); nav.toast("Payment recorded") }.onFailure { nav.toast(it.message ?: "Couldn't record payment") }
                        busy = false
                    }
                }, Modifier.weight(1f), loading = busy)
            }
        }
        Text("Payment history", style = t.label, color = c.ink)
        when (val p = payments) {
            is Loadable.Ready -> if (p.value.isEmpty()) Text("No payments recorded yet.", style = t.bodyCompact, color = c.inkSecondary)
                else p.value.forEach { pay -> Row(Modifier.fillMaxWidth()) {
                    Text(pay.paidAt?.let { Dates.shortDate(it, h.zone) } ?: "—", style = t.bodyCompact, color = c.inkSecondary, modifier = Modifier.weight(1f))
                    Text(Money.format(pay.amountMinor, pay.currency), style = t.numeric, color = c.ink)
                } }
            else -> LoadingSkeleton(2)
        }
    }
}

@Composable
private fun AddBillSheet(onDismiss: () -> Unit) {
    val h = LocalHousehold.current
    val graph = AppGraph.get(LocalContext.current)
    val nav = LocalActions.current
    val scope = rememberCoroutineScope()
    var name by rememberSaveable { mutableStateOf("") }
    var amount by rememberSaveable { mutableStateOf("") }
    var due by rememberSaveable { mutableStateOf(LocalDate.now(h.zone).plusDays(7).toString()) }
    var repeat by rememberSaveable { mutableStateOf("monthly") }
    var category by rememberSaveable { mutableStateOf("Utilities") }
    var tried by remember { mutableStateOf(false) }
    val minor = Money.parse(amount, h.currency)?.takeIf { it > 0 }
    val d = runCatching { LocalDate.parse(due) }.getOrNull()
    val cats = listOf("Utilities", "Rent", "Insurance", "School fees", "Maintenance", "Loan", "Subscription", "Mobile", "Internet", "Other")
    FormSheet("Add bill", onDismiss) {
        HomeHubTextField("Bill name", name, { name = it }, placeholder = "e.g. Electricity", error = if (tried && name.isBlank()) "Name the bill." else null)
        HomeHubTextField("Amount (${h.currency})", amount, { amount = it }, keyboardType = KeyboardType.Decimal, error = if (tried && minor == null) "Enter the usual amount." else null)
        HomeHubTextField("Next due date", due, { due = it }, placeholder = "YYYY-MM-DD", error = if (d == null) "Use YYYY-MM-DD" else null)
        SegmentedFilter(listOf("Monthly", "Yearly", "One-off"), listOf("monthly", "yearly", "none").indexOf(repeat), { repeat = listOf("monthly", "yearly", "none")[it] })
        SegmentedFilter(cats, cats.indexOf(category), { category = cats[it] })
        HomeHubButton("Add bill", {
            tried = true
            if (name.isBlank() || minor == null || d == null) return@HomeHubButton
            val ts = Timestamp(Date.from(d.atTime(10, 0).atZone(h.zone).toInstant()))
            scope.launch {
                runCatching {
                    graph.data.create(h.hid, "bills", mapOf("name" to name.trim(), "category" to category, "provider" to null, "amountMinor" to minor, "currency" to h.currency,
                        "nextDueAt" to ts, "seriesStartAt" to ts, "recurrence" to if (repeat == "none") null else mapOf("freq" to repeat), "reminderDaysBefore" to 3, "active" to true, "status" to "upcoming"))
                }.onSuccess { onDismiss() }.onFailure { nav.toast(it.message ?: "Couldn't add bill") }
            }
        }, Modifier.fillMaxWidth())
    }
}
