# HOMEHUB AI — MASTER IMPLEMENTATION PROMPT
## Native Android + Native iOS · Liquid Glass on Both · Firebase Backend · Hermes Agent Ecosystem

You are Claude Code acting as a principal product architect, senior native Android engineer, senior native iOS engineer, Firebase backend engineer, AI agent engineer, security engineer, QA lead and DevOps engineer.

Build **HomeHub AI**, a production-oriented, agentic household management system. Work directly in the repository. Inspect existing code and assets before changing anything. Do not stop after producing a plan or static mockups: implement, test, document and report actual progress.

## Source-of-truth files

1. **`design.md` is the authoritative visual and interaction design specification.**
   - Read it completely before implementing or changing UI.
   - Follow its Liquid Glass design system, colours, typography, spacing, screen specifications, component catalogue, accessibility rules, motion principles and quality gates.
   - Do not duplicate or casually contradict it in code comments or other documentation.
2. This master prompt is the authoritative technical architecture and product implementation brief.
3. If `apple-design` and `impeccable` skills are installed in the Claude Code environment, invoke and follow them before design implementation. Do not claim to have used a skill that is unavailable. If unavailable, follow `design.md` and report the limitation.

---

# 1. NON-NEGOTIABLE PRODUCT AND PLATFORM DECISIONS

**Product:** HomeHub AI  
**Android application ID / package:** `com.e404.homehub`  
**iOS bundle identifier:** `com.e404.homehub`  
**Platforms:** Native Android and native iOS only  
**Backend:** Firebase  
**Agent runtime:** Hermes Agent by Nous Research  
**AI integration:** Custom HomeHub API gateway and MCP server

Absolutely do not use:
- Flutter or Dart
- React Native or Expo
- Kotlin Multiplatform UI
- Ionic or Capacitor
- WebView-based application shells
- A web app packaged as a mobile app
- Supabase or Supabase client libraries

Build two independent native clients with shared product behaviour and backend contracts, not shared UI code. There is no web application in this scope.

## Native Android stack
- Kotlin
- Jetpack Compose
- AndroidX architecture components
- ViewModel + StateFlow / Kotlin Flow
- Kotlin coroutines
- Navigation Compose
- Room for local persistence and offline queue
- WorkManager for deferrable background work
- Android Keystore for sensitive local secrets
- Firebase Android SDKs
- Firebase Cloud Messaging
- Native Android lifecycle, system back, edge-to-edge and accessibility support

## Native iOS stack
- Swift
- SwiftUI, with UIKit interoperability only where necessary
- MVVM or a clearly documented native architecture
- Swift concurrency / async-await
- NavigationStack and native navigation patterns
- SwiftData or Core Data for local persistence and sync requirements
- Keychain for sensitive local secrets
- Firebase Apple SDKs / Firebase iOS SDK
- Firebase Cloud Messaging through APNs
- UserNotifications
- BGTaskScheduler where appropriate and permitted
- Native accessibility and lifecycle support

## Firebase backend
Use Firebase as the primary backend:
- Firebase Authentication
- Cloud Firestore
- Cloud Storage for Firebase
- Cloud Functions for Firebase (2nd generation where appropriate)
- Firebase Cloud Messaging
- Firebase App Check
- Firebase Remote Config where useful
- Firebase Crashlytics
- Firebase Analytics only with appropriate privacy controls and consent
- Firebase Performance Monitoring where useful
- Firebase Emulator Suite for local development and automated tests

Use Firestore as the operational database. Design document paths, indexes, transactions, batched writes, pagination and security rules carefully. Do not assume Firestore behaves like a relational SQL database. Model relationships and queries for Firestore's access patterns. Use Cloud Functions for trusted server-side operations and privileged integrations.

Do not add Supabase anywhere in the implementation.

## Hermes runtime
Run Hermes Agent as a separate secured backend runtime. Firebase is the application's primary identity, data, storage, notification and serverless platform. Hermes is the agent runtime, not the database or authentication provider.

The native apps must never connect directly to an unrestricted Hermes runtime. They communicate with a secured HomeHub API gateway / Cloud Functions interface. The gateway verifies Firebase ID tokens, household membership, roles, action permissions and approval policies before any agent tool can run.

---

# 2. LIQUID GLASS — REQUIRED ON BOTH PLATFORMS

Liquid Glass is the defining visual language of HomeHub AI on **both iOS and Android**. This is not optional and must not be reduced to an iOS-only treatment.

Read and follow `design.md`.

## iOS implementation
- Use Apple's native Liquid Glass APIs when supported by the chosen deployment target.
- Verify API names, availability annotations and behaviour against current Apple documentation.
- Use native SwiftUI / UIKit materials and platform conventions.
- Provide a coherent fallback for older supported iOS versions.

## Android implementation
Implement the same recognisable Liquid Glass visual language natively using Kotlin and Jetpack Compose.

Required visual characteristics:
- Translucent layered surfaces
- Real backdrop blur where supported and performant
- Adaptive light/dark tint
- Fine specular edge highlights
- Soft depth and physically plausible shadows
- Controlled transparency and background sampling
- Fluid transitions and subtle material movement
- Rounded, clipped surfaces with no blur bleed
- Floating navigation and contextual glass controls

Use native Compose drawing and rendering paths. Consider supported Android rendering APIs such as RenderEffect only after verifying API availability and device performance. Provide a visually consistent translucent fallback for devices that cannot efficiently blur.

Material 3 may guide Android interaction conventions and accessibility, but must not replace the requested Liquid Glass visual direction. Android must visibly look like HomeHub Liquid Glass too. Do not pretend Apple's proprietary APIs exist on Android.

## Glass restraint
Use glass for:
- Floating navigation
- AI assistant controls
- Toolbars
- Contextual menus
- Sheets and overlays
- Small controls above visual content

Do not use glass for:
- Dense transaction tables
- Long task lists
- Forms and text entry
- Documents and reading surfaces
- Dense dashboards

Provide reduced-transparency and reduced-motion fallbacks. Avoid nested or unbounded blur. Profile on real, lower-end Android hardware. Preserve readability and contrast.

The two platforms must share the same brand, visual material language, semantic tokens and information architecture while retaining native interaction patterns.

---

# 3. BRAND AND DESIGN

Brand: **HomeHub AI**  
Tagline: **Your Agentic Household Manager**

Use `design.md` as the detailed and authoritative visual specification.

Core palette:
- Emerald `#176B45`
- Sage `#A8BFA7`
- Warm ivory `#F6F7F2`
- Charcoal `#18231D`
- Muted gold `#D6A344`
- Terracotta `#B9674E`

Create native light and dark themes. Use platform system typography and accessible dynamic text. Maintain a consistent 8-point spacing system, restrained shadows, clear hierarchy, generous whitespace and purposeful motion.

Use the supplied HomeHub icon if present in `assets/branding/`. Generate native Android adaptive icon assets, iOS AppIcon assets and splash-screen assets from the supplied source. Do not replace approved branding with a generic icon.

Create reusable native components and platform-specific design tokens. Follow all screen, accessibility, glass, interaction and QA requirements in `design.md`.

---

# 4. PRODUCT SCOPE

Build the following connected household modules:

1. **Home dashboard**
   - Today's priorities, overdue tasks, upcoming bills and events
   - Grocery and low-stock alerts
   - Budget snapshot, cleaning progress and maintenance alerts
   - Household activity and AI daily briefing

2. **Tasks**
   - Create, edit, delete, assign, comment, attach files
   - Priority, due dates, categories, subtasks
   - Recurrence and completion history
   - Overdue and reminder states

3. **Cleaning**
   - Room-wise routines
   - Daily, weekly, monthly, seasonal schedules
   - Assignment and completion tracking
   - Deep-cleaning plans

4. **Shopping**
   - Multiple shopping lists
   - Product, quantity, unit, category, preferred brand/store
   - Estimated and actual prices
   - Purchased state and shopping history

5. **Pantry**
   - Quantity and unit
   - Minimum stock
   - Expiry dates
   - Storage location
   - Stock movements and wastage

6. **Meals**
   - Breakfast, lunch, dinner and snacks
   - Weekly meal planner
   - Recipes, ingredients and servings
   - Dietary preferences and allergy notes
   - Meal cost estimates
   - Generate shopping list from meal plan

7. **Finance**
   - Income and expenses
   - Monthly and category budgets
   - Savings goals
   - Payment methods including cash, UPI, card and bank transfer
   - Receipt attachments
   - Monthly, quarterly and annual reports

   Use integer minor units (paise) or a precise decimal representation. Never use floating-point arithmetic for money.

8. **Bills**
   - Electricity, water, gas, internet, mobile, rent, insurance, school fees, maintenance, loans and subscriptions
   - Due dates, recurrence, reminders, payment records and history

9. **Maintenance**
   - Assets, repair requests, service providers, service history, warranty expiry, costs and next service reminders

10. **Inventory**
    - Furniture, appliances, electronics, kitchen equipment and valuables
    - Location, quantity, purchase date, images and warranty

11. **Family and staff**
    - Multiple households
    - Invitations and membership
    - Roles and permissions
    - Owner, administrator, adult, child and staff roles
    - Staff access restricted to assigned work and necessary information

12. **Calendar**
    - Events, appointments, birthdays, anniversaries, school events, bill dates and task deadlines
    - Recurrence, reminders and conflict detection

13. **Documents**
    - Property documents, agreements, insurance, receipts, warranties and service records
    - Categories, metadata, expiry reminders and restricted access

14. **Notes**
    - Shared and private notes, categories, search and attachments

15. **Reports**
    - Household expenditure, category spending, budget utilisation, income vs expenditure
    - Task completion, shopping, maintenance, wastage and savings
    - Agent activity and token usage

---

# 5. FIREBASE DATA ARCHITECTURE

Design Firestore around household tenancy and actual query patterns.

Suggested top-level structure:

```text
users/{uid}
households/{householdId}
households/{householdId}/members/{uid}
households/{householdId}/invitations/{invitationId}
households/{householdId}/preferences/{documentId}
households/{householdId}/tasks/{taskId}
households/{householdId}/taskOccurrences/{occurrenceId}
households/{householdId}/cleaningRooms/{roomId}
households/{householdId}/cleaningSchedules/{scheduleId}
households/{householdId}/shoppingLists/{listId}
households/{householdId}/groceryItems/{itemId}
households/{householdId}/pantryItems/{itemId}
households/{householdId}/pantryMovements/{movementId}
households/{householdId}/recipes/{recipeId}
households/{householdId}/mealPlans/{mealPlanId}
households/{householdId}/transactions/{transactionId}
households/{householdId}/budgets/{budgetId}
households/{householdId}/bills/{billId}
households/{householdId}/billPayments/{paymentId}
households/{householdId}/assets/{assetId}
households/{householdId}/maintenanceRecords/{recordId}
households/{householdId}/inventoryItems/{itemId}
households/{householdId}/events/{eventId}
households/{householdId}/documents/{documentId}
households/{householdId}/notes/{noteId}
households/{householdId}/notifications/{notificationId}
households/{householdId}/approvals/{approvalId}
households/{householdId}/activityLogs/{logId}
households/{householdId}/agentSessions/{sessionId}
households/{householdId}/agentWorkflows/{workflowId}
households/{householdId}/agentUsage/{usageId}
households/{householdId}/scheduledJobs/{jobId}
```

This is a starting schema, not a command to create every collection blindly. Validate document sizes, query patterns, write rates, indexing and transaction requirements. Avoid unbounded arrays and hot documents. Keep high-volume activity and usage records partitioned appropriately.

## Security rules
- Deny access by default.
- Verify authenticated Firebase UID.
- Verify household membership for every household-scoped operation.
- Enforce roles and permissions in rules where possible.
- Do not trust a client-supplied household ID by itself.
- Restrict private finance and document data.
- Staff can access only assigned duties and explicitly permitted records.
- Protect user profile and membership updates.
- Never allow clients to set privileged roles or admin claims.
- Validate immutable fields and allowed state transitions.
- Use server-side Cloud Functions for privileged operations.
- Keep Storage Rules consistent with Firestore membership and document access.
- Use Firebase App Check to reduce abuse from unauthorised clients.

Create comprehensive Firestore Rules and Storage Rules tests using the Firebase Emulator Suite. Include cross-household isolation tests.

## Firebase services
- Authentication: email/password and supported federated providers; secure account recovery.
- Firestore: household operational data.
- Cloud Storage: private files, receipts, images and documents.
- Cloud Functions: trusted actions, integrations, recurrence generation, agent gateway and scheduled processing.
- Cloud Messaging: push notifications.
- App Check: application attestation.
- Crashlytics: crash diagnostics.
- Analytics: optional, privacy-conscious, consent-aware product analytics.
- Remote Config: safe feature flags and rollout controls.

Use Firebase Emulator Suite for local development and CI. Include Firebase project setup instructions and a safe `.env.example` / configuration template. Never commit service account keys, API secrets or production credentials.

---

# 6. HERMES AGENT ECOSYSTEM

Hermes must be the actual agent runtime, not an invented API wrapper.

Before implementing:
1. Read official documentation: https://hermes-agent.nousresearch.com/docs
2. Inspect: https://github.com/NousResearch/hermes-agent
3. Verify current installation, runtime, configuration, memory, skills, delegation, MCP, Bot Mode and scheduling interfaces.
4. Pin a compatible release or commit.
5. Build and test a HomeHub adapter around verified interfaces.
6. Document setup and operational dependencies.

Never invent Hermes endpoints, configuration fields, tool names or undocumented runtime behaviour.

## Main agent
Create one primary orchestrator named `homehub-hermes`.

Responsibilities:
- Understand household goals.
- Retrieve authorised, relevant context.
- Select the correct skill.
- Create plans and action sequences.
- Invoke approved household tools.
- Request human approval when required.
- Delegate only genuinely complex tasks.
- Verify results.
- Report concise outcomes.

## On-demand skills
Create:
1. `household-manager`
2. `finance-manager`
3. `smart-shopping`
4. `meal-planner`
5. `home-maintenance`
6. `family-coordinator`
7. `household-reports`
8. `approval-manager`

Each skill must contain a `SKILL.md` with purpose, activation criteria, required context, allowed tools, prohibited actions, workflow, output format, verification and error handling.

Use progressive loading. Do not load every skill for every request. Specialist bot profiles should be added only when separate context, permissions or independent execution genuinely justify them.

## Runtime security
- Run Hermes as a secured backend service, not inside either mobile app.
- Native apps authenticate with Firebase and call the HomeHub API gateway.
- Gateway verifies Firebase ID tokens and household membership.
- Gateway checks roles, action scopes, autonomy policy and approval state.
- Never expose Hermes administrator credentials or unrestricted tools to clients.
- Never expose unrestricted shell, SQL, filesystem or browser tools through household MCP.

---

# 7. TOKEN UTILISATION OPTIMISATION

Token efficiency is a core requirement.

Implement:
1. Database-first operations.
2. Deterministic functions for ordinary CRUD.
3. One primary orchestrator.
4. On-demand skill loading.
5. Selective specialist delegation.
6. Compact household context.
7. Relevant memory retrieval only.
8. Summarisation of long conversation history.
9. Tool-output filtering.
10. Batched operations where safe.
11. Short structured agent responses.
12. Model routing based on task complexity.
13. Prompt caching where supported by the selected provider.
14. Scheduled scripts instead of unnecessary AI polling.
15. Bounded retries and execution budgets.

Never send the full household database or full conversation history to Hermes when a small relevant context is sufficient.

Do not use an LLM for arithmetic, date comparison, checkbox updates or ordinary database operations.

## Model routing
Keep provider and model selection configurable. Use economical models for simple classification and short tasks; escalate to stronger reasoning models for complex planning. Do not hardcode provider-specific assumptions throughout the codebase.

## Usage ledger
Record:
- Agent and workflow ID
- Provider and model
- Input/output tokens
- Cached tokens where available
- Delegated usage
- Duration
- Retries
- Estimated cost when pricing is configured
- Success/failure

Build an AI usage dashboard. Measure tokens per successful workflow. Do not claim savings percentages without a measured baseline.

---

# 8. CUSTOM HOMEHUB MCP SERVER

Create a dedicated, secured MCP server exposing narrowly scoped household operations.

Initial tools:

### Household
- `get_household_summary`
- `get_household_members`
- `get_member_permissions`

### Tasks
- `list_tasks`
- `create_task`
- `update_task`
- `complete_task`
- `assign_task`

### Shopping
- `get_inventory`
- `get_low_stock_items`
- `create_shopping_list`
- `add_shopping_item`
- `mark_item_purchased`

### Meals
- `get_meal_plan`
- `create_meal_plan`
- `generate_meal_shopping_list`

### Finance
- `get_budget_summary`
- `list_expenses`
- `record_expense`
- `get_bill_status`

### Maintenance
- `list_maintenance_records`
- `create_maintenance_request`
- `schedule_service_reminder`

### Calendar
- `list_events`
- `create_event`
- `check_schedule_conflicts`

### Approvals
- `request_approval`
- `list_pending_approvals`
- `get_approval_status`

### Reports
- `get_household_report`
- `get_agent_usage_report`

All tools must authenticate the requesting user, enforce household isolation and permissions, validate inputs, check autonomy policies, use idempotency keys for retryable writes and create audit events. Tool responses must be compact and structured.

Use the Firebase Admin SDK only in trusted server environments. Do not ship admin credentials in either native app.

---

# 9. AGENTIC WORKFLOWS

Implement real end-to-end workflows.

## Weekly household preparation
User: "Prepare everything for next week."

The agent:
1. Retrieves relevant household preferences.
2. Checks family schedules.
3. Checks pantry stock.
4. Reviews meal preferences.
5. Plans seven days of meals.
6. Generates a grocery list.
7. Estimates costs from available prices.
8. Checks the budget.
9. Reviews outstanding tasks.
10. Proposes assignments.
11. Requests approval where required.
12. Executes authorised operations.
13. Verifies Firestore results.
14. Produces a concise summary.

## Guest preparation
User: "Prepare the house for guests on Saturday."

Check event date and availability; create room-wise cleaning tasks; review kitchen stock; propose a menu; create a shopping list; estimate costs; propose assignments; create reminders; track completion.

## Budget protection
Monitor spending against budgets, detect unusual patterns, forecast remaining expenses and suggest savings. Never move money or pay bills autonomously.

## Maintenance coordination
Check service history, appliance details and warranty; create a maintenance request; propose dates; request approval before contacting or booking a provider; track verified results.

## Daily briefing
Produce a concise briefing of priorities, overdue tasks, bills, family appointments, stock shortages and maintenance reminders. Generate AI briefings only when useful; deterministic checks should run without LLM calls.

---

# 10. AUTONOMY AND APPROVALS

Four modes:
1. Assistant
2. Copilot
3. Autonomous routine operations
4. Advanced restricted autonomy

Default to mode 3 for safe, reversible household operations.

Automatic operations may include task creation, checklist updates, shopping-list generation, reminders and reports, subject to configured permissions.

Human approval is mandatory for:
- Purchases
- External bookings
- Payments
- Sending external messages
- Sharing sensitive information
- Deleting important documents
- Irreversible actions

Approval records include requester, agent, action, parameters, estimated cost, expiry, status, approver and execution result.

Provide an emergency pause for all autonomous operations. Enforce approval and permission checks on the server, not just in the UI.

---

# 11. MEMORY

Separate:
- Operational household data in Firestore.
- Procedural knowledge in Hermes skills.
- Conversation summaries and relevant agent memory in a permission-scoped memory store.

Implement household-scoped memory, user-private memory, access controls, correction, deletion and export. Retrieve only context needed for the current task. Do not store unrestricted private conversations as permanent memory.

---

# 12. AUTOMATIONS AND SCHEDULING

Use Cloud Scheduler + Cloud Functions for deterministic scheduled operations and event-driven triggers. Use Hermes scheduled jobs only for workflows that genuinely require agent reasoning. Avoid duplicate schedulers for the same job.

Suggested configurable routines:
- Morning daily briefing
- Evening tomorrow priorities
- Bill deadline checks
- Pantry threshold checks
- Weekly meal and grocery planning
- Weekly household summary
- Monthly budget review
- Monthly maintenance review

Every job must include household ID, owner, schedule, timezone, enabled status, last execution, next execution, failure status and retry policy. Support pause, resume, edit and delete. Make jobs idempotent.

---

# 13. OFFLINE SUPPORT AND SYNCHRONISATION

Both native apps must support:
- Offline task viewing and creation
- Offline task completion
- Local shopping lists
- Local notes
- Pending sync indicators
- Retry with backoff
- Conflict detection
- Idempotent writes

Android: Room + repository sync layer + WorkManager.  
iOS: SwiftData/Core Data + repository sync layer + permitted background execution.

Never silently overwrite financial records. Define conflict policies by data type and expose conflicts that require user resolution.

---

# 14. NOTIFICATIONS

Implement push and in-app notifications for:
- Tasks and overdue activities
- Bills
- Pantry stock
- Maintenance
- Approval requests
- Agent workflow completion
- Daily briefings

Support user/category preferences, quiet hours, deduplication, deep links and notification permissions. Use FCM on Android and APNs through FCM on iOS. Handle token refresh and logout correctly.

---

# 15. SECURITY AND PRIVACY

Implement:
- Firebase Authentication
- Firestore and Storage Security Rules
- Firebase App Check
- Server-side authorisation
- Least-privilege IAM
- Secret management
- Private file access and short-lived signed URLs where appropriate
- Input validation
- Rate limiting
- Audit logs
- Approval expiry
- Emergency agent shutdown
- Backup and recovery documentation
- Data export and deletion workflows

Treat uploaded documents, emails and external content as untrusted input. Protect against prompt injection. External content cannot override agent system instructions, permissions or household policy.

Do not expose service account keys, Hermes secrets or privileged Firebase credentials in client code or source control.

Include privacy controls aligned with applicable Indian data protection requirements. Collect only data needed for defined product purposes.

---

# 16. NATIVE USER EXPERIENCE

Read `design.md` and implement its complete screen and component specifications in both native apps.

Mobile primary destinations:
- Home
- Manage
- AI
- Family
- Insights

AI command centre:
- Conversation history
- Streaming responses
- Suggested prompts
- Household context indicator
- Workflow progress
- Tool activity
- Approval cards
- Cancel / stop
- Retry and error recovery
- Token usage disclosure in diagnostics/settings

Clearly distinguish suggested, awaiting approval, executing, completed/verified, partially completed, failed and cancelled.

No visible button may be inert. Every action must have loading, success, empty and error states as appropriate.

---

# 17. ONBOARDING

Implement:
1. Welcome
2. Account creation / sign-in
3. Household creation
4. Location, currency and timezone
5. Member invitations
6. Roles and permissions
7. Optional budget and recurring bills
8. Household preferences
9. AI autonomy settings
10. Dashboard

Allow optional steps to be skipped and resumed. Explain data use and request permissions only when needed.

---

# 18. TESTING AND QUALITY

Use:
- Android unit tests, Compose UI tests and instrumented tests.
- iOS unit tests and XCUITest.
- Firebase Emulator Suite for Authentication, Firestore, Storage and Functions tests.
- MCP tool contract tests.
- Hermes adapter integration tests.
- End-to-end workflow tests.
- Security rules tests.
- Offline/sync tests.
- Accessibility checks.

Acceptance criteria:
- Users can register, sign in and recover accounts.
- Users can create households and invite members.
- Role and household isolation is enforced.
- Tasks can be created, assigned and completed.
- Grocery and pantry data persist and sync.
- Meal plans can generate shopping lists.
- Financial calculations are accurate.
- Bills retain payment history.
- Private documents are securely stored.
- Offline changes sync safely.
- AI requests reach the actual Hermes runtime.
- Hermes tools operate only on authorised household records.
- Approval-gated actions cannot run before approval.
- Agent actions are audited and verified.
- Scheduled jobs do not duplicate.
- Token usage is measurable.
- Apps continue to support normal household functions when Hermes is unavailable.
- Android and iOS builds succeed independently.
- Liquid Glass is clearly implemented on both platforms and has accessible/performance fallbacks.

Do not claim completion without test evidence.

---

# 19. REPOSITORY STRUCTURE

Use a clear native multi-project structure:

```text
homehub/
  android/
    app/
    build.gradle.kts
    settings.gradle.kts
  ios/
    HomeHub/
    HomeHub.xcodeproj/
    HomeHubTests/
    HomeHubUITests/
  backend/
    firebase/
      firestore.rules
      firestore.indexes.json
      storage.rules
      functions/
      emulator/
    api-gateway/
    mcp-server/
  agents/
    hermes/
      skills/
      profiles/
      config/
      docs/
  shared/
    api-contracts/
    schemas/
  docs/
    architecture.md
    firebase-setup.md
    hermes-setup.md
    security.md
    deployment.md
    accessibility-checklist.md
  assets/
    branding/
  scripts/
  tests/
  .env.example
  README.md
  design.md
  IMPLEMENTATION_STATUS.md
```

Adapt this layout to actual Gradle, Xcode and Firebase conventions where needed. Do not force shared UI code into `shared/`; only contracts, schemas and documentation belong there.

---

# 20. REQUIRED DELIVERABLES

1. Complete native Android source code.
2. Android application ID `com.e404.homehub`.
3. Complete native iOS source code.
4. iOS bundle identifier `com.e404.homehub`.
5. Native Liquid Glass implementation on both platforms.
6. Firebase project configuration templates and setup guide.
7. Firestore schema design, indexes and security rules.
8. Storage security rules.
9. Cloud Functions.
10. Firebase Emulator Suite configuration and tests.
11. Custom HomeHub MCP server.
12. Hermes integration adapter.
13. Hermes skills and verified configuration examples.
14. Database/data seed scripts for local development.
15. Environment variable example file with placeholders only.
16. API and MCP documentation.
17. Architecture and security documentation.
18. Android and iOS build instructions.
19. Backup and recovery instructions.
20. Automated tests and test evidence.
21. `IMPLEMENTATION_STATUS.md` with completed, in-progress and blocked items.
22. `README.md` with exact local setup instructions.

---

# 21. EXECUTION INSTRUCTIONS

Start by inspecting:
- Repository structure
- Installed tools and SDKs
- Android SDK / Gradle / Kotlin
- Xcode and iOS build availability
- Firebase CLI and project configuration
- Hermes installation and official documentation
- Existing icon and brand assets
- `design.md`

Then:
1. Report a concise implementation plan and any genuine blockers.
2. Establish the native Android and iOS project foundations.
3. Establish Firebase Emulator Suite and security rules before feature data access.
4. Implement authentication, household membership and role enforcement.
5. Implement the shared backend contracts.
6. Implement native design systems and Liquid Glass on both platforms, following `design.md`.
7. Implement household modules.
8. Implement Hermes runtime integration and MCP tools.
9. Implement agent workflows, approvals and token analytics.
10. Implement notifications and offline synchronisation.
11. Test, fix, document and build both native apps.

Do not ask for approval for ordinary technical choices. Ask only when a decision requires external credentials, account ownership, an irreversible action or a user-specific business rule.

If Firebase credentials or Hermes provider credentials are missing:
- Continue with Firebase Emulator Suite and local mocks.
- Implement real integration interfaces and configuration templates.
- Clearly mark production integrations as awaiting credentials.
- Never fabricate successful deployment or external actions.

After each milestone:
- Format code.
- Run static analysis.
- Run relevant tests.
- Fix failures.
- Update documentation and `IMPLEMENTATION_STATUS.md`.
- Report actual completed work, test results and blockers.

Do not leave important controls non-functional. Do not substitute static mockups for working features. Do not claim a feature works when it is only a placeholder.

**FINAL OBJECTIVE:** Deliver HomeHub AI as two genuinely native applications — Android (`com.e404.homehub`) in Kotlin/Jetpack Compose and iOS (`com.e404.homehub`) in Swift/SwiftUI — sharing a Firebase backend and a secured Hermes agent ecosystem, with the same recognisable Liquid Glass visual language on both platforms, token-efficient agent workflows, strong household privacy and production-quality tests.

# OPENCLAW-STYLE HOME GATEWAY, PLUGIN ECOSYSTEM & ALEXA — REQUIRED ADDENDUM

This addendum extends the master brief. It does not replace the native-only, Firebase, Hermes, security, or `design.md` requirements above. Implement the following as first-class product scope.

## 1. Product direction: HomeHub is the household gateway

Build HomeHub as an OpenClaw-inspired, household-focused agent platform: one always-available **HomeHub Gateway** connects the household's people, AI agents, skills, services, messaging channels, voice assistants, smart-home platforms, and device adapters.

Use OpenClaw as an architectural reference for the separation of:
- Gateway/control plane and session routing
- Agents and specialist agents
- Tools (typed actions and read operations)
- Skills (workflow instructions loaded only when relevant)
- Plugins/connectors (installable integration packages)
- Channels (where people talk to HomeHub)
- Device nodes (paired phones, tablets, hubs and supported home devices)
- Schedules, webhooks and event-driven automations
- Model and speech providers

Do not copy OpenClaw's coding-agent defaults or expose unrestricted host-shell access. HomeHub is for household management and physical-world actions. Its tool execution must be narrow, typed, auditable and permission-enforced.

## 2. HomeHub Gateway architecture

Implement a secured backend **HomeHub Gateway** as the single entry point for app, voice, channel, plugin and device requests.

Responsibilities:
- Authenticate users and services; verify Firebase ID tokens and integration-specific OAuth/JWT credentials.
- Resolve household membership, roles, household context, active session and autonomy policy.
- Route requests to `homehub-hermes` and on-demand specialist agents.
- Discover available tools from enabled plugins and expose only tools allowed for the current user, channel, household and task.
- Manage sessions, conversation state, compact memory references, idempotency, rate limits and cancellation.
- Dispatch events to deterministic workflows or Hermes only when reasoning is genuinely needed.
- Maintain plugin lifecycle, health checks, version compatibility, secrets references, scopes, setup status and revocation.
- Provide a live event stream for the native apps: agent status, approvals, device status, automation runs and connector health.
- Provide a household audit trail with actor, channel, agent, tool, target, requested action, approval, result and timestamp.
- Support multi-user households with strict tenant isolation and per-member permissions.
- Expose a documented, versioned HomeHub API and a narrow MCP server for approved agent tools.

Suggested logical services (can be deployed as modular Cloud Functions / Cloud Run services as appropriate):
1. API Gateway and identity/policy middleware
2. Agent orchestrator and session manager
3. Plugin registry and connector runtime
4. Device integration service
5. Alexa skill endpoints
6. Automation/event processor
7. Notification and channel delivery service
8. Audit and usage metering service

Do not create a single giant Cloud Function. Choose Firebase Cloud Functions 2nd gen and/or Cloud Run based on execution duration, protocol, concurrency and operational requirements. Keep Firebase Auth, Firestore, Storage, FCM and App Check as the selected Firebase stack.

## 3. Plugin marketplace and connector framework

Create a native **Integrations / Plugin Marketplace** area in HomeHub with:
- Browse by category; search; featured and recommended integrations.
- Plugin detail page: what it does, supported actions, read/write scopes, data accessed, required accounts/devices, regions, pricing if known, vendor, privacy notes and last verified compatibility.
- Connect / configure / test / pause / reconnect / disconnect / revoke controls.
- Per-household enablement and per-member permissions.
- Statuses: Available, Needs setup, Connected, Action required, Paused, Disconnected, Unsupported in region, and Error.
- Clear distinction between first-party, verified partner, community, and custom integrations.
- A tool-permission screen listing every action an integration can expose.
- Connection diagnostics, event history, sync status and last successful sync.
- Plugin version, manifest validation, compatibility checks and safe update/rollback.
- Import/export of non-secret configuration. Never export credentials or tokens.
- User-facing consent and data deletion/revocation controls.

### Plugin contract

Define a versioned plugin manifest and runtime contract. Every plugin must declare:
- Stable plugin ID, display name, publisher, version, description, category, icon and documentation URL.
- Supported regions, languages, platforms and minimum HomeHub API version.
- Authentication method (OAuth 2.0/OIDC, API key, device pairing, local bridge, webhook signature, or none).
- Exact OAuth scopes and data categories.
- Typed tools with JSON Schema input/output, read/write classification, risk level, idempotency support and confirmation requirement.
- Event subscriptions and webhook topics.
- Setup, health-check, disconnect, credential-refresh and data-deletion lifecycle hooks.
- Network destinations and required permissions.
- Privacy policy, retention statement and support contact.
- Required/optional configuration fields and secret references.

Use a capability model rather than giving plugins direct Firestore access. Plugins call narrowly scoped HomeHub service APIs. Secrets live in Secret Manager or an equivalent secure secret store; Firestore stores references and non-secret connection metadata only. Never put refresh tokens, API keys or passwords in client app storage or logs.

### Plugin execution and safety

- Plugins execute in isolated, least-privilege server-side runtimes.
- Enforce allowlisted outbound network destinations, timeouts, payload limits, concurrency limits and per-household quotas.
- Validate every input and output against schemas.
- Treat plugin responses, webhooks, emails, messages, documents and device metadata as untrusted data, never as instructions.
- Apply policy checks before every write/action, not just at UI level.
- Require explicit approval for purchases, payments, external bookings, external messages, unlock/disarm actions, sharing sensitive data, destructive changes and irreversible actions.
- Device actions that could affect physical safety (locks, alarms, garage doors, ovens, heaters, cooktops, water valves) require a dedicated risk policy, user confirmation where appropriate, device-state verification and safe failure behavior.
- Add idempotency keys, replay protection, signed webhooks, audit logs and bounded retries.
- Plugin failure must not block core household features.
- Include a kill switch per plugin and a global emergency pause for all outbound actions.
- Do not auto-install or auto-enable third-party plugins. Show permissions and obtain consent first.

### Plugin discovery and compatibility

Build a curated, expandable connector catalogue. Do not hard-code a claim that every third-party service is universally available. At runtime distinguish:
1. Native first-party HomeHub integration
2. Official vendor API integration
3. Supported bridge/protocol integration
4. Community connector requiring review
5. User-provided custom webhook/MCP connector
6. Not currently supported

Where no official API exists, explain the limitation and offer a supported bridge or manual workflow. Do not scrape private APIs, bypass MFA, violate service terms, or automate consumer apps through brittle UI scripting.

Implement a plugin SDK, sample plugin, manifest validator, integration test harness, sandbox mode, developer documentation and a plugin certification checklist. Keep the catalogue extensible so new plugins can be added without changing the agent core.

## 4. Initial HomeHub plugin catalogue

Build the marketplace taxonomy and seed catalogue below. Each entry is a connector target, not a claim that credentials, API access, or regional support are already available. Mark entries as Available only after a working integration and tests exist. Use official APIs and documented protocols first.

### A. Smart home, hubs and device protocols
Prioritise:
- Matter (controller/bridge integration where supported)
- Home Assistant (preferred broad local smart-home bridge)
- Amazon Alexa
- Google Home / Google Home APIs where available
- Samsung SmartThings
- Apple Home via supported HomeKit-compatible bridge architecture; do not pretend Android can use Apple-only APIs directly
- Philips Hue
- IKEA smart home / DIRIGERA
- Aqara
- Tuya / Smart Life
- Shelly
- SwitchBot
- TP-Link Kasa / Tapo where official interfaces permit
- Xiaomi / Mi Home where official interfaces permit
- Ecobee, Nest / Google thermostat services where supported
- Ring, Eufy and other camera/doorbell vendors only through documented, privacy-respecting APIs
- Sonos and supported multi-room audio systems
- Roborock and other robot vacuum vendors where documented APIs exist
- Smart plugs, lights, sensors, switches, thermostats, curtains, fans, ACs, water-leak sensors, smoke/CO alarms, door locks and energy meters.

Protocol adapters:
- Matter, Thread, Wi-Fi, Bluetooth LE, Zigbee and Z-Wave through a compatible local hub/bridge.
- MQTT and local REST/WebSocket adapters for user-owned equipment.
- Home Assistant is the recommended first broad compatibility bridge; direct vendor connectors should be added when they provide clear value.

### B. Voice, speech and communication channels
- Amazon Alexa (mandatory; see section 6)
- HomeHub in-app voice assistant with push-to-talk and optional hands-free mode only with explicit OS permissions
- Google Assistant / Gemini integrations only where supported by public APIs and platform policies
- Siri Shortcuts / App Intents on iOS
- WhatsApp Business Platform (official, approved use cases only)
- Telegram bot
- Discord
- Slack
- Microsoft Teams
- Google Chat
- Email (Gmail and Microsoft Outlook via OAuth APIs)
- SMS / supported Indian messaging providers
- FCM and APNs push notifications
- Optional voice providers: platform speech APIs, Google, Azure, Deepgram, ElevenLabs and OpenAI speech/realtime APIs, behind provider adapters and user-selected settings.

Channels must map to the same household identity, session policy and audit system. Pair new channel senders/devices before granting access. Never treat a channel identity as household membership until linked and authorised.

### C. Household productivity and family
- Google Calendar
- Microsoft Outlook Calendar
- Google Contacts / Microsoft contacts where explicitly consented
- Google Drive, OneDrive and Dropbox for selected household files
- Google Tasks / Microsoft To Do
- Notion
- Todoist
- Trello
- Asana
- Zoom / Google Meet / Teams meeting summaries only with participant consent and lawful recording/transcription support
- School calendars and parent portals through official integrations or user-provided calendar feeds
- Shared family calendars, chores and routines native to HomeHub.

### D. Finance and bills (India-first)
- Email/SMS bill and receipt extraction with explicit mailbox/message scopes.
- Bank account data through India's Account Aggregator ecosystem only with valid consent and compliant FIU/FIP partners; do not screen-scrape bank accounts.
- UPI payment intent/deep-link support only where permitted; HomeHub must not silently initiate or approve payments.
- Credit card/bank statement import from user-selected files.
- Utility billers and recharge providers through official biller/payment integrations where available.
- Insurance, rent, subscriptions, loan and EMI reminders.
- Export to CSV/PDF and accountant-friendly summaries.
- Finance connectors default to read-only; payments and transfers always require explicit user action in the bank/UPI provider flow.

### E. Shopping, groceries, food and delivery
- Amazon India and other retailers through official APIs/approved affiliate or partner interfaces.
- Flipkart and other commerce partners where official APIs/partner access exists.
- BigBasket, Blinkit, Zepto, Swiggy Instamart and other grocery services only through supported official/partner interfaces.
- Swiggy, Zomato and supported restaurant/food services where documented integrations exist.
- Shopping list export/share, price watch where permitted, pantry and inventory sync.
- HomeHub can prepare carts and compare options where supported; checkout, ordering and payment require explicit approval.

### F. Home services, maintenance and utilities
- Service-provider booking platforms where official APIs/partners exist.
- Electricity, water, gas, broadband and mobile bill integrations where official sources exist.
- HVAC, appliance warranty and service portals where supported.
- Maintenance schedules, warranties, manuals, service records and asset QR codes.
- Weather, air quality and power outage feeds from reliable providers.
- Calendar-based service reminders and local vendor workflows.

### G. Information, search, media and AI providers
- Search/web retrieval providers such as Brave, Google Programmable Search (where available), Bing, Perplexity and approved search APIs.
- Document extraction/OCR and speech transcription providers.
- Model providers behind a provider-neutral adapter: OpenAI, Anthropic, Google Gemini, Amazon Bedrock, Mistral, DeepSeek, Qwen, Groq, Together, OpenRouter, and local Ollama/LM Studio/vLLM-compatible endpoints.
- Image/media providers only if a household use case exists.
- User chooses preferred model/provider; never silently send household content to a new provider.
- Provider selection must support cost controls, privacy labels, fallback policy and per-workflow routing.

### H. Custom and developer integrations
- MCP client for approved remote MCP servers using authenticated, allowlisted transports.
- HomeHub MCP server exposing only policy-filtered household tools.
- Signed webhooks, outbound webhooks, REST connector builder and custom calendar/feed import.
- Plugin SDK and developer mode for trusted household admins.
- No arbitrary shell, unrestricted browser, or general-purpose code execution from a household plugin.

## 5. OpenClaw-style channel, skill and agent management UI

Add native screens consistent with `design.md` and Liquid Glass rules:
- **HomeHub Gateway**: gateway health, connected channels, active sessions, agent status, recent events and emergency pause.
- **Integrations**: searchable plugin marketplace, category filters, connection states and setup.
- **Channels**: WhatsApp, Telegram, email, Alexa, app voice, push, etc.; pairing, routing and allowed household members.
- **Agents & Skills**: primary HomeHub agent, specialist agents, installed skills, enabled/disabled state, skill version, last used, token/cost usage and permissions.
- **Automations**: schedules, triggers, conditions, actions, approval gates, run history and failure diagnostics.
- **Devices**: rooms, devices, capabilities, state, battery/connectivity, last seen and supported actions.
- **Activity & Audit**: searchable chronological record of agent decisions, plugin calls, device actions and approvals.
- **Privacy & Permissions**: data categories, connected accounts, scopes, retention, export, revoke and delete.

Do not overwhelm the household dashboard. Keep advanced Gateway and plugin administration in a dedicated area. Glass surfaces are for compact controls and overlays only; dense lists/settings remain legible opaque or low-translucency surfaces.

## 6. Amazon Alexa integration — mandatory

Implement Alexa as a first-class HomeHub channel and smart-home integration, not merely a marketing mention.

### 6.1 Alexa Smart Home Skill
Build an Amazon Alexa Smart Home Skill using the official Alexa Smart Home Skill API and supported device capability interfaces. Support only capabilities that HomeHub can actually execute and verify, such as:
- Device discovery and endpoint mapping
- Power on/off
- Brightness and colour where supported
- Thermostat temperature/mode where supported
- Lock state/control only with required vendor/Alexa security requirements and explicit policy
- Contact, motion, temperature, humidity and other supported sensor state reporting
- Scenes/routines only where supported by the relevant APIs

Implement:
- OAuth 2.0 account linking between Amazon and HomeHub accounts.
- Secure token validation, refresh and revocation.
- Endpoint discovery mapping to HomeHub household, room, device and capability IDs.
- Alexa directive handler and response validation.
- State reporting and change reporting where supported.
- Device reachability, stale-state handling, duplicate endpoint handling and unlink cleanup.
- Multi-household and multi-member account mapping without leaking one household's devices to another.
- Region/locale support and clear capability limitations.
- Alexa developer console configuration and deployment documentation.
- Automated contract tests with mocked Alexa requests; staging tests before production certification.

### 6.2 HomeHub custom Alexa Skill
Create a separate custom skill or a multi-capability skill if justified by Alexa's supported design. Example intents:
- “Alexa, ask HomeHub what’s on my shopping list.”
- “Alexa, ask HomeHub what chores are due today.”
- “Alexa, ask HomeHub what’s for dinner.”
- “Alexa, ask HomeHub for the household briefing.”
- “Alexa, ask HomeHub to add milk to the shopping list.”
- “Alexa, ask HomeHub whether the front door is locked.”

Read-only intents may respond after account linking and policy checks. Mutating intents must be restricted to low-risk reversible actions, require an unambiguous household/member context, and confirm consequential changes. Purchases, payments, unlocking doors, disabling alarms, sharing private information or other high-risk actions must never be completed solely from an ambiguous voice command. Use a confirmation step or direct the user to the HomeHub app.

### 6.3 Alexa household identity and privacy
- Require explicit account linking for household-specific data and smart-home controls.
- Respect the Amazon account link, HomeHub account, household membership and member roles independently.
- Allow the household owner to choose which rooms/devices Alexa can discover.
- Support per-device/per-action Alexa exposure toggles.
- Provide “Disconnect Alexa” and revoke tokens immediately.
- Do not store raw Alexa audio recordings. Store only the minimum request/response metadata required for reliability and audit.
- Do not announce sensitive financial, health, location or personal information aloud unless the user explicitly opts in and the request is authenticated and appropriate for the channel.
- Consider that shared Echo devices may be heard by guests or other household members; apply voice-channel disclosure policy.
- Do not assume voice recognition alone is strong authentication.

### 6.4 Alexa fallback and failure behavior
If Alexa is unavailable, token linking expires, a device is offline or the action cannot be verified:
- Return a clear spoken failure message.
- Do not claim an action succeeded unless HomeHub receives confirmation from the integration/device.
- Offer the HomeHub app as the next step.
- Record a safe diagnostic event without exposing secrets.

### 6.5 Alexa deliverables
- Alexa Smart Home Skill source and deployment configuration.
- Custom skill interaction model, intents, slot types and sample utterances.
- Account-linking configuration guide.
- Device capability mapping document.
- Alexa-to-HomeHub sequence diagrams.
- Security/privacy review and test fixtures.
- Staging and production certification checklist.
- Native app Alexa connection and permission screens.

## 7. Device nodes and local-home bridge

Support paired native Android/iOS devices as trusted HomeHub nodes for notifications, local actions and user-approved device capabilities. The backend remains the orchestrator; native apps are not agent runtimes.

For local-home integrations:
- Prefer Home Assistant or a dedicated local bridge for Matter/Zigbee/Z-Wave/MQTT and LAN-only devices.
- Provide secure outbound connection or mutually authenticated tunnel; never expose an unauthenticated home hub directly to the public internet.
- Pair bridge using one-time code/QR and rotate credentials.
- Keep local device credentials in the bridge/secure store, not Firestore.
- Define offline behavior and local-vs-cloud authority for device state.
- Avoid claiming local control when a vendor cloud dependency is required.

## 8. Event-driven home automations

Implement event triggers and deterministic automations:
- Person arrives/leaves (only with explicit location permission and privacy controls)
- Device/sensor state changes
- Calendar event or reminder
- Bill/renewal due
- Pantry low-stock or shopping list change
- Weather/air-quality threshold
- Maintenance interval
- Scheduled morning/evening/weekly household briefing
- Alexa routine or supported smart-home event

Automation structure:
`trigger -> filters/conditions -> policy check -> optional agent reasoning -> approval gate -> typed action -> verification -> audit/notification`

Use Cloud Scheduler, Pub/Sub/event triggers and deterministic Cloud Functions for simple workflows. Invoke Hermes only for ambiguous, multi-step or language-heavy reasoning. Prevent loops, duplicate triggers, runaway actions and unsafe chained automations. Add simulation/preview, pause, test-run and rollback where possible.

## 9. Agent and skill operating model

Retain one primary `homehub-hermes` orchestrator and the existing specialist capabilities (Finance, Shopping, Meal, Home Ops, Family, Insights). Specialists are logical on-demand agents; do not spawn persistent agents for every plugin.

Skills teach workflows; plugins provide tools. Keep this separation strict:
- A `meal-planning` skill can use a grocery plugin.
- A `home-maintenance` skill can use a device or service-booking plugin.
- A `household-briefing` skill can read calendar, tasks, bills and device state through approved tools.
- A `shopping` skill can prepare a cart using a retailer connector but cannot purchase without approval.

Use progressive skill loading, minimal relevant context, database-first reads, deterministic code for calculations/CRUD, tool-output pruning, compact memory, model routing and usage metering. Show agent reasoning summaries and actions, not hidden chain-of-thought.

## 10. Required data model additions (Firestore)

Design and document collections/subcollections, indexes, TTL and security rules for at least:
- `pluginCatalog`
- `households/{householdId}/integrations`
- `households/{householdId}/integrationSecretsRefs`
- `households/{householdId}/integrationEvents`
- `households/{householdId}/channels`
- `households/{householdId}/channelPairings`
- `households/{householdId}/devices`
- `households/{householdId}/deviceRooms`
- `households/{householdId}/deviceBridges`
- `households/{householdId}/agents`
- `households/{householdId}/skills`
- `households/{householdId}/automations`
- `households/{householdId}/automationRuns`
- `households/{householdId}/agentSessions`
- `households/{householdId}/toolApprovals`
- `households/{householdId}/auditEvents`
- `households/{householdId}/usageMetrics`

Do not put secrets in these documents. Use references to Secret Manager. Include strict household-scoped rules and emulator tests for cross-tenant access denial.

## 11. Build order and acceptance criteria

Build in phases; do not attempt to connect every external vendor simultaneously.

Phase 1 — Gateway foundation:
- Gateway API, identity/policy middleware, sessions, plugin manifest schema, plugin registry, audit and approval engine.
- Sample local/mock plugin and plugin SDK.
- Native Integrations, Gateway, Channels and Permissions screens.

Phase 2 — Core household connectors:
- Home Assistant bridge and Matter capability discovery where feasible.
- Calendar and email read-only integrations.
- Notifications and app voice.
- Initial household automation engine.

Phase 3 — Alexa:
- Account linking, Smart Home Skill, custom skill, endpoint discovery, device-state reporting and test harness.
- Alexa connection UI and household/device exposure controls.

Phase 4 — High-value household services:
- Selected finance, grocery/shopping, maintenance, media and communication integrations based on official API access and India availability.

Phase 5 — Marketplace expansion:
- Plugin SDK, certification, community/custom connectors, versioning, diagnostics and broader catalogue.

Acceptance criteria:
- A user can browse, connect, test, pause and revoke a plugin.
- Plugin actions are unavailable until scopes and household policy permit them.
- No plugin has direct unrestricted database or host access.
- One HomeHub conversation can route to multiple enabled connectors without leaking credentials or unrelated household data.
- Alexa can link an account, discover only permitted devices, execute supported actions and report verified state.
- Custom Alexa intents can answer supported household questions and safely handle low-risk list updates.
- Consequential actions are blocked or require explicit approval.
- All events and actions are auditable and tenant-isolated.
- Disconnected/failed plugins degrade gracefully.
- All native UI follows `design.md`; Android and iOS remain separate native apps.
- Firebase Emulator Suite tests cover auth, rules, plugin permissions, webhooks, approvals, Alexa request validation and cross-household isolation.
- No integration is marked Connected/Available until a real implementation and test pass exist.

## 12. Implementation reporting

At the end of each phase, report:
- What is implemented (not merely planned)
- Files/modules changed
- Tests run and results
- External developer accounts, credentials, approvals or certifications still required
- Integrations genuinely working vs mocked vs awaiting partner/API access
- Security/privacy risks and mitigations
- Token usage/cost observations where measurable
- Next concrete build step

Never fabricate API access, credentials, certifications, live device support or completed integrations. Build working foundations and honest mock/sandbox adapters when external access is unavailable.
