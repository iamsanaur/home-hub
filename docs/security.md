# Security and privacy

## Identity and tenancy
- Firebase Auth everywhere; the gateway verifies ID tokens (`checkRevoked`) and, in production, App Check.
- Every household-scoped read/write is authorised against `households/{hid}/members/{uid}` (written only by server code). Client-supplied household IDs are never trusted alone. `users/{uid}.memberships` is a navigation index only.
- Roles: owner, admin, adult, child, staff (`core/roles.ts`, mirrored in rules). Admins cannot mint admins; nobody edits their own role; ownership transfer is explicit.

## Rules highlights (tested)
Deny by default; finance only for finance-permitted adults; staff only see assigned work; restricted documents use allow-lists; payments and stock movements append-only; locked transactions immutable; every client update must bump `version` (no silent overwrite); Storage objects immutable once written and limited to safe types/sizes.

## Agent safety
- No unrestricted tools: the MCP server exposes 31 typed household tools; no shell, SQL, filesystem or browser. Server Hermes profile disables those toolsets too.
- **Grants**: each agent run gets a random, short-lived, tool-call-capped grant bound to one user and household (hash stored). MCP tools accept no household ID. Hermes Mobile injects the grant itself, so the model never sees it; the MCP server also requires the caller's ID token to belong to the grant's user.
- Autonomy policy is enforced server-side on every tool call. Purchases, payments, bookings, external messages, sharing and deletion always become approvals; approvals execute the stored parameters on the server, once, by a person. Actions without an integration are recorded as "requires a person" — never claimed done.
- Emergency pause (any adult) blocks all autonomous writes immediately; only managers resume.
- Prompt injection: tool results, notes, documents and emails are untrusted data (instructions + skills say so); outcomes are verified from the audit log, not from model text.
- Model proxy: provider key server-side, model chosen server-side, tier is a ceiling, per-run budgets.

## Secrets
None in source. Functions use Secret Manager (`defineSecret`); local dev uses git-ignored `.secret.local`. Native apps hold only Firebase config files (git-ignored).

## Privacy
Collect only what features need; dietary/allergy data only as user-entered. Memory never stores raw conversations; users can list, correct, delete and export it. Account export (`GET /v1/me/export`) and deletion (`DELETE /v1/me`) implemented. Analytics not enabled (no consent flow yet). Aligned with India's DPDP Act principles (purpose limitation, consent, erasure) — legal review still required before launch.
