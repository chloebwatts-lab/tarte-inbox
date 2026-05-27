import { Pool } from "pg"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { config } from "../config.js"

let pool: Pool | undefined

export function db(): Pool {
  if (pool) return pool
  pool = new Pool({ connectionString: config().DATABASE_URL })
  return pool
}

export async function migrate(): Promise<void> {
  const dir = dirname(fileURLToPath(import.meta.url))
  const sql = readFileSync(join(dir, "schema.sql"), "utf8")
  await db().query(sql)
  console.log("[db] schema applied")
}
