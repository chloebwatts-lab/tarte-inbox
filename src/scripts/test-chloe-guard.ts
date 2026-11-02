// Guard: proves the chloe@ Gmail client is read-only by construction and that
// nothing in the hello@ pipeline references it. Runs against the compiled
// output, so it checks what actually ships in the container.
//
//   npm run test:chloe-guard              (local, builds first)
//   docker exec tarte-inbox-inbox-1 node /app/dist/scripts/test-chloe-guard.js
//
// Exit 0 with a JSON summary on success, exit 1 with the failing checks.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import * as chloe from "../google/chloe-mail.js"

// Files that may mention the chloe@ connection. Anything else that does is a
// leak into the hello@ side.
const ALLOWED = new Set([
  "google/chloe-mail.js",
  "server.js",
  "db/queries.js",
  "scripts/chloe-mail.js",
  "scripts/test-chloe-guard.js",
])
// The chloe@ module itself must never pull in the hello@ client or anything
// that acts on mail.
const FORBIDDEN_IMPORTS_IN_CHLOE = [
  "google/gmail.js",
  "google/oauth.js",
  "pipeline.js",
  "scheduler.js",
  "digest.js",
  "health.js",
  "followups.js",
  "llm/",
  "invoice/",
  "xero/",
]
const WRITE_VERB = /^(send|draft|create|insert|update|modify|label|unlabel|trash|untrash|delete|remove|archive|mark|apply|move|batch|set|put|post|patch)/i
const WRITE_API = /\.users\.(drafts|labels|settings)\b|messages\.(send|insert|modify|trash|untrash|delete|batchModify|batchDelete|import)\b|threads\.(modify|trash|untrash|delete)\b/

const dist = join(dirname(fileURLToPath(import.meta.url)), "..")

function listJs(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...listJs(p))
    else if (name.endsWith(".js")) out.push(p)
  }
  return out
}

const failures: string[] = []
const passes: string[] = []
function check(name: string, ok: boolean, detail = ""): void {
  ;(ok ? passes : failures).push(detail ? `${name}: ${detail}` : name)
}

// 1. Scope is exactly gmail.readonly.
check(
  "scope list is only gmail.readonly",
  chloe.CHLOE_SCOPES.length === 1 && chloe.CHLOE_SCOPES[0] === "https://www.googleapis.com/auth/gmail.readonly",
  chloe.CHLOE_SCOPES.join(" ")
)

// 2. The scope assertion rejects every write scope and accepts the read one.
const rejects = [
  "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.readonly https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.modify",
  "",
  null,
]
for (const s of rejects) {
  let threw = false
  try {
    chloe.assertReadOnlyScope(s)
  } catch {
    threw = true
  }
  check(`assertReadOnlyScope rejects "${s ?? "null"}"`, threw)
}
let acceptOk = true
try {
  chloe.assertReadOnlyScope("https://www.googleapis.com/auth/gmail.readonly")
  chloe.assertReadOnlyScope("openid email https://www.googleapis.com/auth/gmail.readonly")
} catch {
  acceptOk = false
}
check("assertReadOnlyScope accepts gmail.readonly", acceptOk)

// 3. The module exports no function whose name reads like a write.
const exported = Object.keys(chloe).filter((k) => typeof (chloe as Record<string, unknown>)[k] === "function")
const writeNamed = exported.filter((k) => WRITE_VERB.test(k))
check("chloe-mail exports no write-named function", writeNamed.length === 0, exported.join(", "))

// 4. Compiled chloe-mail.js never calls a Gmail write endpoint and never
//    imports the hello@ side.
const chloeSrc = readFileSync(join(dist, "google", "chloe-mail.js"), "utf8")
check("chloe-mail.js calls no Gmail write API", !WRITE_API.test(chloeSrc))
for (const f of FORBIDDEN_IMPORTS_IN_CHLOE) {
  check(`chloe-mail.js does not import ${f}`, !new RegExp(`from\\s+["'][^"']*${f.replace(".", "\\.")}`).test(chloeSrc))
}

// 5. Nothing outside the allow list references the chloe@ module or its
//    token provider key.
const leaks: string[] = []
for (const file of listJs(dist)) {
  const rel = relative(dist, file).split("\\").join("/")
  if (ALLOWED.has(rel)) continue
  const src = readFileSync(file, "utf8")
  if (/chloe-mail\.js|gmail_chloe/.test(src)) leaks.push(rel)
}
check("no pipeline file references chloe-mail or gmail_chloe", leaks.length === 0, leaks.join(", "))

// 6. The hello@ pipeline, scheduler, health and digest exist and are clean
//    (belt and braces: fail loudly if the layout changed under us).
for (const core of ["pipeline.js", "scheduler.js", "health.js", "digest.js", "google/gmail.js", "google/oauth.js"]) {
  let src = ""
  try {
    src = readFileSync(join(dist, core), "utf8")
  } catch {
    check(`${core} present`, false)
    continue
  }
  check(`${core} does not touch chloe@`, !/chloe-mail|gmail_chloe|CHLOE_/.test(src))
}

// 7. server.js imports only the consent + status surface of the module, so
//    no mail read is reachable over HTTP.
const SERVER_MAY_IMPORT = new Set(["chloeAuthUrl", "exchangeChloeCode", "chloeStatus", "CHLOE_OAUTH_STATE", "CHLOE_START_PATH"])
const serverSrc = readFileSync(join(dist, "server.js"), "utf8")
const importBlock = serverSrc.match(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*chloe-mail\.js["']/)
const importedNames = (importBlock?.[1] ?? "")
  .split(",")
  .map((n) => n.trim().split(/\s+as\s+/)[0] ?? "")
  .filter(Boolean)
const badImports = importedNames.filter((n) => !SERVER_MAY_IMPORT.has(n))
check("server.js imports only consent/status from chloe-mail", importBlock !== null && badImports.length === 0, badImports.join(", ") || importedNames.join(", "))
check("server.js has no namespace import of chloe-mail", !/import\s*\*\s*as\s+\w+\s+from\s*["'][^"']*chloe-mail\.js/.test(serverSrc))

const summary = { ok: failures.length === 0, passed: passes.length, failed: failures }
process.stdout.write(JSON.stringify(summary, null, 2) + "\n")
process.exit(failures.length ? 1 : 0)
