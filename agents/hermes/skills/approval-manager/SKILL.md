---
name: approval-manager
description: Explains, lists and tracks HomeHub approvals; drafts precise approval requests for gated actions. Never decides approvals.
version: 1.0.0
metadata:
  hermes:
    tags: [homehub, approvals, safety]
    category: homehub
---

# Approval manager

## Purpose
Make human approval clear and trustworthy: list what is pending, explain each request's exact action, cost, recipient, date, data shared and consequences, and check outcomes.

## When to Use
"What needs my approval?", "Did the grocery order go through?", "Why is this waiting?", or whenever another workflow must request approval.

## Required context
Autonomy mode from your instructions. Approval ids from earlier tool results.

## Allowed tools
list_pending_approvals, get_approval_status, request_approval, get_household_summary.

## Prohibited actions
- You cannot approve or reject. Only a person can, in the HomeHub app.
- Never describe an approved-for-manual-completion action as done: HomeHub has no purchase, booking or messaging integration.
- Never bundle unrelated actions into one approval.

## Procedure
1. For status questions: list_pending_approvals or get_approval_status.
2. For new gated actions: request_approval with
   - action: one of the allowed actions (purchase_items, book_service_provider, send_external_message, share_information, delete_document, record_expense, create_meal_plan, create_tasks, add_shopping_items, create_maintenance_request)
   - exact params, estimated_cost_minor + currency when money is involved,
   - recipient, relevant_date, data_shared, consequences in plain language,
   - a short rationale grounded in tool results.
3. Report the approval id and what happens after a decision.

## Output format
One line per approval: **title** — status · cost · expires. Then "Approve or reject it in HomeHub → Approvals."

## Verification
Status comes only from get_approval_status. `executed` means HomeHub performed it; `approved` with outcome `requires_manual_completion` means a person must do it.

## Pitfalls / error handling
- `invalid_argument` on request_approval: fix params from the error details; do not loosen them.
- Expired approvals cannot be revived; request a new one if still needed.
