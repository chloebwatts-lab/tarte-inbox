// Dish-level allergen rollups from Tarte Kitchen's recipe graph
// (Dish → DishComponent → Ingredient | Preparation → PreparationItem → …).
//
// A dish's allergen line is only trustworthy when EVERY leaf ingredient has a
// confident assessment (inbox_allergen_assessments.confident). Incomplete
// dishes are marked so the drafter can refuse "free from X" claims for them.

import { db } from "../db/pool.js"

export interface DishAllergens {
  name: string
  menuCategory: string
  venue: string
  allergens: string[]
  likelyAllergens: string[] // best-guess from unverified ingredients — warn-only
  containsMeat: boolean
  containsSeafood: boolean
  totalIngredients: number
  unassessed: number // leaf ingredients without a confident assessment
}

const CACHE_TTL_MS = 10 * 60 * 1000
let cache: { at: number; rows: DishAllergens[] } | undefined

export async function dishAllergenMatrix(): Promise<DishAllergens[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows
  // Flatten each dish to its leaf ingredients, walking nested preparations
  // (bounded depth 6 — TK preps nest 2-3 levels in practice).
  const { rows } = await db().query<DishAllergens>(
    `WITH RECURSIVE leaf AS (
       SELECT dc."dishId" AS dish_id, dc."ingredientId" AS ingredient_id,
              dc."preparationId" AS preparation_id, 1 AS depth
         FROM "DishComponent" dc
       UNION ALL
       SELECT l.dish_id, pi."ingredientId", pi."subPreparationId", l.depth + 1
         FROM leaf l
         JOIN "PreparationItem" pi ON pi."preparationId" = l.preparation_id
        WHERE l.preparation_id IS NOT NULL AND l.depth < 6
     ),
     dish_ingredients AS (
       SELECT DISTINCT l.dish_id, i.id AS ingredient_id, i.allergens, i.category
         FROM leaf l
         JOIN "Ingredient" i ON i.id = l.ingredient_id
        WHERE l.ingredient_id IS NOT NULL
     )
     SELECT d.name,
            d."menuCategory"::text AS "menuCategory",
            d.venue::text AS venue,
            COALESCE(
              (SELECT array_agg(DISTINCT a ORDER BY a)
                 FROM dish_ingredients di2, unnest(di2.allergens) AS a
                WHERE di2.dish_id = d.id),
              '{}'
            ) AS allergens,
            -- Best-guess allergens from NOT-confident assessments, minus the
            -- confirmed ones. Warn-only: can add a "likely contains", never
            -- support a "free from".
            COALESCE(
              (SELECT array_agg(DISTINCT a)
                 FROM dish_ingredients di3
                 JOIN inbox_allergen_assessments aa3
                   ON aa3.ingredient_id = di3.ingredient_id AND NOT aa3.confident,
                 jsonb_array_elements_text(aa3.allergens) AS a
                WHERE di3.dish_id = d.id
                  AND a NOT IN (
                    SELECT unnest(di4.allergens)::text FROM dish_ingredients di4
                     WHERE di4.dish_id = d.id
                  )),
              '{}'
            ) AS "likelyAllergens",
            bool_or(di.category IN ('MEAT')) AS "containsMeat",
            bool_or(di.category IN ('SEAFOOD')) AS "containsSeafood",
            count(*)::int AS "totalIngredients",
            count(*) FILTER (
              WHERE aa.ingredient_id IS NULL OR NOT aa.confident
            )::int AS unassessed
       FROM "Dish" d
       JOIN dish_ingredients di ON di.dish_id = d.id
       LEFT JOIN inbox_allergen_assessments aa ON aa.ingredient_id = di.ingredient_id
      WHERE d."isActive"
      GROUP BY d.id, d.name, d."menuCategory", d.venue
      ORDER BY d."menuCategory", d.name`
  )
  cache = { at: Date.now(), rows }
  return rows
}

/** Compact text block for the drafter prompt. */
export function renderAllergenMatrix(rows: DishAllergens[]): string {
  const lines: string[] = []
  let lastCat = ""
  for (const r of rows) {
    if (r.menuCategory !== lastCat) {
      lines.push(`\n[${r.menuCategory}]`)
      lastCat = r.menuCategory
    }
    const flags: string[] = []
    if (r.allergens.length) flags.push(`contains: ${r.allergens.join(", ")}`)
    else flags.push("no allergens tagged")
    if (r.likelyAllergens.length)
      flags.push(`likely also: ${r.likelyAllergens.join(", ")}`)
    if (r.containsMeat) flags.push("meat")
    if (r.containsSeafood) flags.push("seafood")
    const verified = r.unassessed === 0
    lines.push(
      `  ${r.name}${r.venue !== "BOTH" ? ` (${r.venue.toLowerCase().replace("_", " ")})` : ""} — ${flags.join("; ")}${verified ? "" : ` [UNVERIFIED — ${r.unassessed}/${r.totalIngredients} ingredients unchecked]`}`
    )
  }
  return lines.join("\n")
}

const DIETARY_PATTERN =
  /allerg|gluten|coeliac|celiac|dairy|lactose|vegan|vegetarian|pescatarian|halal|kosher|\bnut[s\s-]|peanut|shellfish|seafood allerg|intoleran|egg[\s-]?free|soy|sesame|dietary|fodmap|anaphyla/i

export function mentionsDietary(text: string): boolean {
  return DIETARY_PATTERN.test(text)
}

/**
 * When the text touches allergens/dietaries, returns the dish-allergen
 * matrix + strict answering rules for the drafter. Empty string otherwise.
 * Fails soft: a TK query error must never stop a reply being drafted.
 */
export async function maybeAllergenBlock(text: string): Promise<string> {
  if (!mentionsDietary(text)) return ""
  try {
    const matrix = await dishAllergenMatrix()
    if (!matrix.length) return ""
    return (
      `Menu allergen data from our kitchen system (internal — never mention the system itself):\n` +
      renderAllergenMatrix(matrix) +
      `\n\n` +
      ALLERGEN_DRAFTING_RULES
    )
  } catch (e) {
    console.error(
      "[allergens] matrix unavailable:",
      e instanceof Error ? e.message : e
    )
    return ""
  }
}

/** Drafting rules that ride along with the matrix. */
export const ALLERGEN_DRAFTING_RULES = `Allergen answering rules (CRITICAL — food safety):
- The menu data above is the ONLY source of truth. Never answer an allergen/dietary question from general knowledge.
- You may say an item CONTAINS an allergen whenever it's tagged above. "likely also" allergens may be used to warn someone OFF an item ("the bun likely contains gluten, so best avoided") but never to reassure.
- You may only say an item is FREE of an allergen if the item has NO [UNVERIFIED] marker and that allergen is absent from its line. If the item is [UNVERIFIED], do not make any "free from" claim for it — answer what you can for verified items and add "needs_human" to flags so a teammate confirms the rest before sending.
- Every reply that makes any allergen claim MUST include a cross-contamination caveat, e.g. "everything is made in one kitchen that handles gluten, dairy, nuts and other allergens, so we can't guarantee zero traces" — and for serious allergies invite them to mention it to staff on arrival.
- Vegan/vegetarian: "meat"/"seafood" markers above are reliable; absence of MILK/EGG tags on a verified item implies plant-based candidates, but offer these as suggestions to confirm with staff rather than guarantees.
- ALWAYS add "allergen_question" to flags when the reply touches allergens or dietaries (this forces human review before sending).`
