// Creates an in-thread Gmail DRAFT with a hand-written body (passed on
// stdin). Used for one-off corrections/replies that a human reviews and
// sends. Never sends anything itself.
//
//   echo "body..." | docker compose exec -T inbox node dist/scripts/draft-reply.js <threadId>

import { getThread, createInThreadDraft, applyLabel } from "../google/gmail.js"
import { upsertThread } from "../db/queries.js"
import { config } from "../config.js"

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  }
  return Buffer.concat(chunks).toString("utf8")
}

async function main(): Promise<void> {
  const threadId = process.argv[2]
  if (!threadId) throw new Error("usage: draft-reply.js <threadId> < body.txt")
  const body = (await readStdin()).trim()
  if (body.length < 20) throw new Error("body too short — refusing")
  const helloMail = config().HELLO_MAILBOX
  const thread = await getThread(threadId)
  let lastCustomer
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]!
    if (!m.from.toLowerCase().includes(helloMail.toLowerCase())) {
      lastCustomer = m
      break
    }
  }
  if (!lastCustomer) throw new Error("no customer message found in thread")
  const draftId = await createInThreadDraft(
    {
      threadId,
      to: lastCustomer.from,
      subject: lastCustomer.subject,
      inReplyTo: lastCustomer.messageIdHeader ?? "",
      references: lastCustomer.references ?? lastCustomer.messageIdHeader ?? "",
    },
    body,
    helloMail,
    "Tarte Team"
  )
  await applyLabel(threadId, "Tarte / Action needed")
  await upsertThread({
    thread_id: threadId,
    last_message_id: thread.messages[thread.messages.length - 1]!.id,
    state: "drafted",
    last_action: "drafted",
    meta: {
      draftId,
      draftedAt: new Date().toISOString(),
      draftBody: body,
      manual: true,
    },
  })
  console.log(`draft ${draftId} created in thread ${threadId}`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
