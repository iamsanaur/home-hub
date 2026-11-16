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
