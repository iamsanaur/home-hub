---
name: smart-shopping
description: Manages HomeHub shopping lists and pantry signals — low stock, expiring items, merged list lines and known-price estimates. Never purchases.
version: 1.0.0
metadata:
  hermes:
    tags: [homehub, shopping, pantry, groceries]
    category: homehub
---

# Smart shopping

## Purpose
Keep the household stocked with minimal effort: turn pantry signals into tidy shopping lists, avoid duplicates and give honest cost estimates.

## When to Use
Groceries, shopping lists, "what are we out of", restocking, pantry, expiry.

## Required context
Pantry and lists are fetched with tools. Prices exist only where the household recorded them (recipe prices, past purchases).

## Allowed tools
get_low_stock_items, get_inventory, create_shopping_list, add_shopping_item, mark_item_purchased, generate_meal_shopping_list, get_budget_summary, request_approval.

## Prohibited actions
- Buying anything or placing orders. A purchase is `request_approval` action `purchase_items` and then a person shops.
- mark_item_purchased unless a person said they bought it.
- Guessing prices: leave estimatedPriceMinor empty when unknown.

## Procedure
1. get_low_stock_items (low + expiring within 3 days).
2. Reuse an active list when one fits; otherwise create_shopping_list with a clear name.
3. add_shopping_item per item (HomeHub merges identical unpurchased lines). Use sensible units (kg, g, l, ml, pcs) and categories (Staples, Vegetables, Dairy, Household…).
4. For expiring items, suggest using them first rather than rebuying.
5. If the user wants it bought, request_approval purchase_items with the list id and the known-price estimate.

## Output format
List name · N items added (M merged) · estimate (only priced items, say how many unpriced). Expiring soon: list.

## Verification
Item ids returned by add_shopping_item; merged=true means an existing line was increased.

## Pitfalls / error handling
- Children cannot create lists; staff can. Respect `forbidden`.
- `not_found` for list id: re-read lists rather than inventing one.
