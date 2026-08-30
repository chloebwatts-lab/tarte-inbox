# Venue stock round (Burleigh) — build spec for tarte-kitchen

Georgia's non-food stock count, to be built in the **tarte-kitchen** repo, not this one.
Recorded here because this repo is the one both Chloe and Georgia already pull.

## The point of it

Georgia's feedback: *"I feel like I'm the only one noticing things and taking action... if I don't do it, it won't get done."* The list of what to notice currently exists only in her head. A count screen is that list, written down, so the round can be done by whoever is on shift. She stops being the sensor and becomes the person who reads the output.

So: **whoever is on shift walks and counts. Georgia sets the pars and reads the below-par list.** This must not become another job for her.

## Do not rebuild what TK already has

Checked 2026-08-30 against `chloebwatts-lab/tarte-kitchen`:

| Already exists | Where |
|---|---|
| Countable-item catalogue with par levels | `PrepStockItem` |
| Phone count sheet, saves as you go, priority ranking, supply/shortfall loop | `RestockSheet`, `RestockLine`, `/kitchen/restock/count` |
| Valued stocktake against costed ingredients | `Stocktake`, `StocktakeItem`, `/stocktake` |
| Broken-things log with assets, issues, contacts | `MaintenanceAsset`, `MaintenanceIssue`, `/kitchen/fix`, `/maintenance` |

The kitchen count flow is the closest relative and is the pattern to copy. It is **not** the thing to extend (decision below).

## Decisions (Chloe, 2026-08-30)

1. **Separate module.** New tables and screens, kept clear of kitchen prep, so chefs' sheets and Georgia's round never mix. Copy the `/kitchen/restock` patterns rather than sharing its tables.
2. **Both outputs.** A count produces a below-par list Georgia orders from, *and* lets the counter flag a line as needed now.
3. **One walk, two outputs.** The round ends with "anything broken?", raising a `MaintenanceIssue` in the existing module. This is the half of Georgia's message that is about noticing, not stock.
4. **Burleigh only** for v1. Model it venue-scoped anyway; the `Venue` enum already carries BURLEIGH, BEACH_HOUSE, TEA_GARDEN.

## Shape

- `VenueStockArea` — venue, name, sortOrder, isActive. **Ordered by walk route, not alphabetically.** This is the single thing that decides whether the round gets done twice.
- `VenueStockItem` — area, name, unit, parLevel, sortOrder, notes, isActive.
- `VenueStockCount` — venue, date, status, countedBy, submittedAt, notes.
- `VenueStockCountLine` — count, item, onHand, requested, note.

Screens: a phone count grouped by area in walk order; a below-par screen for Georgia; an items/pars admin for Georgia; the maintenance hand-off at the end of the walk.

## Scope rules

- **Start at 15 to 20 items**, the ones actually named: crockery and plates, plasdene, packaging, jar lids, cutlery, glass cleaner, tea towels, retail fridge lines. Full inventories die in month two.
- **A count without a par is just data entry.** The par is what turns a number into an action. Do not ship without it.
- **Weekly for consumables, monthly for crockery.** Crockery counts are really breakage tracking, a different question on a different rhythm.
- **Keep food and ingredients out.** TK already models `Ingredient` for recipes and allergens; hanging purchasing levels off that is a much larger job that would stall the useful part.

## Status

Spec agreed, not yet built. Blocked on `tarte-kitchen` push access for the session doing the work.
