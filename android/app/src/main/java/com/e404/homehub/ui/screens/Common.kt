package com.e404.homehub.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.automirrored.rounded.ArrowBackIos
import androidx.compose.material3.Icon
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.e404.homehub.ui.LocalActions
import com.e404.homehub.ui.components.HomeHubIconButton
import com.e404.homehub.ui.screenPadding
import com.e404.homehub.ui.theme.HomeHubTheme
import com.e404.homehub.ui.theme.Radius
import com.e404.homehub.ui.theme.Space

/**
 * Navigation bar matching the iOS app: a glass circle back button, an optional centred inline title
 * (shown once the large title has scrolled away), and actions grouped in a glass capsule.
 * The capsule disappears when [actions] draws nothing.
 */
@Composable
fun HomeHubNavBar(inlineTitle: String? = null, showInlineTitle: Boolean = false, showBack: Boolean = false, actions: @Composable () -> Unit = {}) {
    val c = HomeHubTheme.colors
    val nav = LocalActions.current
    val titleAlpha by animateFloatAsState(if (showInlineTitle) 1f else 0f, tween(if (HomeHubTheme.a11y.reduceMotion) 0 else 160), label = "inlineTitle")
    Box(Modifier.fillMaxWidth().background(c.canvas).windowInsetsPadding(WindowInsets.statusBars).height(60.dp).padding(horizontal = Space.md)) {
        if (showBack) {
            Box(
                Modifier.align(Alignment.CenterStart).size(48.dp).barButton(CircleShape)
                    .clickable(role = Role.Button, onClickLabel = "Back") { nav.back() },
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.AutoMirrored.Rounded.ArrowBackIos, "Back", tint = c.ink, modifier = Modifier.size(22.dp).padding(start = 4.dp)) }
        }
        if (inlineTitle != null) {
            Text(inlineTitle, style = HomeHubTheme.type.cardTitle, color = c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.align(Alignment.Center).padding(horizontal = 64.dp).graphicsLayer { alpha = titleAlpha })
        }
        ActionCapsule(Modifier.align(Alignment.CenterEnd), actions)
    }
}

/** Glass capsule holding toolbar actions; zero-size (and invisible) when there are none. */
@Composable
private fun ActionCapsule(modifier: Modifier, actions: @Composable () -> Unit) {
    val pad = with(LocalDensity.current) { 6.dp.roundToPx() }
    val minH = with(LocalDensity.current) { 48.dp.roundToPx() }
    var empty by remember { mutableStateOf(true) }
    Layout(content = actions, modifier = modifier.then(if (empty) Modifier else Modifier.barButton(CircleShape))) { measurables, constraints ->
        val placeables = measurables.map { it.measure(constraints.copy(minWidth = 0, minHeight = 0)) }.filter { it.width > 0 }
        empty = placeables.isEmpty()
        if (placeables.isEmpty()) return@Layout layout(0, 0) {}
        val h = maxOf(minH, placeables.maxOf { it.height })
        val w = placeables.sumOf { it.width } + pad * 2
        layout(w, h) {
            var x = pad
            placeables.forEach { it.placeRelative(x, (h - it.height) / 2); x += it.width }
        }
    }
}

/** iOS-style large title block: scrolls with the content. */
@Composable
fun LargeTitle(title: String, subtitle: String? = null, modifier: Modifier = Modifier) {
    val c = HomeHubTheme.colors
    Column(modifier.fillMaxWidth().padding(top = Space.xs, bottom = Space.xs)) {
        Text(title, style = HomeHubTheme.type.screenTitle, color = c.ink, modifier = Modifier.semantics { heading() })
        if (subtitle != null) Text(subtitle, style = HomeHubTheme.type.bodyCompact, color = c.inkSecondary, modifier = Modifier.padding(top = Space.xxs))
    }
}

/** Static header for screens that don't scroll as one list (nav bar + large title). */
@Composable
fun HomeHubTopBar(title: String, subtitle: String? = null, showBack: Boolean = false, actions: @Composable () -> Unit = {}) {
    Column(Modifier.background(HomeHubTheme.colors.canvas)) {
        HomeHubNavBar(showBack = showBack, actions = actions)
        LargeTitle(title, subtitle, Modifier.padding(horizontal = Space.md))
    }
}

/**
 * Standard screen, laid out like the iOS app: nav bar (back circle, action capsule), a large title that
 * scrolls with the content and hands over to a centred inline title, list content at a readable width,
 * and an optional floating glass add button.
 */
@Composable
fun ListScreen(
    title: String,
    subtitle: String? = null,
    showBack: Boolean = true,
    actions: @Composable () -> Unit = {},
    fabIcon: ImageVector? = null,
    fabLabel: String? = null,
    onFab: (() -> Unit)? = null,
    content: LazyListScope.() -> Unit,
) {
    val c = HomeHubTheme.colors
    val state = rememberLazyListState()
    val scrolledPastTitle by remember { derivedStateOf { state.firstVisibleItemIndex > 0 || state.firstVisibleItemScrollOffset > 120 } }
    Box(Modifier.fillMaxSize().background(c.canvas)) {
        Column(Modifier.fillMaxSize()) {
            HomeHubNavBar(title, scrolledPastTitle, showBack) {
                actions()
                if (fabIcon != null && onFab != null) HomeHubIconButton(fabIcon, fabLabel ?: "Add", onFab, tint = c.brand)
            }
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                LazyColumn(
                    Modifier.widthIn(max = 760.dp).fillMaxSize(),
                    state = state,
                    contentPadding = screenPadding(),
                    verticalArrangement = Arrangement.spacedBy(0.dp),
                ) {
                    item(key = "largeTitle") { LargeTitle(title, subtitle) }
                    content()
                }
            }
        }
    }
}

/** Contextual short task in a sheet. Forms are solid (design.md: no glass behind text entry). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FormSheet(title: String, onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val c = HomeHubTheme.colors
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = c.surfaceElevated,
        shape = androidx.compose.foundation.shape.RoundedCornerShape(topStart = Radius.sheet, topEnd = Radius.sheet),
    ) {
        Column(
            Modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = Space.lg).padding(bottom = Space.xxl),
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            Text(title, style = HomeHubTheme.type.sectionTitle, color = c.ink, modifier = Modifier.semantics { heading() })
            content()
        }
    }
}

@Composable
fun Gap(h: Int = 12) = Spacer(Modifier.height(h.dp))

@Composable
fun CenteredColumn(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.widthIn(max = 520.dp).fillMaxWidth().padding(horizontal = 24.dp), content = content)
    }
}

@Composable
fun BoxScope.BottomActions(content: @Composable () -> Unit) {
    Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).imePadding().padding(24.dp)) { content() }
}

/**
 * Bar-button surface (back circle, action capsule). These sit above the content rather than over it,
 * so there is nothing to blur: an elevated, near-opaque surface with a hairline rim and soft shadow
 * — what iOS 26 Liquid Glass bar buttons look like over a plain background.
 */
@Composable
fun Modifier.barButton(shape: androidx.compose.ui.graphics.Shape): Modifier {
    val c = HomeHubTheme.colors
    return this.shadow(8.dp, shape, clip = false, ambientColor = c.glassShadow.copy(alpha = 0.10f), spotColor = c.glassShadow.copy(alpha = 0.16f))
        .clip(shape).background(c.surfaceElevated).border(0.5.dp, c.border.copy(alpha = 0.7f), shape)
}
