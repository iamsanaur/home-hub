# Design and architecture decisions

1. **Glass only on the functional layer.** Navigation, AI composer, floating actions and undo bars are glass; lists, finance, forms and sheets are solid (`design.md` §3, Apple HIG Materials). Android blur via RenderEffect (Haze) on API 31+ with an opaque-tint fallback; iOS uses the system `TabView` and `glassEffect` instead of a hand-rolled bar.
2. **inkTertiary darkened** to #66716A: the specified #758078 measures 3.81:1 on canvas (fails AA for body-size text).
3. **Grouped lists, not card walls**: rows share one surface with hairline dividers; cards only for summaries.
4. **One primary action per view**: the dashboard's "Today" card carries the only filled button.
5. **Two agent runtimes (user decision, 16 Nov 2026)**: Hermes Mobile runs the loop on the phone for app requests (user asked for Hermes on the phone, with battery care); the Gateway remains orchestrator and policy authority and runs server Hermes for scheduled jobs (after a 6 h device grace window) and, later, Alexa/channels. Resolves the conflict with addendum §7 ("apps are not agent runtimes").
6. **Hermes is ported, not embedded**: the Python runtime (~100k lines, 2.6 GB) cannot ship in an iOS app and would cost battery on Android; the port keeps Hermes' concepts and skill format.
7. **Grant hidden from the model on device**: instructions omit it; the runtime injects it into tool calls, so injected content can't exfiltrate it.
8. **Deterministic first**: routing, briefings, shopping-list generation, budgets and simple voice-style commands never call a model.
9. **Addendum deferred**: finish the current apps first (user decision), then Phase 1 Gateway/plugins and Alexa.
