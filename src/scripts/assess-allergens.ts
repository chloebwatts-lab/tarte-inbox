// Bulk-assesses allergens for every TK ingredient that hasn't been assessed
// yet, writing confident tags to TK's "Ingredient".allergens (visible and
// editable in the TK UI) and recording coverage in inbox_allergen_assessments.
//
// Deliberately conservative: an ingredient is only tagged when its name makes
// the allergen content unambiguous (plain flour → WHEAT+GLUTEN, butter →
// MILK). Compound/branded/unclear items are recorded confident=false and left
// untagged — they show up as coverage gaps, never as "allergen free".
//
//   docker compose exec inbox node dist/scripts/assess-allergens.js [--redo]

import { anthropic, MODEL } from "../llm/client.js"
import { db } from "../db/pool.js"
import { migrate } from "../db/pool.js"

const ALLERGENS = [
  "MILK", "EGG", "FISH", "SHELLFISH", "CRUSTACEAN", "MOLLUSC", "TREE_NUT",
  "PEANUT", "WHEAT", "GLUTEN", "SOY", "SESAME", "LUPIN", "SULPHITE",
] as const

const BATCH_SIZE = 40

const SYSTEM = `You are tagging restaurant stock ingredients with the Australian mandatory food allergens they CONTAIN. You receive a JSON array of {id, name, category} and return STRICT JSON only — an array of {id, allergens: [..], confident: true|false, why: "<short>"} — one entry per input, same order.

Allergen vocabulary (use ONLY these): ${ALLERGENS.join(", ")}.

Rules:
- Tag only allergens the ingredient ITSELF contains, judged from its name/category. Wheat flour → ["WHEAT","GLUTEN"]. Butter/cream/cheese/milk → ["MILK"]. Eggs → ["EGG"]. Soy sauce → ["SOY","WHEAT","GLUTEN"]. Almonds → ["TREE_NUT"]. Wine/vinegar (wine-based) → ["SULPHITE"]. Standard couscous/pasta/bread → ["WHEAT","GLUTEN"].
- confident=true ONLY when a food professional would not need to check the label. Single-origin produce, meats, plain dairy, named grains: confident.
- confident=false for: brand names you don't recognise, compound products (sauces, stocks, pastes, mixes, marinades, "seasoning"), anything where formulations vary (e.g. stock powder may contain gluten/soy), or names too vague to judge. For confident=false, return your best-guess allergens anyway (they are stored for human review, never shown to customers).
- Fresh fruit, vegetables, herbs, plain meats, oils (except sesame/soy/nut oils), sugar, salt: allergens=[], confident=true.
- Sesame oil → ["SESAME"]. Nut oils → ["TREE_NUT"] (or ["PEANUT"]).
- When the name implies gluten-containing grain (wheat, barley, rye, spelt), include both the grain allergen (WHEAT if wheat) and GLUTEN. Oats: ["GLUTEN"] confident=false (contamination varies).`

interface Row { id: string; name: string; category: string }
interface Verdict { id: string; allergens: string[]; confident: boolean; why?: string }

async function classifyBatch(rows: Row[]): Promise<Verdict[]> {
  const r = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: JSON.stringify(rows) }],
  })
  const block = r.content[0]
  if (!block || block.type !== "text") throw new Error("no model output")
  const match = block.text.match(/\[[\s\S]*\]/)
  if (!match) throw new Error(`unparseable: ${block.text.slice(0, 120)}`)
  const parsed = JSON.parse(match[0]) as Verdict[]
  return parsed.map((v) => ({
    id: String(v.id),
    allergens: (v.allergens ?? []).filter((a): a is (typeof ALLERGENS)[number] =>
      (ALLERGENS as readonly string[]).includes(a)
    ),
    confident: v.confident === true,
    why: v.why,
  }))
}

async function main(): Promise<void> {
  await migrate()
  const redo = process.argv.includes("--redo")
  const { rows } = await db().query<Row>(
    `SELECT i.id, i.name, i.category::text AS category
       FROM "Ingredient" i
      ${redo ? "" : `LEFT JOIN inbox_allergen_assessments a ON a.ingredient_id = i.id WHERE a.ingredient_id IS NULL`}
      ORDER BY i.name`
  )
  console.log(`${rows.length} ingredient(s) to assess`)
  let confident = 0
  let unsure = 0
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const byId = new Map(batch.map((b) => [b.id, b]))
    let verdicts: Verdict[]
    try {
      verdicts = await classifyBatch(batch)
    } catch (e) {
      console.error(`batch ${i / BATCH_SIZE + 1} failed:`, e instanceof Error ? e.message : e)
      continue
    }
    for (const v of verdicts) {
      const ing = byId.get(v.id)
      if (!ing) continue
      // Tags go to TK only for confident calls — and never overwrite a
      // human-set value (human source rows are skipped above unless --redo).
      if (v.confident) {
        await db().query(
          `UPDATE "Ingredient" SET allergens = $1::"Allergen"[], "updatedAt" = now() WHERE id = $2`,
          [`{${v.allergens.join(",")}}`, v.id]
        )
        confident++
      } else {
        unsure++
      }
      await db().query(
        `INSERT INTO inbox_allergen_assessments (ingredient_id, ingredient_name, allergens, confident, rationale, source)
         VALUES ($1, $2, $3::jsonb, $4, $5, 'llm')
         ON CONFLICT (ingredient_id) DO UPDATE SET
           ingredient_name = EXCLUDED.ingredient_name,
           allergens = EXCLUDED.allergens,
           confident = EXCLUDED.confident,
           rationale = EXCLUDED.rationale,
           assessed_at = now(),
           source = 'llm'
         WHERE inbox_allergen_assessments.source != 'human'`,
        [v.id, ing.name, JSON.stringify(v.allergens), v.confident, v.why ?? null]
      )
    }
    console.log(`batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(rows.length / BATCH_SIZE)} done`)
  }
  console.log(`\nassessed: ${confident} confident (tagged in TK), ${unsure} need human review`)
  const gaps = await db().query<{ ingredient_name: string; rationale: string }>(
    `SELECT ingredient_name, rationale FROM inbox_allergen_assessments WHERE NOT confident ORDER BY ingredient_name LIMIT 40`
  )
  if (gaps.rows.length) {
    console.log(`\nFirst ${gaps.rows.length} needing human review:`)
    for (const g of gaps.rows) console.log(`  • ${g.ingredient_name} — ${g.rationale ?? ""}`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
