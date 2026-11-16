# Design tokens

Source of truth: `design.md` §2–4. Implementations: Android `ui/theme/Tokens.kt` + `Type.kt`; iOS `Design/Tokens.swift`. Values are identical on both platforms.

## Colour (WCAG 2.2 contrast, measured)
| Token | Light | on canvas | on surface | Dark | on canvas | on surface |
|---|---|---:|---:|---|---:|---:|
| ink | #18231D | 15.04 | 16.19 | #F1F5EF | 16.51 | 14.83 |
| inkSecondary | #536158 | 6.06 | 6.52 | #C0CCC2 | 10.97 | 9.85 |
| inkTertiary | **#66716A** (design.md #758078 = 3.81 ✗) | 4.72 | 5.08 | #9BA99E | 7.42 | 6.67 |
| brand | #176B45 | 6.05 | 6.51 | #83C69A | 9.11 | 8.18 |
| danger | #B33B36 | 5.42 | 5.84 | #F08B83 | 7.56 | 6.79 |
| warning | #94600B | 4.95 | 5.33 | #E4BB68 | 10.06 | 9.04 |
| success | #28764D | 5.15 | 5.54 | #83C69A | 9.11 | 8.18 |
| info | #356C9A | 5.18 | 5.58 | #8CB8E0 | 8.71 | 7.82 |

On-brand text: white on #176B45 = 6.51; #0C2416 on dark brand #83C69A = 8.21 (dark mode uses dark text on the lighter brand fill).
Other tokens (canvas, surface, surfaceSubtle, surfaceElevated, brandStrong, brandTint, sage, gold, terracotta, border) follow `design.md` unchanged. Status is always label + icon + colour.

## Type
System fonts (Roboto / SF). Android sizes in sp from `design.md` §2.3; iOS uses Dynamic Type text styles mapped to the same hierarchy. Money/quantities use tabular numerals (`tnum` / `.monospacedDigit()`).

## Spacing & shape
8-point scale 4–64. Radii: control 10, input 12, card 18, panel 24, sheet 28, pill 999.

## Glass
| Strength | Blur (Android, dp×2) | Light tint | Dark tint | Rim | Radius |
|---|---:|---:|---:|---:|---:|
| Subtle | 8 | 0.58 | 0.48 | 0.22 | 18 |
| Regular | 14 | 0.70 | 0.62 | 0.30 | 22 |
| Prominent | 20 | 0.82 | 0.76 | 0.38 | 26 |
iOS uses Apple's `Glass.regular` (system-tuned); the table applies to Android only. Fallbacks: Android API < 31 or low-RAM → tint 0.94 without blur; high-contrast text → solid `surfaceElevated` + border. iOS Reduce Transparency → solid surface + border; Increase Contrast → border.
