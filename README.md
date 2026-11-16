<div align="center">

<img src="docs/images/icon.png" width="112" alt="HomeHub AI" />

# HomeHub AI

### Your Agentic Household Manager

Tasks, groceries, bills, meals, maintenance and family — run by an assistant that **does the work**
and **asks before it spends, books or sends**.

<br/>

[![Download APK](https://img.shields.io/github/v/release/iamsanaur/home-hub?style=for-the-badge&label=Download%20APK&color=176B45&logo=android&logoColor=white)](https://github.com/iamsanaur/home-hub/releases/latest)
![Android](https://img.shields.io/badge/Android-Kotlin%20%C2%B7%20Jetpack%20Compose-176B45?style=for-the-badge&logo=android&logoColor=white)
![iOS](https://img.shields.io/badge/iOS-Swift%20%C2%B7%20SwiftUI-18231D?style=for-the-badge&logo=apple&logoColor=white)
![Firebase](https://img.shields.io/badge/Firebase-Firestore%20%C2%B7%20Functions-D6A344?style=for-the-badge&logo=firebase&logoColor=white)
![Hermes](https://img.shields.io/badge/Agent-Hermes%20v0.21.2-B9674E?style=for-the-badge)

![Tools](https://img.shields.io/badge/assistant%20tools-76-A8BFA7?style=flat-square)
![Skills](https://img.shields.io/badge/skills-8-A8BFA7?style=flat-square)
![Backend tests](https://img.shields.io/badge/backend%20tests-207%20passing-176B45?style=flat-square)
![Native](https://img.shields.io/badge/100%25-native%20%C2%B7%20no%20web%20views-176B45?style=flat-square)
![Money](https://img.shields.io/badge/money-integer%20minor%20units-176B45?style=flat-square)

<br/>

<img src="docs/images/ipad-home.png" width="62%" alt="HomeHub on iPad: today's priorities, bills, calendar, pantry and budget" />

<br/><br/>

<img src="docs/images/ai-prompts.png" width="23%" alt="Assistant with suggested prompts" />&nbsp;
<img src="docs/images/ai-tools.png" width="23%" alt="Assistant answering with visible tool activity" />&nbsp;
<img src="docs/images/insights.png" width="23%" alt="Insights: spending by category and task completion" />&nbsp;
<img src="docs/images/devices.png" width="23%" alt="Devices by room with Alexa exposure" />

<sub>The iOS app on iPad and iPhone, with a demo household. Android is built to match it screen for screen.</sub>

</div>

<br/>

---

## Why it exists

Running a home is a hundred small decisions — what's low in the pantry, which bill is due, who's doing the
bins, whether the milkman came. HomeHub keeps all of it in one place and puts an assistant on top that can
actually *act*: add the groceries, plan the week, record that the milk wasn't delivered on the 3rd, set a
reminder — while **purchases, payments, bookings, external messages and deletions always wait for a person's approval.**

> *"Ramesh the milk vendor didn't come on the 3rd and 4th, and then he was away from the 9th till the 11th.
> Also on the 14th we got 2 liters."*
> → the month's bill is recalculated, to the paisa, from what was actually delivered.

## What you get

<table>
<tr>
<td width="50%" valign="top">

**🏠 Run the house**
- **Tasks** — assign, recur, checklist, comment
- **Cleaning** — room-wise routines, deep cleans
- **Shopping** — multiple lists, price estimates
- **Pantry** — stock, expiry, waste, **bulk paste-in**
- **Meals** — weekly plan, recipes, one-tap grocery list
- **Calendar** — events, conflicts, reminders
- **Maintenance & assets** — warranties, service dates
- **Notes & documents** — private or shared, restricted records

</td>
<td width="50%" valign="top">

**💰 Know the money**
- **Finance** — income, expenses, budgets, savings goals
- **Bills** — fixed *or* **pay-per-delivery** (milk, newspaper, maid, tiffin) with a month ledger
- **Automatic spending capture** — Android notifications, iOS Shortcuts
- **Reports** — spending, budgets, tasks, wastage, agent usage
- Exact arithmetic: **integer minor units, never floats**
- HomeHub **never moves money**

</td>
</tr>
<tr>
<td width="50%" valign="top">

**🤖 An assistant that earns trust**
- Plans the week, prepares for guests, watches the budget
- **76 narrowly-scoped tools**, no shell, no raw database
- **Approvals** for anything that spends, books, sends or deletes
- **Four autonomy modes** + an emergency pause
- Every action **audited and verified** against the data
- Works **on the phone** (Hermes Mobile) and on a server

</td>
<td width="50%" valign="top">

**🔌 Connected home**
- **Devices** — lights, plugs, AC, locks (read-back verified)
- **Automations** — when this happens, do that
- **Home Assistant** bridge · **Alexa** (OAuth + PKCE)
- **Telegram** bot · **Google Calendar** (read-only)
- **Plugin SDK** with manifests, scopes and a certification checklist
- **Roles** — owner, admin, adult, child, staff

</td>
</tr>
</table>

## Liquid Glass, on both platforms

A single visual language — translucent, layered, softly lit — implemented **natively** each way:

| | iOS | Android |
|---|---|---|
| **Material** | Apple's native Liquid Glass (`glassEffect`, system tab bar) on iOS 26+ | Real backdrop blur via `RenderEffect` (API 31+), tinted translucent fallback below |
| **Accessibility** | Reduce Transparency → solid surfaces | High-contrast → solid surfaces |
| **Restraint** | Glass on floating nav, composer, toolbars and sheets — **never** on dense lists, forms or documents | same |
| **Tokens** | Emerald `#176B45` · Sage `#A8BFA7` · Ivory `#F6F7F2` · Charcoal `#18231D` · Gold `#D6A344` · Terracotta `#B9674E` | same |

No Flutter, no React Native, no WebViews. Two native apps, one brand, one set of contracts.

---

## How it fits together

```mermaid
flowchart LR
    subgraph Phones["Native apps"]
        A["Android<br/>Kotlin · Compose · Room"]
        I["iOS<br/>Swift · SwiftUI · SwiftData"]
        HM["Hermes Mobile<br/>on-device agent loop"]
    end
    subgraph Firebase["Firebase"]
        AU["Auth + App Check"]
        FS[("Firestore<br/>+ security rules")]
        FN["Cloud Functions<br/>gateway · scheduler"]
        MCP["HomeHub MCP server<br/>76 scoped tools"]
    end
    subgraph Agent["Agent runtime"]
        HS["Hermes (server)<br/>Docker · pinned v0.21.2"]
        LLM["Model provider<br/>configurable · tiered"]
    end
    A & I --> AU
    A & I <--> FS
    A & I --> FN
    HM --> MCP
    FN --> HS --> MCP
    MCP --> FS
    HS --> LLM
    FN -. model proxy .-> LLM
```

- **Apps never talk to the agent directly.** They go through the gateway, which checks the Firebase token, household membership, role, action scope, autonomy policy and approval state.
- **Tools never accept a household id.** The household comes from a per-run, server-minted grant, so cross-household access is impossible by construction.
- **Hermes is the runtime, not the database.** Firestore is the source of truth; the assistant reads and writes through tools.
- **The apps keep working without the assistant.** Every ordinary feature is deterministic and offline-first.

### Safe by design

| Principle | How |
|---|---|
| **Approval, enforced on the server** | Purchases, payments, bookings, external messages, sharing and deletions become approval requests — a model can't skip them, and the UI isn't the only gate |
| **Least privilege** | Firestore + Storage rules deny by default; roles enforced in rules *and* functions; staff see only assigned work |
| **Untrusted input stays untrusted** | Documents, messages and calendar text are data and can't change tools, permissions or policy |
| **Verified, not claimed** | Device changes are read back; writes are re-checked in Firestore before the assistant says "done" |
| **Privacy** | Private notes and memory stay private; export and delete flows; secrets only in Secret Manager |
| **Money** | Integer minor units end to end; reconciled records are locked; conflicts are surfaced, never silently overwritten |

### Token-efficient on purpose

Deterministic router picks the skill and model tier · compact household context, never the whole database · skills load on demand ·
no LLM for arithmetic, dates or CRUD · bounded retries and per-workflow budgets · a usage ledger records tokens, cost and
success per workflow — so savings are *measured*, not claimed.

---

## Repository map

```
android/            Kotlin + Compose app (com.e404.homehub) — Room outbox, WorkManager, Hermes Mobile
ios/                SwiftUI app (com.e404.homehub) — SwiftData outbox, BGTasks, Hermes Mobile · XcodeGen
backend/firebase/   Firestore + Storage rules, indexes, Cloud Functions (gateway, MCP, scheduler, plugins)
agents/hermes/      Orchestrator profile, SOUL.md, 8 on-demand skills, Docker stack
shared/schemas/     JSON Schemas generated from the server's zod contracts
docs/               Architecture, security, setup, plugin SDK, certification, design system
scripts/            Dev environment, deploy, Hermes-in-Docker, plugin manifest validator
tests/evidence/     Screenshots captured from emulators and simulators
```

<details>
<summary><b>The eight skills</b></summary>

`household-manager` · `finance-manager` · `smart-shopping` · `meal-planner` · `home-maintenance` ·
`family-coordinator` · `household-reports` · `approval-manager` — each a `SKILL.md` with purpose, activation
criteria, allowed tools, prohibited actions, workflow, output format, verification and error handling.
A test fails if a skill names a tool that doesn't exist or any tool is unreachable from every skill.
</details>

<details>
<summary><b>Assistant tools, by area</b></summary>

| Area | Tools |
|---|---|
| Household | `get_household_summary` · `get_household_members` · `get_member_permissions` · `list_memories` · `remember_preference` · `forget_memory` |
| Tasks | `list_tasks` · `create_task` · `update_task` · `complete_task` · `assign_task` · `list_task_comments` · `add_task_comment` |
| Shopping & pantry | `list_shopping_lists` · `get_shopping_list` · `create_shopping_list` · `add_shopping_item` · `update_shopping_item` · `remove_shopping_item` · `mark_item_purchased` · `get_inventory` · `get_low_stock_items` · `add_pantry_items` · `adjust_pantry` |
| Meals | `get_meal_plan` · `create_meal_plan` · `generate_meal_shopping_list` · `list_recipes` · `create_recipe` |
| Money | `get_budget_summary` · `list_expenses` · `record_expense` · `record_income` · `set_budget` · `list_savings_goals` · `create_savings_goal` · `add_to_savings_goal` |
| Bills | `get_bill_status` · `list_bills` · `create_bill` · `update_bill` · `create_vendor_bill` · `update_vendor_bill` · `record_deliveries` · `get_bill_ledger` · `record_bill_payment`* |
| Home | `list_maintenance_records` · `create_maintenance_request` · `schedule_service_reminder` · `list_assets` · `create_asset` · `list_cleaning` · `create_cleaning_routine` · `mark_cleaned` · `list_notes` · `create_note` · `list_documents` |
| Calendar | `list_events` · `create_event` · `update_event` · `cancel_event` · `check_schedule_conflicts` |
| Devices & services | `list_devices` · `control_device` · `list_automations` · `set_automation_enabled` · `create_automation`* · `list_integrations` · `call_integration_tool` |
| People | `invite_member`* · `change_member_role`* |
| Approvals & reports | `request_approval` · `list_pending_approvals` · `get_approval_status` · `get_household_report` · `get_agent_usage_report` |

<sub>* always held for a person's approval; the action runs as the approving person.</sub>
</details>

---

## Download

**Android:** grab the signed APK from the [latest release](https://github.com/iamsanaur/home-hub/releases/latest)
(Android 8.0+; Play Protect may warn because it isn't on Google Play yet — verify the SHA-256 shown on the release).
**iOS:** build from source for now; a signed build needs an Apple developer team. See the [changelog](CHANGELOG.md).

## Run it locally — no credentials needed

```bash
# 1. Backend + emulators
source scripts/dev-env.sh
cd backend/firebase/functions && npm ci && npm run build
cd .. && firebase emulators:start --project demo-homehub

# 2. Sample household (owner@homehub.test · password homehub-demo-1)
cd functions && FIRESTORE_EMULATOR_HOST=127.0.0.1:8181 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
  GCLOUD_PROJECT=demo-homehub node lib/scripts/seed.js

# 3. Android            4. iOS
cd android && ./gradlew :app:installDebug
cd ios && xcodegen generate && open HomeHub.xcodeproj
```

**Prerequisites:** Node ≥ 22.12 · Firebase CLI · JDK 21+ · Android SDK 37 · Xcode with iOS 26+ simulators · `xcodegen`.
**Optional:** Hermes Agent v0.21.2 for the server runtime (`scripts/hermes-docker.sh`). Without a model provider, deterministic
commands and every non-AI feature still work.

> **Bring your own Firebase.** `google-services.json`, `GoogleService-Info.plist`, release keystores and `.env` files are
> deliberately **not** in this repo. Copy `.env.example`, create a Firebase project, and see
> [`docs/firebase-setup.md`](docs/firebase-setup.md) and [`docs/deployment.md`](docs/deployment.md).

### Tests

```bash
cd backend/firebase/functions
npx vitest run test/unit            # 83 unit tests
npm run test:emulator               # 124 rules + integration tests on the emulators
cd android && ./gradlew :app:testDebugUnitTest
cd ios && xcodebuild test -scheme HomeHub -destination 'platform=iOS Simulator,name=iPhone 17'
```

Cross-household isolation, role limits, approval gating, idempotency, offline sync policy, the milk-vendor maths and
every assistant tool have automated tests.

---

## Where it stands

**Working and tested:** both native apps, the Firebase backend and rules, the MCP tool server, approvals and autonomy,
vendor/metered bills, offline sync, Hermes Mobile, server Hermes in Docker, spending capture, Home Assistant, Telegram,
read-only Google Calendar, the plugin SDK.

**Honest gaps** — see [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) for the full, dated list:
- iOS push needs an APNs key; App Check is implemented but not yet enforced in production.
- Alexa account linking is built and awaiting Amazon developer credentials and certification.
- The iOS release build needs an Apple developer team; there is no Play Store listing yet.
- The assistant's newest tools are covered by automated tests but have not yet been exercised against the live model.
- Partner-gated integrations (grocery delivery, bank data) are listed as *Planned*, not built.

## Docs

[Architecture](docs/architecture.md) · [Security](docs/security.md) · [Firebase setup](docs/firebase-setup.md) ·
[Hermes setup](docs/hermes-setup.md) · [Deployment](docs/deployment.md) · [Alexa](docs/alexa.md) ·
[Plugin SDK](docs/plugin-sdk.md) · [Plugin certification](docs/plugin-certification.md) ·
[Design tokens](docs/design-tokens.md) · [Accessibility checklist](docs/accessibility-checklist.md)

## Licence

No open-source licence has been granted yet, so all rights are reserved by default. Open an issue if you'd like to use or
contribute to HomeHub.

<div align="center">
<br/>

**HomeHub AI** · built with care for the people who actually run the home

</div>
