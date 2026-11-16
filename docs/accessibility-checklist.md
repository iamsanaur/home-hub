# Accessibility checklist

| Check | Android | iOS | Evidence / status |
|---|---|---|---|
| Contrast ≥ 4.5:1 text | tokens measured | same tokens | `design-tokens.md` ✔ |
| Text scaling | sp units, wrapping rows (`FlowRow`) | Dynamic Type styles | Implemented; large-size screenshots **not yet captured** |
| Screen reader labels | icon buttons have `contentDescription`; toggles expose state; live regions on errors/agent text | `accessibilityLabel/Value`, header traits | Implemented; TalkBack/VoiceOver pass **not yet run** |
| Touch targets | ≥48dp (buttons, icons, checkboxes 56dp) | ≥44pt | ✔ by construction |
| Colour not sole signal | badges include text + icon | same | ✔ |
| Reduce motion | animation scale 0 → no transitions/shimmer | `accessibilityReduceMotion` → static skeleton | ✔ |
| Reduce transparency | high-contrast text → solid glass | Reduce Transparency → solid | ✔ |
| Keyboard/focus | Material focus indication | system | Not specifically tested |
| RTL / Hindi expansion | start/end layout, wrapping | leading/trailing | No translations yet |
| Charts | text values + accessible summaries (no colour-only charts) | same | ✔ |
