# Venue stock round (Burleigh)

Georgia's non-food stock count. Built in **tarte-kitchen**, not this repo. Recorded here because both Chloe and Georgia pull this one.

## Don't rebuild what TK already has

Checked 2026-08-30:

| Already exists | Where |
|---|---|
| Countable items with par levels | `PrepStockItem` |
| Phone count sheet, saves as you go, priority ranking | `RestockSheet`, `RestockLine`, `/kitchen/restock/count` |
| Valued stocktake against costed ingredients | `Stocktake`, `StocktakeItem`, `/stocktake` |
| Broken-things log with assets and contacts | `MaintenanceAsset`, `MaintenanceIssue`, `/kitchen/fix` |

The kitchen count flow is the pattern to copy, not the thing to extend.

## Decisions (Chloe, 2026-08-30)

1. **Separate module.** New tables, kept clear of kitchen prep.
2. **Both outputs.** A below-par list she orders from, plus the counter can flag a line as needed now.
3. **One walk, two outputs.** Ends with "anything broken?", raising a `MaintenanceIssue`.
4. **Burleigh first.** Model it venue-scoped anyway.

## Shape

- `VenueStockArea` ordered by walk route, not alphabetically.
- `VenueStockItem` with unit, par level, and `QUANTITY` or `SIGNAL` tracking.
- `VenueStockCount` and lines.
- `VenueStockSupplierMatch` maps invoice wording to items for automatic top-up.

## Rules

- Start at 15 to 20 items: crockery, plasdene, packaging, jar lids, cutlery, glass cleaner, tea towels, retail fridge.
- No par, no point. The par is what turns a count into an action.
- Weekly for consumables, monthly for crockery.
- No food or ingredients. TK models those for recipes and allergens already.
- Whoever is on shift counts. Georgia sets pars and reads the output.

## Status

Schema, migration and board actions done on `claude/venue-ops-board`. Screens and stock actions outstanding.
