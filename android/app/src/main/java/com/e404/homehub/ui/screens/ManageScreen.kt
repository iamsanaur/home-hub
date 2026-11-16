package com.e404.homehub.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Lightbulb
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.FileCopy
import androidx.compose.material.icons.outlined.Notes
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Restaurant
import androidx.compose.material.icons.outlined.BubbleChart
import androidx.compose.material.icons.outlined.AccountBalanceWallet
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.CleaningServices
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Kitchen
import androidx.compose.material.icons.outlined.ReceiptLong
import androidx.compose.material.icons.outlined.RestaurantMenu
import androidx.compose.material.icons.outlined.ShoppingCart
import androidx.compose.material.icons.outlined.StickyNote2
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material.icons.outlined.Weekend
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.e404.homehub.AppGraph
import com.e404.homehub.data.model.Role
import com.e404.homehub.ui.LocalActions
import com.e404.homehub.ui.LocalHousehold
import com.e404.homehub.ui.Routes
import com.e404.homehub.ui.components.Divider
import com.e404.homehub.ui.components.GroupedList
import com.e404.homehub.ui.components.HomeHubListTile
import com.e404.homehub.ui.components.SectionHeader
import com.e404.homehub.ui.theme.HomeHubTheme

private data class Entry(val title: String, val subtitle: String, val icon: ImageVector, val route: String, val visible: (Role, Boolean) -> Boolean = { _, _ -> true })

private val GROUPS = listOf(
    "Daily routines" to listOf(
        Entry("Tasks", "Chores, errands and reminders", Icons.Outlined.Checklist, Routes.TASKS),
        Entry("Cleaning", "Room-wise routines and deep cleans", Icons.Outlined.BubbleChart, Routes.CLEANING),
    ),
    "Shopping and pantry" to listOf(
        Entry("Shopping lists", "What to buy, by category", Icons.Outlined.ShoppingCart, Routes.SHOPPING),
        Entry("Pantry", "Stock, expiry and low items", Icons.Outlined.Kitchen, Routes.PANTRY),
    ),
    "Food and meals" to listOf(
        Entry("Meal planner", "Weekly menu and recipes", Icons.Outlined.Restaurant, Routes.MEALS) { r, _ -> r != Role.Staff || true },
    ),
    "Money and bills" to listOf(
        Entry("Finance", "Spending, income and budgets", Icons.Outlined.AccountBalanceWallet, Routes.FINANCE) { _, fin -> fin },
        Entry("Bills", "Due dates and payment history", Icons.Outlined.Description, Routes.BILLS) { _, fin -> fin },
    ),
    "Home care" to listOf(
        Entry("Maintenance", "Repairs, servicing and warranties", Icons.Outlined.Build, Routes.MAINTENANCE) { r, _ -> r.isAdultPlus || r == Role.Staff },
        Entry("Inventory", "Furniture, appliances and valuables", Icons.Outlined.Weekend, Routes.INVENTORY) { r, _ -> r.isAdultPlus },
    ),
    "Smart home and connections" to listOf(
        Entry("Devices", "Lights, plugs, AC, locks and sensors", Icons.Outlined.Lightbulb, Routes.DEVICES) { r, _ -> r != Role.Staff },
        Entry("Automations", "When this happens, do that", Icons.Outlined.Bolt, Routes.AUTOMATIONS) { r, _ -> r.isAdultPlus },
        Entry("Connections", "Integrations, AI model, Alexa, activity and privacy", Icons.Outlined.Hub, Routes.CONNECTIONS) { r, _ -> r.isAdultPlus },
    ),
    "Household records" to listOf(
        Entry("Calendar", "Events, birthdays and appointments", Icons.Outlined.CalendarMonth, Routes.CALENDAR),
        Entry("Documents", "Agreements, insurance and warranties", Icons.Outlined.FileCopy, Routes.DOCUMENTS) { r, _ -> r.isAdultPlus },
        Entry("Notes", "Shared and private notes", Icons.Outlined.Notes, Routes.NOTES) { r, _ -> r != Role.Staff },
    ),
)

@Composable
fun ManageScreen() {
    val h = LocalHousehold.current
    val nav = LocalActions.current
    val graph = AppGraph.get(LocalContext.current)
    val tasks by remember(h.hid) { graph.offline.tasks(h.hid) }.collectAsStateWithLifecycle(emptyList())
    val openTasks = tasks.count { !it.isDone }
    ListScreen("Manage", subtitle = h.household.name, showBack = false) {
        GROUPS.forEach { (group, entries) ->
            val shown = entries.filter { it.visible(h.role, h.canFinance) }
            if (shown.isEmpty()) return@forEach
            item {
                Column {
                    SectionHeader(group)
                    GroupedList {
                        shown.forEachIndexed { i, e ->
                            if (i > 0) Divider()
                            HomeHubListTile(e.title, subtitle = e.subtitle, leadingIcon = e.icon, onClick = { nav.go(e.route) }, chevron = true,
                                trailing = { if (e.route == Routes.TASKS && openTasks > 0) Text("$openTasks open", style = HomeHubTheme.type.caption, color = HomeHubTheme.colors.inkSecondary) })
                        }
                    }
                }
            }
        }
    }
}
