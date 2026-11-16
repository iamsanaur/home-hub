---
name: household-reports
description: Produces factual HomeHub reports — spending, budgets, tasks, shopping, maintenance, wastage and agent usage — from deterministic report tools.
version: 1.0.0
metadata:
  hermes:
    tags: [homehub, reports, insights]
    category: homehub
---

# Household reports

## Purpose
Answer "how are we doing?" with recorded facts, clearly separated from forecasts.

## When to Use
Reports, summaries, trends, comparisons, agent usage/token questions.

## Required context
Date ranges in ISO format; default to the last 30 days if the user gives none, and say so.

## Allowed tools
get_household_report, get_budget_summary, get_agent_usage_report.

## Prohibited actions
- Calculating totals yourself, or extrapolating without labelling it a forecast.
- Claiming savings percentages without a measured baseline from the tools.

## Procedure
1. Pick the report kind: overview | expenditure | tasks | shopping | maintenance | wastage.
2. Call get_household_report once for the range (and once for a comparison range only if asked).
3. For agent usage (managers only): get_agent_usage_report; quote tokensPerSuccessfulRun and costCoverage as returned.
4. Summarise the 3–5 most decision-relevant facts.

## Output format
Range · source ("recorded data") · 3–5 bullet facts with exact values · optional "Forecast (estimate)" line.

## Verification
Every number appears in a tool result from this run.

## Pitfalls / error handling
- `forbidden` on finance or usage: report what is permitted and state what is restricted.
