// Finds a recent sent message that has 'FUNCTIONS EVENTS PACKAGES' attached,
// downloads the PDF, and saves it to /app/attachments/functions-events-packages.pdf
// (which is bind-mounted from the host's /root/tarte-inbox/attachments/).
//
// Run on droplet:
//   docker compose exec inbox node dist/scripts/download-pack.js

import { google, type gmail_v1 } from "googleapis"
import { ensureGoogleAuthed } from "../google/oauth.js"
import { writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

const OUT_PATH = "/app/attachments/functions-events-packages.pdf"
const QUERY = 'in:sent has:attachment filename:pdf subject:(function OR event OR high tea)'
const FILENAME_HINT = /function/i

function findAttachmentId(payload: gmail_v1.Schema$MessagePart | undefined): {
  attachmentId: string
  filename: string
} | null {
  if (!payload) return null
  const walk = (
    p: gmail_v1.Schema$MessagePart
  ): { attachmentId: string; filename: string } | null => {
    if (
      p.filename &&
      FILENAME_HINT.test(p.filename) &&
      p.filename.toLowerCase().endsWith(".pdf") &&
      p.body?.attachmentId
    ) {
      return { attachmentId: p.body.attachmentId, filename: p.filename }
    }
    for (const sub of p.parts ?? []) {
      const found = walk(sub)
      if (found) return found
    }
    return null
  }
  return walk(payload)
}

async function main(): Promise<void> {
  const auth = await ensureGoogleAuthed()
  const gmail = google.gmail({ version: "v1", auth })

  // Search for a recent sent message likely to contain the function pack
  const r = await gmail.users.messages.list({
    userId: "me",
    q: QUERY,
    maxResults: 50,
  })
  const ids = (r.data.messages ?? []).map((m) => m.id!).filter(Boolean)
  console.log(`[download] scanning ${ids.length} candidate messages...`)

  for (const id of ids) {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "full",
    })
    const found = findAttachmentId(msg.data.payload ?? undefined)
    if (!found) continue
    console.log(`[download] found "${found.filename}" in message ${id}`)
    const att = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId: id,
      id: found.attachmentId,
    })
    if (!att.data.data) {
      console.warn("[download] empty attachment body, skipping")
      continue
    }
    const buf = Buffer.from(att.data.data, "base64url")
    await mkdir(dirname(OUT_PATH), { recursive: true })
    await writeFile(OUT_PATH, buf)
    console.log(`[download] saved ${buf.length} bytes to ${OUT_PATH}`)
    return
  }
  console.error("[download] no matching attachment found")
  process.exit(1)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
