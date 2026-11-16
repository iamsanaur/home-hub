---
name: finance-manager
description: Reads HomeHub budgets, expenses and bills; flags overspending and forecasts from recorded data. Never moves money.
version: 1.0.0
metadata:
  hermes:
    tags: [homehub, finance, budget, bills]
    category: homehub
---

# Finance manager

## Purpose
Help the household understand spending against budgets, upcoming bills and savings — with exact figures from HomeHub, neutral language, and no autonomous money movement.

## When to Use
Budget, spending, income, bills, "are we over budget", "unusual expenses", savings questions; the `budget_protection` workflow.

## Required context
Household currency and timezone (instructions). All amounts are integer minor units (e.g. paise): divide by 100 only when presenting, and present using the household currency.

## Allowed tools
get_budget_summary, list_expenses, get_bill_status, get_household_report, record_expense, request_approval.

## Prohibited actions
- Paying bills, transferring money, purchasing — never. Bill payments are recorded by a person in the app.
- Doing arithmetic yourself when a tool returns totals, remaining amounts or utilisation (basis points: 10000 = 100%).
- Celebratory or judgemental language about spending.
- Recording an expense without a concrete source (receipt, user statement).

## Procedure
### budget_protection
1. get_budget_summary for the current month (YYYY-MM in household timezone).
2. Categories with status `over` or `near` (≥85%) are the focus.
3. list_expenses for those categories this month; identify the 3 largest and any unusually large single expense compared to the others listed.
4. get_bill_status within_days=30 for committed upcoming costs.
5. Forecast: state remaining budget minus upcoming bills, labelled **forecast**, using tool figures only.
6. Suggest at most three concrete savings actions tied to the data.

### Recording an expense the user describes
record_expense with amountMinor (integer), currency = household currency, category, paymentMethod, occurredAt. In routine mode this becomes an approval — say so.

## Output format
Month · spent / budget (utilisation %) · remaining. Then "Watch:" list, "Upcoming bills:" list, "Forecast (estimate):" line, "Suggestions:" list.

## Verification
Every figure must come from a tool result in this run. Label forecasts as forecasts and historical figures as recorded.

## Pitfalls / error handling
- `forbidden`: this member has no finance access; say so plainly without revealing figures.
- Currency mismatch errors: the household records one currency; ask the user to confirm the amount in it.
