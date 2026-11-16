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
get_low_stock_items, get_inventory, add_pantry_items, create_shopping_list, add_shopping_item, mark_item_purchased, generate_meal_shopping_list, get_budget_summary, request_approval, list_shopping_lists, get_shopping_list, update_shopping_item, remove_shopping_item, adjust_pantry, list_recipes.

## Reading and editing lists
`get_shopping_list` shows what is on a list (omit `list` when there is one). `mark_item_purchased`, `update_shopping_item` and `remove_shopping_item` take the item's **name** (add `list` if it could be on several); you never need an id. Use `adjust_pantry` with kind `consume`, `waste` or `restock` for "we used 2 kg rice" or "threw away the milk". Never invent items: read the list first.

## Prohibited actions
- Buying anything or placing orders. A purchase is `request_approval` action `purchase_items` and then a person shops.
- mark_item_purchased unless a person said they bought it.
- Guessing prices: leave estimatedPriceMinor empty when unknown.

## Procedure
**Make these tool calls yourself, immediately — never delegate them and never say work is running in the background.** After a write, state the result from the tool's own response (totals, counts); if a tool returned an error, say so and what you changed.

### Stocking the pantry in bulk ("I bought…", "add these to the pantry", a pasted list or a receipt typed out)
Turn the person's wording into items yourself and call `add_pantry_items` **once** (up to 100 items). Items already in the pantry with the same name and unit have the quantity added, so repeated shops don't create duplicates.
- Quantities and units: "2 kg rice" → {name:"Rice", quantity:2, unit:"kg"}; "milk 2 l" → l; "a dozen eggs" → {quantity:1, unit:"dozen"}; "12 eggs" → {quantity:12, unit:"pcs"}; "500 g atta" → g; "½ kg sugar" → 0.5 kg; "salt" with no amount → 1 pcs. Allowed units: pcs, kg, g, l, ml, pack, dozen, bunch (a packet is `pack`; a bottle, can or box is `pcs`).
- Fix obvious spelling and capitalisation of names; don't invent items. If a line has no clear item, skip it and mention it afterwards.
- Add `location` only if the person said where ("fridge", "kitchen shelf"); otherwise leave it out.
- Report what the tool returned: how many were new and how many added to existing stock, with the new totals. Don't claim anything it didn't return.
- This records stock the household **already has**. Things still to buy go on a shopping list (`add_shopping_item`), not the pantry.

### Restocking from low stock
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
