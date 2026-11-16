package com.e404.homehub.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.runtime.remember
import com.e404.homehub.ui.theme.GlassStrength
import com.e404.homehub.ui.theme.HomeHubTheme
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.HazeStyle
import dev.chrisbanes.haze.HazeTint
import dev.chrisbanes.haze.hazeEffect

/**
 * The backdrop the glass layer samples. Provided once by HomeHubScaffold around the
 * content layer (Modifier.hazeSource). Null → no blur source → solid fallback.
 */
val LocalGlassBackdrop = staticCompositionLocalOf<HazeState?> { null }

/**
 * HomeHub Liquid Glass for Android (design.md §3). Functional layer only.
 *
 * - API 31+: real backdrop blur via RenderEffect (Haze), adaptive tint, 1dp specular
 *   rim that fades top→bottom, a restrained top-edge sheen and a soft offset shadow.
 * - API 26–30 or low-RAM devices: no blur; the tint becomes near-opaque so text stays legible.
 * - Reduce transparency (high-contrast text): fully solid surface, same geometry.
 * Blur is always clipped to the shape, so it never bleeds.
 */
@Composable
fun Modifier.glass(
    strength: GlassStrength = GlassStrength.Regular,
    shape: Shape = RoundedCornerShape(strength.radius.dp),
    elevation: Dp = 12.dp,
): Modifier {
    val c = HomeHubTheme.colors
    val a11y = HomeHubTheme.a11y
    val backdrop = LocalGlassBackdrop.current
    val shadowed = this.shadow(elevation, shape, clip = false, ambientColor = c.glassShadow.copy(alpha = 0.10f), spotColor = c.glassShadow.copy(alpha = 0.18f))
    if (a11y.reduceTransparency || backdrop == null) {
        return shadowed.clip(shape).background(c.surfaceElevated).border(1.dp, c.border, shape)
    }
    val tintAlpha = when {
        !a11y.blurSupported -> 0.94f
        c.isDark -> strength.darkTint
        else -> strength.lightTint
    }
    val rimTop = c.glassHighlight.copy(alpha = if (c.isDark) strength.border * 0.75f else strength.border + 0.35f)
    val rimBottom = c.glassHighlight.copy(alpha = if (c.isDark) 0.04f else 0.10f)
    return shadowed
        .clip(shape)
        .hazeEffect(backdrop) {
            style = HazeStyle(
                backgroundColor = c.canvas,
                tint = HazeTint(c.glassTint.copy(alpha = tintAlpha)),
                blurRadius = (strength.blur * 2).dp,
                noiseFactor = 0.03f,
            )
        }
        // Top-edge specular sheen: a very short vertical highlight, not a gradient fill.
        .drawWithContent {
            drawContent()
            drawRect(
                brush = Brush.verticalGradient(
                    0f to c.glassHighlight.copy(alpha = if (c.isDark) 0.07f else 0.22f),
                    0.18f to Color.Transparent,
                ),
                size = size,
            )
        }
        .border(1.dp, Brush.verticalGradient(listOf(rimTop, rimBottom)), shape)
}

@Composable
fun GlassSurface(
    modifier: Modifier = Modifier,
    strength: GlassStrength = GlassStrength.Regular,
    shape: Shape = RoundedCornerShape(strength.radius.dp),
    content: @Composable BoxScope.() -> Unit,
) {
    Box(modifier.glass(strength, shape), content = content)
}

data class NavDestination(val route: String, val label: String, val icon: ImageVector, val selectedIcon: ImageVector)

/** Floating Liquid Glass navigation for compact widths. Labels always visible (design.md §5). */
@Composable
fun GlassNavigationBar(
    destinations: List<NavDestination>,
    selectedRoute: String?,
    onSelect: (NavDestination) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    GlassSurface(
        modifier = modifier.widthIn(max = 520.dp).fillMaxWidth(),
        strength = GlassStrength.Regular,
        shape = RoundedCornerShape(50),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp).selectableGroup(),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            destinations.forEach { d ->
                val selected = d.route == selectedRoute
                val pill by animateColorAsState(
                    // Neutral selection pill like the iOS 26 tab bar; the tint lives in the icon and label.
                    if (selected) c.ink.copy(alpha = if (c.isDark) 0.14f else 0.07f) else Color.Transparent,
                    animationSpec = tween(if (HomeHubTheme.a11y.reduceMotion) 0 else 180), label = "navPill",
                )
                Column(
                    Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(50))
                        .background(pill)
                        .selectable(selected = selected, role = Role.Tab, interactionSource = remember { MutableInteractionSource() }, indication = ripple(), onClick = { onSelect(d) })
                        .defaultMinSize(minHeight = 56.dp)
                        .padding(vertical = 5.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Icon(if (selected) d.selectedIcon else d.icon, contentDescription = null, tint = if (selected) c.brand else c.ink, modifier = Modifier.size(28.dp))
                    Text(d.label, style = t.caption.copy(fontSize = 11.sp, fontWeight = FontWeight.Medium), color = if (selected) c.brand else c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

/** Compact contextual glass toolbar (selection actions, AI controls). */
@Composable
fun GlassToolbar(modifier: Modifier = Modifier, content: @Composable RowScope.() -> Unit) {
    GlassSurface(modifier = modifier, strength = GlassStrength.Subtle, shape = RoundedCornerShape(24.dp)) {
        Row(Modifier.padding(horizontal = 8.dp).height(52.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp), content = content)
    }
}

/** Floating glass action button — the AI entry point and similar single primary actions. */
@Composable
fun GlassFloatingActionButton(icon: ImageVector, label: String, onClick: () -> Unit, modifier: Modifier = Modifier, prominent: Boolean = true) {
    val c = HomeHubTheme.colors
    Box(
        modifier
            .size(56.dp)
            .glass(GlassStrength.Prominent, CircleShape, elevation = 14.dp)
            .then(if (prominent) Modifier.background(c.brand.copy(alpha = 0.90f)) else Modifier)
            .selectable(selected = false, role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = label, tint = if (prominent) c.onBrand else c.ink)
    }
}

/** Utility for previews/tests: draws a faint colour field so glass has something to sample. */
fun Modifier.glassPreviewBackdrop(color: Color) = drawWithContent {
    drawContent()
    drawCircle(color.copy(alpha = 0.35f), radius = size.minDimension / 2, center = Offset(size.width * 0.2f, size.height * 0.3f))
}
