package com.e404.homehub.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ShowChart
import androidx.compose.material.icons.rounded.Groups
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.GridView
import androidx.compose.material.icons.rounded.Home
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Insights
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Insights
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.e404.homehub.ui.components.GlassNavigationBar
import com.e404.homehub.ui.components.LocalGlassBackdrop
import com.e404.homehub.ui.components.NavDestination
import com.e404.homehub.ui.components.glass
import com.e404.homehub.ui.screens.AiScreen
import com.e404.homehub.ui.screens.ApprovalsScreen
import com.e404.homehub.ui.screens.AuthFlow
import com.e404.homehub.ui.screens.BillsScreen
import com.e404.homehub.ui.screens.CalendarScreen
import com.e404.homehub.ui.screens.CleaningScreen
import com.e404.homehub.ui.screens.ConflictsScreen
import com.e404.homehub.ui.screens.ConnectionsScreen
import com.e404.homehub.ui.screens.ModelAccountsScreen
import com.e404.homehub.ui.screens.IntegrationsScreen
import com.e404.homehub.ui.screens.DevicesScreen
import com.e404.homehub.ui.screens.AutomationsScreen
import com.e404.homehub.ui.screens.ChannelsScreen
import com.e404.homehub.ui.screens.AgentsScreen
import com.e404.homehub.ui.screens.ActivityScreen
import com.e404.homehub.ui.screens.PrivacyScreen
import com.e404.homehub.ui.screens.SpendReviewScreen
import com.e404.homehub.ui.screens.DocumentsScreen
import com.e404.homehub.ui.screens.FamilyScreen
import com.e404.homehub.ui.screens.FinanceScreen
import com.e404.homehub.ui.screens.HomeScreen
import com.e404.homehub.ui.screens.InsightsScreen
import com.e404.homehub.ui.screens.InventoryScreen
import com.e404.homehub.ui.screens.AssetsScreen
import com.e404.homehub.ui.screens.SavingsGoalsScreen
import com.e404.homehub.ui.screens.MaintenanceScreen
import com.e404.homehub.ui.screens.ManageScreen
import com.e404.homehub.ui.screens.MealsScreen
import com.e404.homehub.ui.screens.NotesScreen
import com.e404.homehub.ui.screens.NotificationsScreen
import com.e404.homehub.ui.screens.OnboardingFlow
import com.e404.homehub.ui.screens.PantryScreen
import com.e404.homehub.ui.screens.SettingsScreen
import com.e404.homehub.ui.screens.ShoppingScreen
import com.e404.homehub.ui.screens.TasksScreen
import com.e404.homehub.ui.theme.GlassStrength
import com.e404.homehub.ui.theme.HomeHubTheme
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.hazeSource

object Routes {
    const val HOME = "home"; const val MANAGE = "manage"; const val AI = "ai"; const val FAMILY = "family"; const val INSIGHTS = "insights"
    const val TASKS = "tasks"; const val CLEANING = "cleaning"; const val SHOPPING = "shopping"; const val PANTRY = "pantry"; const val MEALS = "meals"
    const val FINANCE = "finance"; const val BILLS = "bills"; const val MAINTENANCE = "maintenance"; const val INVENTORY = "inventory"; const val ASSETS = "assets"; const val SAVINGS = "savings"
    const val CALENDAR = "calendar"; const val DOCUMENTS = "documents"; const val NOTES = "notes"; const val APPROVALS = "approvals"
    const val NOTIFICATIONS = "notifications"; const val SETTINGS = "settings"; const val CONFLICTS = "conflicts"
    const val CONNECTIONS = "connections"; const val MODEL_ACCOUNTS = "model-accounts"; const val INTEGRATIONS = "integrations"; const val DEVICES = "devices"
    const val AUTOMATIONS = "automations"; const val CHANNELS = "channels"; const val AGENTS = "agents"; const val ACTIVITY = "activity"; const val PRIVACY = "privacy"; const val SPEND_REVIEW = "spend-review"
}

/** App-wide services available to screens. */
class AppActions(val nav: NavHostController, val snackbar: SnackbarHostState, val vm: AppViewModel) {
    fun go(route: String) = nav.navigate(route) { launchSingleTop = true }
    fun back() = nav.popBackStack()
    suspend fun toast(msg: String) { snackbar.showSnackbar(msg) }
}
val LocalActions = staticCompositionLocalOf<AppActions> { error("no actions") }

private val primary = listOf(
    NavDestination(Routes.HOME, "Home", Icons.Rounded.Home, Icons.Rounded.Home),
    NavDestination(Routes.MANAGE, "Manage", Icons.Rounded.GridView, Icons.Rounded.GridView),
    NavDestination(Routes.AI, "AI", Icons.Rounded.AutoAwesome, Icons.Rounded.AutoAwesome),
    NavDestination(Routes.FAMILY, "Family", Icons.Rounded.Groups, Icons.Rounded.Groups),
    NavDestination(Routes.INSIGHTS, "Insights", Icons.Rounded.ShowChart, Icons.Rounded.ShowChart),
)

@Composable
fun HomeHubRoot(deepLink: String?, onDeepLinkHandled: () -> Unit) {
    val vm: AppViewModel = viewModel()
    val gate by vm.gate.collectAsStateWithLifecycle()
    val c = HomeHubTheme.colors
    Box(Modifier.fillMaxSize().background(c.canvas)) {
        when (val g = gate) {
            Gate.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.brand) }
            Gate.SignedOut -> AuthFlow()
            is Gate.Onboarding -> OnboardingFlow(g.uid, g.profile)
            is Gate.Ready -> CompositionLocalProvider(LocalHousehold provides g.ctx) {
                MainShell(vm, deepLink, onDeepLinkHandled)
            }
        }
    }
}

@Composable
private fun MainShell(vm: AppViewModel, deepLink: String?, onDeepLinkHandled: () -> Unit) {
    val nav = rememberNavController()
    val snackbar = remember { SnackbarHostState() }
    val actions = remember(nav) { AppActions(nav, snackbar, vm) }
    val haze = remember { HazeState() }
    val c = HomeHubTheme.colors
    val backStack by nav.currentBackStackEntryAsState()
    val route = backStack?.destination?.route
    val wide = LocalConfiguration.current.screenWidthDp >= 840
    // Like the iOS TabView: the tab bar stays on pushed screens and keeps the owning tab selected.
    var owningTab by rememberSaveable { mutableStateOf(Routes.HOME) }
    LaunchedEffect(route) {
        when {
            route in primary.map { it.route } -> owningTab = route!!
            route?.startsWith("${Routes.AI}/") == true -> owningTab = Routes.AI
        }
    }
    val selectedTab = if (route in primary.map { it.route }) route else owningTab
    val showBar = route != null
    val reduceMotion = HomeHubTheme.a11y.reduceMotion

    LaunchedEffect(deepLink) {
        val link = deepLink ?: return@LaunchedEffect
        val target = link.removePrefix("homehub://").substringBefore('/').substringBefore('?').ifEmpty { Routes.HOME }
        val known = setOf(Routes.HOME, Routes.APPROVALS, Routes.BILLS, Routes.PANTRY, Routes.MAINTENANCE, Routes.INSIGHTS, Routes.TASKS, Routes.AI, Routes.CALENDAR, Routes.MODEL_ACCOUNTS, Routes.DEVICES, Routes.AUTOMATIONS, Routes.CHANNELS, Routes.CONNECTIONS)
        nav.navigate(if (target in known) target else Routes.HOME) { launchSingleTop = true }
        onDeepLinkHandled()
    }

    CompositionLocalProvider(LocalActions provides actions, LocalGlassBackdrop provides haze) {
        Row(Modifier.fillMaxSize()) {
            if (wide) GlassRail(selectedTab) { actions.navigateTop(it) }
            Box(Modifier.weight(1f).fillMaxHeight()) {
                // Content layer: the glass samples this.
                NavHost(
                    nav, startDestination = Routes.HOME,
                    modifier = Modifier.fillMaxSize().background(c.canvas).hazeSource(haze),
                    enterTransition = { if (reduceMotion) EnterTransition.None else fadeIn() },
                    exitTransition = { if (reduceMotion) ExitTransition.None else fadeOut() },
                ) {
                    composable(Routes.HOME) { HomeScreen() }
                    composable(Routes.MANAGE) { ManageScreen() }
                    composable(Routes.AI) { AiScreen() }
                    composable(Routes.FAMILY) { FamilyScreen() }
                    composable(Routes.INSIGHTS) { InsightsScreen() }
                    composable(Routes.TASKS) { TasksScreen() }
                    composable(Routes.CLEANING) { CleaningScreen() }
                    composable(Routes.SHOPPING) { ShoppingScreen() }
                    composable(Routes.PANTRY) { PantryScreen() }
                    composable(Routes.MEALS) { MealsScreen() }
                    composable(Routes.FINANCE) { FinanceScreen() }
                    composable(Routes.BILLS) { BillsScreen() }
                    composable(Routes.MAINTENANCE) { MaintenanceScreen() }
                    composable(Routes.INVENTORY) { InventoryScreen() }
                    composable(Routes.ASSETS) { AssetsScreen() }
                    composable(Routes.SAVINGS) { SavingsGoalsScreen() }
                    composable(Routes.CALENDAR) { CalendarScreen() }
                    composable(Routes.DOCUMENTS) { DocumentsScreen() }
                    composable(Routes.NOTES) { NotesScreen() }
                    composable(Routes.APPROVALS) { ApprovalsScreen() }
                    composable(Routes.NOTIFICATIONS) { NotificationsScreen() }
                    composable(Routes.SETTINGS) { SettingsScreen() }
                    composable(Routes.CONFLICTS) { ConflictsScreen() }
                    composable(Routes.CONNECTIONS) { ConnectionsScreen() }
                    composable(Routes.MODEL_ACCOUNTS) { ModelAccountsScreen() }
                    composable(Routes.INTEGRATIONS) { IntegrationsScreen() }
                    composable(Routes.DEVICES) { DevicesScreen() }
                    composable(Routes.AUTOMATIONS) { AutomationsScreen() }
                    composable(Routes.CHANNELS) { ChannelsScreen() }
                    composable(Routes.AGENTS) { AgentsScreen() }
                    composable(Routes.ACTIVITY) { ActivityScreen() }
                    composable(Routes.PRIVACY) { PrivacyScreen() }
                    composable(Routes.SPEND_REVIEW) { SpendReviewScreen() }
                    composable("${Routes.AI}/{prompt}", arguments = listOf(navArgument("prompt") { type = NavType.StringType })) { AiScreen(initialPrompt = it.arguments?.getString("prompt")) }
                }
                // Functional layer: floating glass navigation (compact widths only).
                FloatingNavBar(showBar && !wide, selectedTab, Modifier.align(Alignment.BottomCenter)) { actions.navigateTop(it) }
                SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).windowInsetsPadding(WindowInsets.safeDrawing).padding(bottom = if (showBar && !wide) 84.dp else 16.dp))
            }
        }
    }
}

fun AppActions.navigateTop(route: String) = nav.navigate(route) {
    popUpTo(Routes.HOME) { saveState = true }
    launchSingleTop = true
    restoreState = true
}

@Composable
private fun FloatingNavBar(visible: Boolean, route: String?, modifier: Modifier, onSelect: (String) -> Unit) {
    val reduce = HomeHubTheme.a11y.reduceMotion
    AnimatedVisibility(
        visible = visible,
        modifier = modifier,
        enter = if (reduce) EnterTransition.None else slideInVertically { it } + fadeIn(),
        exit = if (reduce) ExitTransition.None else slideOutVertically { it } + fadeOut(),
    ) {
        GlassNavigationBar(
            primary, route, onSelect = { onSelect(it.route) },
            modifier = Modifier.windowInsetsPadding(WindowInsets.navigationBars).padding(horizontal = 16.dp, vertical = 10.dp),
        )
    }
}

/** Tablet/desktop: a glass navigation rail instead of the floating bar (design.md §4 breakpoints). */
@Composable
private fun GlassRail(route: String?, onSelect: (String) -> Unit) {
    val c = HomeHubTheme.colors
    Column(
        Modifier.fillMaxHeight().windowInsetsPadding(WindowInsets.safeDrawing).padding(12.dp).width(88.dp)
            .glass(GlassStrength.Regular, RoundedCornerShape(28.dp)).padding(vertical = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        primary.forEach { d ->
            val selected = d.route == route
            Column(
                Modifier.size(width = 72.dp, height = 64.dp).selectable(selected, role = Role.Tab) { onSelect(d.route) }
                    .background(if (selected) c.brandTint else androidx.compose.ui.graphics.Color.Transparent, RoundedCornerShape(18.dp)),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
            ) {
                Icon(if (selected) d.selectedIcon else d.icon, null, tint = if (selected) c.brand else c.inkSecondary)
                Spacer(Modifier.height(2.dp))
                Text(d.label, style = HomeHubTheme.type.caption, color = if (selected) c.ink else c.inkSecondary)
            }
        }
    }
}

/** Standard content padding that keeps the last row clear of the floating bar. */
@Composable
fun screenPadding(): PaddingValues {
    val wide = LocalConfiguration.current.screenWidthDp >= 840
    return PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = if (wide) 24.dp else 112.dp)
}
