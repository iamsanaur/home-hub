# HomeHub AI — Product Design System
## Liquid Glass · Apple-inspired interaction quality · Impeccable design standards

**Project:** HomeHub AI  
**Android package:** `com.e404.homehub`  
**iOS bundle identifier:** `com.e404.homehub`  
**Platforms:** Native Android and native iOS only  
**Status:** Design source of truth for implementation  
**Audience:** Product designers, Flutter engineers, Claude Code agents and QA

---

## 0. Instructions for Claude Code

Treat this file as the authoritative visual and interaction specification for HomeHub AI. Read it before implementing or changing any screen.

If the `apple-design` and `impeccable` skills are available in the Claude Code environment, invoke and follow them before implementation. Do not claim to have invoked a skill that is not installed. If either skill is unavailable, follow the standards in this document and report that limitation.

Build two genuinely native applications: Android in Kotlin with Jetpack Compose, and iOS in Swift with SwiftUI. Do not use Flutter, React Native, Kotlin Multiplatform UI, a WebView-based app shell, or any cross-platform UI framework. Share product behaviour and backend contracts, not UI code. Both platforms must use the same HomeHub Liquid Glass visual language, including translucent layered surfaces, background sampling/blur, edge highlights, depth and fluid transitions. On iOS, use Apple's native Liquid Glass capabilities where supported by the deployment target. On Android, implement the equivalent Liquid Glass design language natively in Jetpack Compose using Compose graphics, RenderEffect/blur where supported, translucent adaptive surfaces, clipping, highlights and performant fallbacks. The Android implementation must visibly feel like Liquid Glass too; it must not fall back to a generic Material-only appearance. Do not pretend Apple's proprietary APIs exist on Android. Liquid Glass is an adaptive material language, not a blanket blur effect. Use it selectively for transient controls, floating navigation, sheets, overlays and contextual surfaces. Keep dense data, forms, tables, lists and reading surfaces solid and highly legible.

Before coding:
1. Inspect the existing app, assets, routes, dependencies and design tokens.
2. Identify platform-specific constraints and the actual Flutter version.
3. Build the shared design tokens and components before feature screens.
4. Implement representative screens at phone, tablet and desktop widths.
5. Validate contrast, text scaling, keyboard behaviour, safe areas, reduced motion and screen readers.
6. Do not use placeholder gradients, arbitrary icons, emoji as primary navigation icons, or generic dashboard-card grids as a substitute for considered design.

Do not invent Apple's proprietary APIs or imply that Flutter reproduces every native iOS Liquid Glass behaviour exactly. Use Flutter-native effects and platform adaptation responsibly.

---

# 1. Product design vision

HomeHub AI is a calm, intelligent household operating system. It should feel like a thoughtful home companion: reassuring, organised, capable and quietly premium.

### Design principles

1. **Calm over clutter** — reduce visual noise and surface only what matters now.
2. **Clarity over decoration** — every surface, colour and animation communicates hierarchy or state.
3. **Progressive disclosure** — show the next useful action first; reveal advanced controls when needed.
4. **Trust by design** — clearly distinguish suggestions, pending approvals, running actions and verified outcomes.
5. **Human control** — users can inspect, approve, pause, undo or cancel agent activity where appropriate.
6. **Warm precision** — combine a domestic, welcoming palette with precise typography and alignment.
7. **Native where it matters** — respect iOS and Android interaction patterns without fragmenting the product.
8. **Accessible by default** — design for different vision, motor, cognitive and language needs.
9. **Useful density** — make operational data scannable without turning every item into a card.
10. **Motion with purpose** — animation explains state changes and spatial relationships; it does not decorate.

### Brand personality

- Warm, composed, capable, discreet, optimistic.
- Never childish, overly futuristic, clinical or excessively gamified.
- AI should feel like a reliable household coordinator, not a robot mascot.

### Brand signature

**HomeHub AI**  
*Your Agentic Household Manager*

---

# 2. Visual identity

## 2.1 Colour system

Use semantic tokens, not hard-coded colours in feature widgets.

### Light theme

| Token | Value | Use |
|---|---:|---|
| `canvas` | `#F6F7F2` | Main app background |
| `surface` | `#FFFFFF` | Primary content surfaces |
| `surfaceSubtle` | `#EEF1E9` | Secondary grouped surface |
| `surfaceElevated` | `#FFFFFF` | Dialogs and elevated panels |
| `ink` | `#18231D` | Primary text |
| `inkSecondary` | `#536158` | Supporting text |
| `inkTertiary` | `#758078` | Metadata; verify contrast |
| `brand` | `#176B45` | Primary actions and brand |
| `brandStrong` | `#105638` | Pressed / high emphasis |
| `brandTint` | `#E1F0E6` | Selected / subtle brand surface |
| `sage` | `#A8BFA7` | Secondary brand accent |
| `gold` | `#D6A344` | Highlights and selected insights |
| `terracotta` | `#B9674E` | Warm accent, sparingly |
| `border` | `#DCE3DA` | Dividers and outlines |
| `success` | `#28764D` | Success state |
| `warning` | `#94600B` | Warning state |
| `danger` | `#B33B36` | Destructive / error state |
| `info` | `#356C9A` | Informational state |

### Dark theme

| Token | Value | Use |
|---|---:|---|
| `canvas` | `#101713` | Main background |
| `surface` | `#18221C` | Primary surfaces |
| `surfaceSubtle` | `#202D24` | Secondary surfaces |
| `surfaceElevated` | `#26352B` | Dialogs and elevated panels |
| `ink` | `#F1F5EF` | Primary text |
| `inkSecondary` | `#C0CCC2` | Supporting text |
| `inkTertiary` | `#9BA99E` | Metadata |
| `brand` | `#83C69A` | Primary actions |
| `brandStrong` | `#A2D8B1` | High emphasis |
| `brandTint` | `#233C2C` | Selected surface |
| `sage` | `#789B7D` | Secondary accent |
| `gold` | `#E4BB68` | Highlight |
| `terracotta` | `#D58B72` | Warm accent |
| `border` | `#344238` | Dividers |
| `success` | `#83C69A` | Success |
| `warning` | `#E4BB68` | Warning |
| `danger` | `#F08B83` | Error |
| `info` | `#8CB8E0` | Information |

Semantic status must never rely on colour alone. Pair colour with a label and/or icon. Validate actual text/background pairs against WCAG 2.2 AA; adjust tokens where necessary rather than assuming the table guarantees contrast.

## 2.2 Colour usage rules

- Emerald is the primary action colour, not a background for every section.
- Warm ivory belongs to light theme surfaces and brand moments.
- Gold is an accent, never a general warning substitute.
- Terracotta is rare and reserved for selected highlights.
- Use neutral surfaces for most data.
- Red is reserved for destructive, failed or urgent states.
- Avoid rainbow charts. Use a restrained, accessible categorical palette.
- Charts must include labels, legends and accessible summaries.

## 2.3 Typography

Use the platform system font by default:
- iOS: San Francisco through the system font.
- Android: Roboto / platform default.
- Web: system UI stack.

Do not bundle a font without a licensing and performance reason.

Suggested type scale:

| Style | Size | Weight | Line height |
|---|---:|---:|---:|
| Display | 32 | 700 | 1.15 |
| Screen title | 28 | 700 | 1.2 |
| Section title | 20 | 650 | 1.25 |
| Card title | 16 | 600 | 1.3 |
| Body | 16 | 400 | 1.5 |
| Body compact | 14 | 400 | 1.45 |
| Label | 13 | 600 | 1.3 |
| Caption | 12 | 500 | 1.35 |
| Numeric KPI | 28–36 | 700 | 1.1 |

Use tabular numerals for money, dates, quantities and metrics. Do not reduce body text below 14sp for essential information. Support dynamic text scaling without clipping.

---

# 3. Liquid Glass material language

## 3.1 Intent

Liquid Glass is used to create a sense of depth, translucency and continuity for controls that float above content. It should not compromise reading, accessibility, battery life or performance.

### Approved use cases

- Floating bottom navigation on mobile.
- Floating AI assistant entry point.
- Compact contextual toolbars.
- Transient action menus.
- Modal and bottom-sheet chrome.
- Media / image viewer controls.
- Selection toolbars.
- Small overlay controls over maps or visual content.

### Avoid glass for

- Long task lists.
- Financial tables and transaction histories.
- Forms and text inputs.
- Documents and long-form reading.
- Dense dashboards.
- Small text over variable imagery.
- Any surface that must remain highly legible in bright light or accessibility modes.

## 3.2 Glass recipe

Build a reusable `GlassSurface` component with configurable:
- Material strength: `subtle`, `regular`, `prominent`.
- Light/dark adaptation.
- Blur radius.
- Tint.
- Border/highlight.
- Elevation/shadow.
- Reduced-transparency fallback.
- Optional child clipping.

Suggested starting values (tune on physical devices):

| Property | Subtle | Regular | Prominent |
|---|---:|---:|---:|
| Backdrop blur | 8 px | 14 px | 20 px |
| Light tint opacity | 0.58 | 0.70 | 0.82 |
| Dark tint opacity | 0.48 | 0.62 | 0.76 |
| Border opacity | 0.22 | 0.30 | 0.38 |
| Corner radius | 18 | 22 | 26 |

These are design starting points, not platform API specifications. Ensure text is rendered on a sufficiently opaque inner surface when necessary.

### Glass appearance

- Use a subtle background tint, not a grey frosted slab.
- Add a fine 1px edge highlight.
- Use a restrained top-edge specular highlight if it improves depth.
- Keep shadows soft and physically plausible.
- Do not stack multiple blurred glass panels.
- Avoid intense rainbow, chrome, neon or liquid-metal effects.
- Keep blur regions small to avoid excessive GPU cost.
- Clip blur to rounded shapes and prevent bleed beyond bounds.

### Accessibility fallback

When reduced transparency is enabled, contrast is insufficient, or the device is under performance pressure:
- Replace glass with a solid adaptive surface.
- Preserve the same geometry and interaction.
- Keep all text and controls readable.
- Do not hide information behind translucency.

## 3.3 Flutter implementation guidance

Create:
- `GlassSurface`
- `GlassNavigationBar`
- `GlassToolbar`
- `GlassBottomSheet`
- `GlassFloatingActionButton`

For iOS, prefer the official SwiftUI and UIKit Liquid Glass APIs available in the app's deployment target; verify the exact APIs against current Apple documentation and availability annotations. Use native materials and vibrancy only where appropriate. For Android, implement the same recognisable Liquid Glass material language in Jetpack Compose: layered translucency, real background blur where supported, adaptive tint, thin specular borders, controlled highlights, depth and fluid motion. Use RenderEffect or other supported native rendering paths only after checking API availability and performance; provide a visually consistent translucent fallback on devices that cannot blur efficiently. Material 3 may inform interaction and accessibility behaviour, but must not replace the requested Liquid Glass visual direction. Avoid nested blur layers and unbounded backdrop filters. Do not create a fake cross-platform abstraction that hides important platform differences.

Do not apply blur to the entire screen. Profile on lower-end Android devices and older supported iPhones. Provide a no-blur fallback.

---

# 4. Layout, spacing and shape

Use an 8-point spacing system:

`4, 8, 12, 16, 20, 24, 32, 40, 48, 64`

### Shape tokens

| Component | Radius |
|---|---:|
| Small controls | 10 |
| Inputs | 12 |
| Cards | 18 |
| Large panels | 24 |
| Sheets | 28 |
| Pills | 999 |

Use a consistent 1px border on outlined surfaces. Avoid heavy shadows on every card.

### Responsive breakpoints

| Width | Layout |
|---|---|
| < 600 px | Phone: compact top bar and floating bottom navigation |
| 600–839 px | Large phone / compact tablet: adaptive navigation |
| 840–1199 px | Tablet: navigation rail + content |
| >= 1200 px | Desktop: sidebar + main content + optional contextual panel |

Use max content widths for reading and forms. Do not stretch narrow forms across a wide desktop screen.

### Safe areas

Respect:
- iOS safe areas and Dynamic Island.
- Android status/navigation bars.
- Keyboard insets.
- Foldable and split-screen layouts.
- Web browser viewport and scroll behaviour.

---

# 5. Navigation and information architecture

## Mobile primary navigation

Five destinations:

1. **Home** — household overview.
2. **Manage** — tasks, cleaning, shopping, meals, bills and maintenance.
3. **AI** — central HomeHub agent.
4. **Family** — members, assignments and calendar.
5. **Insights** — financial and operational reports.

Use a floating Liquid Glass navigation container where appropriate. Keep labels visible; do not rely on icons alone. Use clear selected states and accessible semantics.

## Secondary navigation

- Tasks
- Cleaning
- Shopping
- Pantry
- Meals
- Finance
- Bills
- Maintenance
- Inventory
- Calendar
- Documents
- Notes
- Reports
- Agent activity
- Settings

Use contextual sub-navigation, not an overcrowded bottom bar.

---

# 6. Core screen specifications

## 6.1 Onboarding

Goal: set up a household in a few short, understandable steps.

Sequence:
1. Welcome / value proposition.
2. Create account or sign in.
3. Create household.
4. Location, currency and timezone.
5. Add household members.
6. Set roles and permissions.
7. Optional budget and recurring bills.
8. Configure AI autonomy.
9. Finish with a useful dashboard.

Design rules:
- One primary action per screen.
- Show progress.
- Explain why optional data is requested.
- Allow skip and resume.
- Never ask for bank passwords or unnecessary sensitive data.
- Use friendly empty states and useful examples.

## 6.2 Home dashboard

Hierarchy:
1. Greeting, date and household switcher.
2. Concise “Today” summary.
3. One prominent next action.
4. Tasks due / overdue.
5. Bills and calendar alerts.
6. Shopping / pantry signal.
7. Budget snapshot.
8. Cleaning and maintenance progress.
9. Recent household activity.

Do not make every metric equally prominent. Use a single primary focus and a small number of supporting summaries. Let users customise dashboard sections.

## 6.3 Manage hub

Provide clear grouped entry points:
- Daily routines
- Shopping and pantry
- Food and meals
- Money and bills
- Home care
- Household records

Use compact list rows with icons, clear labels and optional counts. Avoid a wall of identical tiles.

## 6.4 AI command centre

The AI experience is a core product surface.

Required:
- Conversation list and new conversation.
- Streaming response.
- Composer with multiline input.
- Voice input affordance only when implemented.
- Suggested prompts.
- Context indicator showing active household.
- Agent workflow progress.
- Tool activity details.
- Approval cards.
- Cancel / stop action.
- Retry and error recovery.
- Compact usage disclosure in settings / diagnostics.

### AI response design

Differentiate:
- Advice / suggestion.
- Plan proposal.
- Awaiting approval.
- Executing.
- Completed and verified.
- Partially completed.
- Failed.
- Cancelled.

Use action cards with:
- Clear action title.
- Short rationale.
- Relevant parameters.
- Impact / cost when applicable.
- Approval button.
- Reject / edit controls.
- Execution status and timestamp.

Never present a plan as an executed action. Never claim a purchase, payment, booking or message was completed without a verified tool result.

## 6.5 Tasks

Use a clear segmented filter:
- Today
- Upcoming
- Assigned to me
- All

Task row:
- Completion control.
- Task title.
- Due date / time.
- Assignee.
- Priority indicator.
- Category.
- Overflow actions.

Use colour sparingly for priority. Support list and calendar views. Make recurring-task behaviour understandable.

## 6.6 Shopping and pantry

Shopping:
- Active list first.
- Category grouping.
- Quantity and unit.
- Estimated price.
- Purchased state.
- Add item affordance.
- Store / trip grouping when useful.

Pantry:
- Stock level.
- Minimum threshold.
- Expiry.
- Storage location.
- Last updated.

Low stock should be a clear actionable state, not an alarming banner.

## 6.7 Meal planning

- Weekly schedule with day and meal type.
- Recipe detail with ingredients and servings.
- Add-to-shopping-list action.
- Dietary and allergy indicators.
- Estimated cost only when based on available prices.
- Empty state with a helpful “Plan my week” action.

Never infer allergies or medical dietary requirements. Clearly distinguish user-entered dietary restrictions from AI suggestions.

## 6.8 Finance

Use solid surfaces for financial data.

Hierarchy:
1. Month selector.
2. Income / spending / remaining budget.
3. Budget progress.
4. Category breakdown.
5. Transaction list.
6. Add transaction action.

Use aligned tabular numbers. Show currency consistently. Charts must include accessible textual summaries and exact values on demand.

Avoid celebratory visuals for ordinary spending. Use neutral, factual language.

## 6.9 Bills

Each bill row:
- Provider / bill name.
- Amount.
- Due date.
- Recurrence.
- Payment status.
- Reminder state.

Clear states:
- Upcoming
- Due today
- Overdue
- Paid
- Needs attention

Payment is recorded only after user confirmation or verified payment-provider callback.

## 6.10 Maintenance and inventory

Maintenance list:
- Asset.
- Issue / service.
- Next due date.
- Status.
- Assigned person / provider.

Asset detail:
- Image.
- Purchase date.
- Warranty.
- Service history.
- Documents.
- Maintenance timeline.

## 6.11 Family and staff

- Member avatar / initials.
- Name and household role.
- Assigned responsibilities.
- Invitation status.
- Permission summary.

Use clear privacy boundaries. Staff should see only assigned work and information required to complete it. Private finance and family documents must remain inaccessible by default.

## 6.12 Calendar

Support:
- Agenda-first mobile view.
- Week / month views on larger screens.
- Event categories.
- Household member filters.
- Conflict indicators.
- Reminders.

Never use colour as the only event category indicator.

## 6.13 Documents

- Search and category filters.
- File type and date.
- Expiry date where relevant.
- Access indicator.
- Preview and download.
- Secure sharing only through explicit permissions.

## 6.14 Insights

Use a focused report landing page:
- Spending trends.
- Budget adherence.
- Task completion.
- Grocery spending.
- Maintenance spend.
- Pantry wastage.

Clearly label historical facts versus forecasts. Show the date range and source data behind each insight.

---

# 7. Interaction design

## Touch targets

- Aim for 44×44 pt on iOS and at least 48×48 dp on Android for primary controls.
- Keep adequate spacing between adjacent destructive and non-destructive actions.
- Make checkboxes and small icons easy to activate.

## Buttons

Three main styles:
- Primary filled.
- Secondary tonal / outlined.
- Tertiary text.

Every button must have:
- Default state.
- Pressed state.
- Disabled state.
- Loading state where asynchronous.
- Clear focus state.
- Accessible label.

Do not use multiple competing primary buttons in one viewport.

## Forms

- Persistent labels, not placeholder-only labels.
- Inline validation.
- Clear required / optional indication.
- Appropriate keyboard type.
- Input masking only when helpful.
- Preserve entered data after recoverable errors.
- Explain why a field is needed.

## Sheets and dialogs

Use sheets for contextual short actions and dialogs for important decisions. Avoid deeply nested dialogs. Include clear dismissal behaviour and preserve user input when appropriate.

## Undo

Provide undo for reversible actions such as task completion, list removal and archive operations. Use confirmation for destructive irreversible actions.

---

# 8. Motion and haptics

Motion should communicate hierarchy, feedback and spatial continuity.

Suggested motion durations:
- Micro interaction: 100–160 ms.
- Standard transition: 180–260 ms.
- Sheet transition: 250–350 ms.
- Complex workflow transition: 250–400 ms.

Use gentle easing. Avoid bounce-heavy motion, parallax overload and perpetual animations.

Use haptics sparingly:
- Successful completion.
- Important confirmation.
- Selection when platform conventions support it.

Respect reduced-motion settings. Every animation must have a static equivalent.

---

# 9. Icons and imagery

- Use a consistent icon family such as Lucide or Material Symbols, with a mapping layer.
- Use filled/outlined pairs only where the state difference is meaningful.
- Avoid mixing unrelated icon styles.
- Use illustrations only for empty states or onboarding where they add value.
- Use real user-supplied household images for assets.
- Never use decorative imagery that reduces the visibility of operational information.
- Provide semantic labels for icon-only controls.

---

# 10. Accessibility and internationalisation

Target WCAG 2.2 AA principles as a useful design benchmark, and meet Apple and Android native accessibility requirements in each app.

Required:
- Screen-reader labels and logical reading order.
- Dynamic type / text scaling.
- Sufficient contrast.
- Visible focus and keyboard navigation support where applicable in each native app.
- Keyboard-operable interactions where supported by the platform.
- Reduced motion.
- Reduced transparency fallback.
- Large text support.
- Localised date, time and currency formatting.
- RTL readiness.
- Hindi text expansion testing.
- Accessible charts and status announcements.

Do not encode meaning using colour alone. Do not truncate essential labels. Support long names and translated text.

---

# 11. AI trust and agent transparency

HomeHub is agentic, so the visual system must make autonomous behaviour understandable.

Each agent action should display:
- Which agent initiated it.
- Which household it affects.
- What it intends to do.
- Why it proposes the action.
- Whether it needs approval.
- What actually happened.
- Where the result can be inspected.

### Approval design

Approval screen must show:
- Exact action.
- Recipient / provider where applicable.
- Amount and currency if applicable.
- Relevant date.
- Data being shared.
- Consequences.
- Approve and reject controls.

Never hide important parameters behind an ambiguous “Continue” button.

Include a global pause for autonomous operations, with an accessible location in AI settings and a visible state when paused.

---

# 12. Design tokens and component library

Implement central tokens and reusable components.

### Required components

- `HomeHubScaffold`
- `HomeHubTopBar`
- `HomeHubNavigation`
- `GlassSurface`
- `GlassNavigationBar`
- `GlassToolbar`
- `HomeHubButton`
- `HomeHubIconButton`
- `HomeHubTextField`
- `HomeHubSearchField`
- `HomeHubCard`
- `HomeHubListTile`
- `StatusBadge`
- `PriorityIndicator`
- `ProgressIndicator`
- `EmptyState`
- `ErrorState`
- `LoadingSkeleton`
- `ApprovalCard`
- `AgentActivityTimeline`
- `AgentStatusIndicator`
- `BudgetSummary`
- `TaskRow`
- `BillRow`
- `GroceryItemRow`
- `MemberAvatar`
- `AdaptiveBottomSheet`
- `ConfirmationDialog`
- `Toast / Snackbar`

Components must support themes, responsive constraints, accessibility and loading / error states.

Do not duplicate component implementations across modules.

---

# 13. Design quality gates

Before considering any screen complete, verify:

### Visual
- Clear hierarchy.
- Consistent spacing.
- Consistent alignment.
- Intentional surface depth.
- Restrained use of Liquid Glass.
- No unnecessary card nesting.
- No arbitrary gradients.
- No emoji replacing meaningful icons.
- No decorative charts without data value.

### Functional
- Every visible action works.
- Loading and failure states exist.
- Empty states are helpful.
- Destructive actions are safe.
- Navigation is predictable.
- Forms preserve data on error.
- Agent states are accurate.

### Accessibility
- Contrast tested.
- Text scaling tested.
- Screen reader tested.
- Keyboard and switch-control tested on supported native platforms.
- Touch targets tested.
- Reduced motion tested.
- Reduced transparency tested.

### Performance
- No unbounded blur.
- No unnecessary rebuilds.
- Lists are virtualised where appropriate.
- Images are appropriately sized.
- Animations stay smooth on target devices.
- Low-end Android performance is tested.

### Platform
- iOS safe areas and native interaction conventions.
- Android system bars, back navigation and predictive back compatibility where supported.
- Native platform keyboard, accessibility navigation and system behaviour.
- Tablet and desktop adaptation.

---

# 14. Required design deliverables

Create and maintain:

1. `design.md` — this design source of truth.
2. `docs/design-tokens.md` — token definitions and semantic mappings.
3. `docs/component-inventory.md` — reusable component catalogue.
4. `docs/accessibility-checklist.md` — accessibility validation.
5. `docs/design-decisions.md` — significant design decisions and trade-offs.
6. Native SwiftUI theme and design-token implementation; native Jetpack Compose theme and design-token implementation.
7. Light and dark themes.
8. Liquid Glass component implementations and fallbacks.
9. Responsive navigation.
10. Representative polished screens for all primary modules.

---

# 15. Final direction

The finished HomeHub AI experience should combine:

- The material depth and adaptive restraint of Liquid Glass.
- The clarity and native interaction quality associated with Apple platform design.
- The typography, hierarchy, spacing and usability discipline expected from an exceptional digital product.
- The warmth and trust required for a household application.
- The transparency and control required for an agentic AI product.

Do not imitate an Apple app blindly. HomeHub must have its own identity and work equally well on Android and iOS.

**The design should feel premium because it is thoughtful, not because it is visually loud.**

Before finishing, provide screenshots at phone, tablet and desktop sizes, run the design quality gates, and document any remaining deviations from this specification.
