// Loads the staff handover sheets (the Functions knowledge base, the Manager
// Starter Pack) into inbox_knowledge, so every hello@ draft and the fact-checker can
// use them. Input is the JSON the xlsx converter writes: a list of
// { id, source, category, venue, question, keywords, answer, status }.
// Rows from the same source that are missing from the file are switched off.
//   node dist/scripts/import-knowledge.js /path/knowledge-import.json [--dry-run]

import { readFileSync } from "node:fs"
import { db, migrate } from "../db/pool.js"

interface Row {
  id: string
  source: string
  category?: string
  venue?: string
  question: string
  keywords?: string
  answer: string
  status: string
}

async function main(): Promise<void> {
  const [path, flag] = process.argv.slice(2)
  if (!path) throw new Error("usage: import-knowledge.js <file.json> [--dry-run]")
  const rows = JSON.parse(readFileSync(path, "utf8")) as Row[]
  const valid = rows.filter((r) => r.id && r.source && r.question?.trim() && r.answer?.trim())
  const bySource = new Map<string, string[]>()
  for (const r of valid) bySource.set(r.source, [...(bySource.get(r.source) ?? []), r.id])
  console.log(`${valid.length} rows from ${[...bySource.keys()].join(", ")}`)
  if (flag === "--dry-run") return
  await migrate()
  for (const r of valid) {
    await db().query(
      `INSERT INTO inbox_knowledge (id, source, category, venue, question, keywords, answer, status, active, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,now())
       ON CONFLICT (id) DO UPDATE SET source=$2, category=$3, venue=$4, question=$5, keywords=$6,
         answer=$7, status=$8, active=true, updated_at=now()`,
      [r.id, r.source, r.category ?? null, r.venue ?? null, r.question.trim(), r.keywords ?? null,
       r.answer.trim(), ["confirmed", "draft", "check"].includes(r.status) ? r.status : "draft"]
    )
  }
  for (const [source, ids] of bySource) {
    const off = await db().query(
      `UPDATE inbox_knowledge SET active=false, updated_at=now() WHERE source=$1 AND active AND NOT (id = ANY($2::text[]))`,
      [source, ids]
    )
    if (off.rowCount) console.log(`${source}: switched off ${off.rowCount} rows no longer in the sheet`)
  }
  const n = await db().query(`SELECT source, status, count(*)::int n FROM inbox_knowledge WHERE active GROUP BY 1,2 ORDER BY 1,2`)
  console.table(n.rows)
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
  .finally(() => db().end())
