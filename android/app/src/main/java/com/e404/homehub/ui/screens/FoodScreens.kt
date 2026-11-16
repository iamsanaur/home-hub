package com.e404.homehub.ui.screens

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Kitchen
import androidx.compose.material.icons.outlined.RemoveShoppingCart
import androidx.compose.material.icons.outlined.RestaurantMenu
import androidx.compose.material.icons.outlined.ShoppingCart
import androidx.compose.material.icons.outlined.WarningAmber
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.e404.homehub.AppGraph
import com.e404.homehub.data.model.MealPlan
import com.e404.homehub.data.model.Money
import com.e404.homehub.data.model.PantryItem
import com.e404.homehub.data.model.Recipe
import com.e404.homehub.data.model.ShoppingList
import com.e404.homehub.data.remote.GatewayException
import com.e404.homehub.data.repo.Loadable
import com.e404.homehub.ui.LocalActions
import com.e404.homehub.ui.LocalHousehold
import com.e404.homehub.ui.Routes
import com.e404.homehub.ui.components.ButtonKind
import com.e404.homehub.ui.components.Divider
import com.e404.homehub.ui.components.EmptyState
import com.e404.homehub.ui.components.ErrorState
import com.e404.homehub.ui.components.GroceryItemRow
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
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.format.TextStyle
import java.time.temporal.TemporalAdjusters
import java.util.Locale

// ---------------- Shopping ----------------

@Composable
fun ShoppingScreen() {
    val h = LocalHousehold.current
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val nav = LocalActions.current
    val lists by remember(h.hid) { graph.data.observe(h.hid, "shoppingLists", { it.whereEqualTo("archived", false) }, ShoppingList::from) }.collectAsStateWithLifecycle(Loadable.Loading)
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    var adding by remember { mutableStateOf(false) }
    var newList by remember { mutableStateOf(false) }
    val all = (lists as? Loadable.Ready)?.value.orEmpty()
    val active = all.firstOrNull { it.id == selected } ?: all.firstOrNull()
    LaunchedEffect(active?.id) { active?.let { graph.offline.attachList(h.hid, it.id) } }
    val items by remember(h.hid, active?.id) { active?.let { graph.offline.groceries(h.hid, it.id) } ?: kotlinx.coroutines.flow.flowOf(emptyList()) }.collectAsStateWithLifecycle(emptyList())
    val canCreateList = h.role.isAdultPlus || h.role.id == "staff"

    ListScreen("Shopping", subtitle = active?.name, fabIcon = if (active != null) Icons.Outlined.Add else null, fabLabel = "Add item", onFab = { adding = true },
        actions = { if (canCreateList) HomeHubButton("New list", { newList = true }, kind = ButtonKind.Tertiary) }) {
        when (lists) {
            Loadable.Loading -> item { LoadingSkeleton() }
            is Loadable.Failed -> item { ErrorState((lists as Loadable.Failed).message) }
            is Loadable.Ready -> {
                if (all.isEmpty()) item {
                    EmptyState(Icons.Outlined.ShoppingCart, "No shopping lists yet", "Create a list, or let the assistant build one from your pantry and meal plan.",
                        actionLabel = if (canCreateList) "Create a list" else null, onAction = { newList = true })
                } else {
                    if (all.size > 1) item { SegmentedFilter(all.map { it.name }, all.indexOf(active).coerceAtLeast(0), { selected = all[it].id }, Modifier.padding(vertical = 8.dp)) }
                    val toBuy = items.filter { !it.purchased }
                    val estimate = toBuy.mapNotNull { it.estimatedPriceMinor }.sum()
                    val unpriced = toBuy.count { it.estimatedPriceMinor == null }
                    item {
                        Text(
                            "${toBuy.size} to buy" + if (estimate > 0) " · about ${Money.format(estimate, h.currency)}" + (if (unpriced > 0) " ($unpriced without a price)" else "") else "",
                            style = HomeHubTheme.type.bodyCompact, color = HomeHubTheme.colors.inkSecondary, modifier = Modifier.padding(vertical = 4.dp),
                        )
                    }
                    if (items.isEmpty()) item { EmptyState(Icons.Outlined.RemoveShoppingCart, "This list is empty", "Add what you need. Identical items are merged automatically.", actionLabel = "Add item", onAction = { adding = true }) }
                    toBuy.groupBy { it.category }.toSortedMap().forEach { (cat, rows) ->
                        item {
                            Column {
                                SectionHeader(cat)
                                GroupedList { rows.forEachIndexed { i, it -> if (i > 0) Divider(); GroceryItemRow(it, h.currency, { p -> scope.launch { graph.offline.setPurchased(h.hid, h.uid, it.id, p) } }, { scope.launch { graph.offline.deleteGrocery(h.hid, it.id); nav.toast("Removed ${it.name}") } }) } }
                            }
                        }
                    }
                    val bought = items.filter { it.purchased }
                    if (bought.isNotEmpty()) item {
                        Column {
                            SectionHeader("In the basket")
                            GroupedList { bought.forEachIndexed { i, it -> if (i > 0) Divider(); GroceryItemRow(it, h.currency, { p -> scope.launch { graph.offline.setPurchased(h.hid, h.uid, it.id, p) } }, { scope.launch { graph.offline.deleteGrocery(h.hid, it.id) } }) } }
                        }
                    }
                }
            }
        }
    }
    if (adding && active != null) AddGroceryItem(active.id) { adding = false }
    if (newList) {
        var name by rememberSaveable { mutableStateOf("") }
        var busy by remember { mutableStateOf(false) }
        FormSheet("New shopping list", { newList = false }) {
            HomeHubTextField("List name", name, { name = it }, placeholder = "e.g. Weekly groceries")
            HomeHubButton("Create list", {
                if (name.isBlank()) return@HomeHubButton
                busy = true
                scope.launch { runCatching { graph.data.create(h.hid, "shoppingLists", mapOf("name" to name.trim(), "store" to null, "archived" to false, "itemCount" to 0, "purchasedCount" to 0)) }.onSuccess { selected = it; newList = false }; busy = false }
            }, Modifier.fillMaxWidth(), loading = busy)
        }
    }
}

private val UNITS = listOf("pcs", "kg", "g", "l", "ml", "pack", "dozen", "bunch")
private val GROCERY_CATEGORIES = listOf("Vegetables", "Fruit", "Dairy", "Staples", "Snacks", "Household", "Personal care", "Other")

@Composable
private fun AddGroceryItem(listId: String, onDismiss: () -> Unit) {
    val h = LocalHousehold.current
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    var name by rememberSaveable { mutableStateOf("") }
    var qty by rememberSaveable { mutableStateOf("1") }
    var unit by rememberSaveable { mutableStateOf("pcs") }
    var cat by rememberSaveable { mutableStateOf("Other") }
    var price by rememberSaveable { mutableStateOf("") }
    var tried by remember { mutableStateOf(false) }
    val q = qty.toBigDecimalOrNull()?.takeIf { it.signum() > 0 }
    val p = price.takeIf { it.isNotBlank() }?.let { Money.parse(it, h.currency) }
    FormSheet("Add item", onDismiss) {
        HomeHubTextField("Item", name, { name = it }, error = if (tried && name.isBlank()) "What do you need?" else null)
        HomeHubTextField("Quantity", qty, { qty = it }, keyboardType = KeyboardType.Decimal, error = if (tried && q == null) "Enter a quantity above 0." else null)
        Text("Unit", style = HomeHubTheme.type.label, color = HomeHubTheme.colors.ink)
        SegmentedFilter(UNITS, UNITS.indexOf(unit), { unit = UNITS[it] })
        Text("Category", style = HomeHubTheme.type.label, color = HomeHubTheme.colors.ink)
        SegmentedFilter(GROCERY_CATEGORIES, GROCERY_CATEGORIES.indexOf(cat), { cat = GROCERY_CATEGORIES[it] })
        HomeHubTextField("Estimated price (${h.currency})", price, { price = it }, optional = true, keyboardType = KeyboardType.Decimal,
            helper = "Used for list estimates. Leave empty if you don't know.", error = if (price.isNotBlank() && p == null) "Not a valid amount." else null)
        HomeHubButton("Add to list", {
            tried = true
            if (name.isBlank() || q == null || (price.isNotBlank() && p == null)) return@HomeHubButton
            scope.launch { graph.offline.addGrocery(h.hid, listId, name, q.toDouble(), unit, cat, p); onDismiss() }
        }, Modifier.fillMaxWidth())
    }
}

// ---------------- Pantry ----------------

@Composable
fun PantryScreen() {
    val h = LocalHousehold.current
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val nav = LocalActions.current
    val pantry by remember(h.hid) { graph.data.observe(h.hid, "pantryItems", { it.orderBy("name") }, PantryItem::from) }.collectAsStateWithLifecycle(Loadable.Loading)
    var editing by remember { mutableStateOf<PantryItem?>(null) }
    var adding by remember { mutableStateOf(false) }
    val canWrite = h.role.isAdultPlus || h.role.id == "staff"
    val soon = Instant.now().plusSeconds(3 * 86400)
    ListScreen("Pantry", fabIcon = if (canWrite) Icons.Outlined.Add else null, fabLabel = "Add pantry item", onFab = { adding = true }) {
        when (val p = pantry) {
            Loadable.Loading -> item { LoadingSkeleton() }
            is Loadable.Failed -> item { ErrorState(p.message) }
            is Loadable.Ready -> {
                if (p.value.isEmpty()) item { EmptyState(Icons.Outlined.Kitchen, "Pantry is empty", "Track staples with a minimum level and HomeHub will tell you when they run low.", actionLabel = if (canWrite) "Add an item" else null, onAction = { adding = true }) }
                val low = p.value.filter { it.lowStock }
                if (low.isNotEmpty()) item {
                    HomeHubCard(Modifier.padding(top = 8.dp)) {
                        Text("${low.size} running low", style = HomeHubTheme.type.cardTitle, color = HomeHubTheme.colors.ink)
                        Text(low.joinToString(", ") { it.name }, style = HomeHubTheme.type.bodyCompact, color = HomeHubTheme.colors.inkSecondary)
                        Spacer(Modifier.height(Space.sm))
                        HomeHubButton("Add them to a shopping list", { nav.go("${Routes.AI}/Add our low-stock pantry items to the shopping list.") }, kind = ButtonKind.Secondary, icon = Icons.Outlined.AutoAwesome)
                    }
                }
                p.value.groupBy { it.location ?: "Other" }.toSortedMap().forEach { (loc, rows) ->
                    item {
                        Column {
                            SectionHeader(loc)
                            GroupedList {
                                rows.forEachIndexed { i, it ->
                                    if (i > 0) Divider()
                                    HomeHubListTile(it.name, subtitle = buildString {
                                        append("${Dates.qty(it.quantity)} ${it.unit}")
                                        it.minQuantity?.let { m -> append(" · min ${Dates.qty(m)}") }
                                        it.expiresAt?.let { e -> append(" · expires ${Dates.shortDate(e, h.zone)}") }
                                        it.updatedAt?.let { u -> append(" · updated ${Dates.shortDate(u, h.zone)}") }
                                    }, onClick = if (canWrite) ({ editing = it }) else null, trailing = {
                                        when {
                                            it.expiresAt != null && it.expiresAt.isBefore(soon) -> StatusBadge("Expiring", Tone.Warning, Icons.Outlined.WarningAmber)
                                            it.lowStock -> StatusBadge("Low", Tone.Warning)
                                        }
                                    })
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    editing?.let { item ->
        var delta by remember { mutableStateOf("") }
        var busy by remember { mutableStateOf(false) }
        FormSheet(item.name, { editing = null }) {
            Text("In stock: ${Dates.qty(item.quantity)} ${item.unit}", style = HomeHubTheme.type.body, color = HomeHubTheme.colors.ink)
            HomeHubTextField("Amount (${item.unit})", delta, { delta = it }, keyboardType = KeyboardType.Decimal)
            val d = delta.toBigDecimalOrNull()?.takeIf { it.signum() > 0 }?.toDouble()
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("Used" to "consume", "Restocked" to "restock", "Wasted" to "waste").forEach { (label, kind) ->
                    HomeHubButton(label, {
                        if (d == null) return@HomeHubButton
                        busy = true
                        scope.launch {
                            runCatching {
                                val signed = if (kind == "restock") d else -d
                                graph.data.append("households/${h.hid}/pantryMovements", mapOf("householdId" to h.hid, "createdBy" to h.uid, "itemId" to item.id, "name" to item.name, "kind" to kind, "delta" to signed, "unit" to item.unit))
                                val next = (item.quantity + signed).coerceAtLeast(0.0)
                                graph.data.update(h.hid, "pantryItems", item.id, mapOf("quantity" to next, "lowStock" to (item.minQuantity != null && next <= item.minQuantity)))
                            }.onSuccess { editing = null; nav.toast("${item.name} updated") }.onFailure { nav.toast(it.message ?: "Couldn't update") }
                            busy = false
                        }
                    }, Modifier.weight(1f), kind = if (kind == "restock") ButtonKind.Primary else ButtonKind.Secondary, enabled = d != null && !busy)
                }
            }
            Text("Every change is recorded in the stock history, including waste.", style = HomeHubTheme.type.caption, color = HomeHubTheme.colors.inkSecondary)
        }
    }
    if (adding) {
        var name by rememberSaveable { mutableStateOf("") }
        var qty by rememberSaveable { mutableStateOf("") }
        var unit by rememberSaveable { mutableStateOf("kg") }
        var min by rememberSaveable { mutableStateOf("") }
        var loc by rememberSaveable { mutableStateOf("Pantry shelf") }
        var expiry by rememberSaveable { mutableStateOf("") }
        FormSheet("Add pantry item", { adding = false }) {
            HomeHubTextField("Item", name, { name = it })
            HomeHubTextField("Quantity", qty, { qty = it }, keyboardType = KeyboardType.Decimal)
            SegmentedFilter(UNITS, UNITS.indexOf(unit).coerceAtLeast(0), { unit = UNITS[it] })
            HomeHubTextField("Minimum to keep", min, { min = it }, optional = true, keyboardType = KeyboardType.Decimal, helper = "You'll be told when stock falls to this level.")
            HomeHubTextField("Storage location", loc, { loc = it })
            HomeHubTextField("Expiry date", expiry, { expiry = it }, optional = true, placeholder = "YYYY-MM-DD",
                error = if (expiry.isNotBlank() && runCatching { LocalDate.parse(expiry) }.isFailure) "Use YYYY-MM-DD" else null)
            HomeHubButton("Add", {
                val q = qty.toBigDecimalOrNull()?.toDouble() ?: return@HomeHubButton
                if (name.isBlank()) return@HomeHubButton
                val m = min.toBigDecimalOrNull()?.toDouble()
                val exp = expiry.takeIf { it.isNotBlank() }?.let { runCatching { LocalDate.parse(it) }.getOrNull() ?: return@HomeHubButton }
                scope.launch {
                    runCatching {
                        graph.data.create(h.hid, "pantryItems", mapOf("name" to name.trim(), "nameKey" to name.trim().lowercase(), "quantity" to q, "unit" to unit, "minQuantity" to m,
                            "lowStock" to (m != null && q <= m), "location" to loc.trim(), "expiresAt" to exp?.let { com.google.firebase.Timestamp(java.util.Date.from(it.atStartOfDay(h.zone).toInstant())) }))
                    }.onSuccess { adding = false }.onFailure { nav.toast(it.message ?: "Couldn't add") }
                }
            }, Modifier.fillMaxWidth())
        }
    }
}

// ---------------- Meals ----------------

private val SLOTS = listOf("breakfast", "lunch", "dinner", "snack")

@Composable
fun MealsScreen() {
    val h = LocalHousehold.current
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val nav = LocalActions.current
    val c = HomeHubTheme.colors
    var weekStart by rememberSaveable { mutableStateOf(LocalDate.now(h.zone).with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)).toString()) }
    val plan by remember(h.hid, weekStart) { graph.data.observeDoc("households/${h.hid}/mealPlans/$weekStart", MealPlan::from) }.collectAsStateWithLifecycle(null)
    val recipes by remember(h.hid) { graph.data.observe(h.hid, "recipes", { it }, Recipe::from) }.collectAsStateWithLifecycle(Loadable.Loading)
    val prefs by remember(h.hid) { graph.data.observeDoc("households/${h.hid}/preferences/dietary") { it.data.orEmpty() } }.collectAsStateWithLifecycle(null)
    var generating by remember { mutableStateOf(false) }
    var addingFor by remember { mutableStateOf<Pair<String, String>?>(null) }
    val start = LocalDate.parse(weekStart)
    val canPlan = h.role.isAdultPlus

    ListScreen("Meals", subtitle = "Week of ${Dates.longDate(start)}", actions = {
        com.e404.homehub.ui.components.HomeHubIconButton(Icons.AutoMirrored.Outlined.KeyboardArrowLeft, "Previous week", { weekStart = start.minusWeeks(1).toString() }, tint = c.ink)
        com.e404.homehub.ui.components.HomeHubIconButton(Icons.AutoMirrored.Outlined.KeyboardArrowRight, "Next week", { weekStart = start.plusWeeks(1).toString() }, tint = c.ink)
    }) {
        prefs?.let { p ->
            val notes = p["notes"] as? String
            @Suppress("UNCHECKED_CAST") val allergies = (p["allergies"] as? List<String>).orEmpty()
            if (!notes.isNullOrBlank() || allergies.isNotEmpty()) item {
                HomeHubCard(Modifier.padding(top = 8.dp)) {
                    Text("Your household's recorded preferences", style = HomeHubTheme.type.label, color = c.inkSecondary)
                    if (!notes.isNullOrBlank()) Text(notes, style = HomeHubTheme.type.bodyCompact, color = c.ink)
                    if (allergies.isNotEmpty()) Row(Modifier.padding(top = 6.dp)) { StatusBadge("Allergies: ${allergies.joinToString()}", Tone.Danger, Icons.Outlined.WarningAmber) }
                }
            }
        }
        if (plan == null) item {
            EmptyState(Icons.Outlined.RestaurantMenu, "No plan for this week", "Plan meals yourself, or let the assistant draft a week from your preferences and pantry.",
                actionLabel = "Plan my week", onAction = { nav.go("${Routes.AI}/Plan meals for the week of $weekStart.") })
        }
        (0..6).forEach { offset ->
            val day = start.plusDays(offset.toLong())
            item {
                Column {
                    SectionHeader("${day.dayOfWeek.getDisplayName(TextStyle.FULL, Locale.getDefault())} ${day.dayOfMonth}")
                    GroupedList {
                        SLOTS.forEachIndexed { i, slot ->
                            if (i > 0) Divider()
                            val entry = plan?.entries?.firstOrNull { it.date == day.toString() && it.slot == slot }
                            HomeHubListTile(entry?.title ?: "—", subtitle = slot.replaceFirstChar { it.uppercase() } + (entry?.let { " · ${it.servings} servings" } ?: ""),
                                onClick = if (canPlan) ({ addingFor = day.toString() to slot }) else null)
                        }
                    }
                }
            }
        }
        if (plan != null && canPlan) item {
            Column(Modifier.padding(top = Space.lg)) {
                HomeHubButton("Generate shopping list", {
                    generating = true
                    scope.launch {
                        runCatching { graph.agent.mealShoppingList(h.hid, weekStart) }.onSuccess { r ->
                            val n = r["items"]?.jsonArray?.size ?: 0
                            val est = r["estimate"]?.jsonObject
                            val total = est?.get("totalMinor")?.jsonPrimitive?.longOrNull ?: 0
                            val unpriced = est?.get("unpricedItems")?.jsonPrimitive?.longOrNull ?: 0
                            nav.toast("Added $n items · about ${Money.format(total, h.currency)}" + if (unpriced > 0) " ($unpriced unpriced)" else "")
                            nav.go(Routes.SHOPPING)
                        }.onFailure { nav.toast((it as? GatewayException)?.message ?: "Couldn't generate the list") }
                        generating = false
                    }
                }, Modifier.fillMaxWidth(), loading = generating)
                Text("Ingredients already in your pantry are left off. Costs use only prices you've recorded.", style = HomeHubTheme.type.caption, color = c.inkSecondary, modifier = Modifier.padding(top = 6.dp))
            }
        }
    }
    addingFor?.let { (date, slot) ->
        val recipeList = (recipes as? Loadable.Ready)?.value.orEmpty()
        val existing = plan?.entries?.firstOrNull { it.date == date && it.slot == slot }
        var title by rememberSaveable(date, slot) { mutableStateOf(existing?.title ?: "") }
        var recipeId by remember(date, slot) { mutableStateOf(existing?.recipeId) }
        var servings by rememberSaveable(date, slot) { mutableStateOf((existing?.servings ?: 4).toString()) }
        FormSheet("${slot.replaceFirstChar { it.uppercase() }} · $date", { addingFor = null }) {
            if (recipeList.isNotEmpty()) {
                Text("From your recipes", style = HomeHubTheme.type.label, color = c.ink)
                SegmentedFilter(recipeList.map { it.name }, recipeList.indexOfFirst { it.id == recipeId }, { recipeId = recipeList[it].id; title = recipeList[it].name })
            }
            HomeHubTextField("Meal", title, { title = it; if (recipeList.none { r -> r.id == recipeId && r.name == it }) recipeId = null })
            HomeHubTextField("Servings", servings, { servings = it }, keyboardType = KeyboardType.Number)
            HomeHubButton("Save", {
                val s = servings.toIntOrNull()?.takeIf { it in 1..50 } ?: return@HomeHubButton
                scope.launch {
                    val entries = plan?.entries.orEmpty().filterNot { it.date == date && it.slot == slot }.toMutableList()
                    if (title.isNotBlank()) entries += com.e404.homehub.data.model.MealEntry(date, slot, title.trim(), recipeId, s)
                    val payload = entries.map { mapOf("date" to it.date, "slot" to it.slot, "title" to it.title, "recipeId" to it.recipeId, "servings" to it.servings) }
                    runCatching {
                        if (plan == null) graph.data.create(h.hid, "mealPlans", mapOf("weekStart" to weekStart, "entries" to payload), weekStart)
                        else graph.data.update(h.hid, "mealPlans", weekStart, mapOf("entries" to payload))
                    }.onSuccess { addingFor = null }.onFailure { nav.toast(it.message ?: "Couldn't save") }
                }
            }, Modifier.fillMaxWidth())
        }
    }
}

