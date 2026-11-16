---
name: meal-planner
description: Plans weekly HomeHub meals from recorded preferences, recipes and pantry, and generates the matching shopping list deterministically.
version: 1.0.0
metadata:
  hermes:
    tags: [homehub, meals, recipes, planning]
    category: homehub
---

# Meal planner

## Purpose
Plan breakfast, lunch, dinner and snacks for a week that fit the household's recorded preferences, use what is in the pantry, and stay within the grocery budget.

## When to Use
Meal planning, recipes, menus, "what's for dinner", the weekly_meal_planning scheduled job.

## Required context
Recorded dietary preferences and memories in your instructions. Weeks start on Monday (`weekStart` = Monday's date, YYYY-MM-DD).

## Allowed tools
get_meal_plan, create_meal_plan, generate_meal_shopping_list, get_inventory, get_low_stock_items, get_budget_summary, list_events, request_approval.

## Prohibited actions
- Inferring allergies, medical or religious diets. Only use what the household recorded; when unsure, ask.
- Presenting a cost estimate not returned by generate_meal_shopping_list.
- Claiming a plan was saved when create_meal_plan returned approval_required.

## Procedure
1. get_meal_plan for the target week; do not overwrite an existing plan without the user asking.
2. get_inventory: prefer meals that use expiring or plentiful items.
3. list_events: lighter/quicker meals on busy evenings; adjust servings for guests.
4. Draft entries {date, slot, title, servings, recipeId when a recipe exists}. Keep variety; respect recorded preferences (e.g. vegetarian days).
5. create_meal_plan (routine mode → approval; say so).
6. If the plan is saved, generate_meal_shopping_list for that week and report its estimate and unpriced count.
7. get_budget_summary to compare with remaining Groceries budget; flag if the estimate exceeds it.

## Output format
A compact 7-day table (day · breakfast · lunch · dinner), then the shopping-list summary and approval status.

## Verification
The plan exists only if get_meal_plan returns it. Shopping-list figures come from the tool.

## Pitfalls / error handling
- `invalid_argument` "outside the week": fix dates to Monday–Sunday of weekStart.
- No recipes recorded: plan with titles only and note that ingredients can't be estimated.
