// Read-only Gmail CLI for chloe@tarte.com.au, for Claude bookkeeper (CBK)
// sessions only. Prints JSON to stdout. There is no write command and the
// module it calls (google/chloe-mail.ts) has no write functions.
//
//   docker exec tarte-inbox-inbox-1 node /app/dist/scripts/chloe-mail.js status
//   docker exec tarte-inbox-inbox-1 node /app/dist/scripts/chloe-mail.js search "<gmail query>" [max]
//   docker exec tarte-inbox-inbox-1 node /app/dist/scripts/chloe-mail.js thread <threadId>
//   docker exec tarte-inbox-inbox-1 node /app/dist/scripts/chloe-mail.js message <messageId>
//   docker exec tarte-inbox-inbox-1 node /app/dist/scripts/chloe-mail.js attachment <messageId> <attachmentId> /tmp/<file>
//
// outPath must be inside the container and writable by the node user (/tmp).
// Copy it out with: docker cp tarte-inbox-inbox-1:/tmp/<file> <local path>

import { writeFile } from "node:fs/promises"
import {
  chloeStatus,
  searchThreads,
  getThread,
  getMessage,
  getAttachment,
  SEARCH_MAX_LIMIT,
} from "../google/chloe-mail.js"

const USAGE = `usage:
  chloe-mail.js status
  chloe-mail.js search "<gmail query>" [max up to ${SEARCH_MAX_LIMIT}, default 10]
  chloe-mail.js thread <threadId>
  chloe-mail.js message <messageId>
  chloe-mail.js attachment <messageId> <attachmentId> <outPath inside container, e.g. /tmp/x.pdf>`

async function main(): Promise<unknown> {
  const [cmd, a, b, c] = process.argv.slice(2)
  switch (cmd) {
    case "status":
      return chloeStatus()
    case "search": {
      if (!a) throw new Error(USAGE)
      const max = b ? Number(b) : 10
      if (!Number.isFinite(max) || max < 1) throw new Error(USAGE)
      return searchThreads(a, max)
    }
    case "thread":
      if (!a) throw new Error(USAGE)
      return getThread(a)
    case "message":
      if (!a) throw new Error(USAGE)
      return getMessage(a)
    case "attachment": {
      if (!a || !b || !c) throw new Error(USAGE)
      const buf = await getAttachment(a, b)
      await writeFile(c, buf)
      return { saved: c, bytes: buf.length }
    }
    default:
      throw new Error(USAGE)
  }
}

main()
  .then((r) => {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n")
    process.exit(0)
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
