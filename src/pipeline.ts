// Per-thread orchestration. Called by the scheduler for each unread inbox thread.

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  getThread,
  listInboxThreads,
  applyLabel,
  removeLabel,
  archiveThread,
  deleteThreadDrafts,
  createInThreadDraft,
  createStandaloneDraft,
  sendInThreadReply,
  findOurSentReply,
  createForwardDraft,
  sendForward,
  mimeTypeFor,
  type Attachment,
  type ParsedThread,
  type ParsedMessage,
} from "./google/gmail.js"
import { isSlotFree, createEvent, type Venue } from "./google/calendar.js"
import {
  fetchCustomerHistory,
  renderCustomerHistory,
} from "./google/customer-history.js"
import {
  nbiBookingsForDate,
  nbiBookingsForEmail,
  nbiOverlapCount,
} from "./nbi/ingest.js"
import {
  findOrCreateContact,
  createAuthorisedInvoice,
  getInvoiceOnlineUrl,
} from "./xero/client.js"
import {
  invoiceConfigReady,
  generateDepositInvoice,
} from "./invoice/generate.js"
import {
  extractInvoiceDetails,
  invoiceableNow,
  buildInvoiceFromExtraction,
} from "./invoice/from-thread.js"
import { db } from "./db/pool.js"
import {
  classify,
  CATEGORY_LABELS,
  type Category,
} from "./llm/classifier.js"
import { draft, type DraftResult } from "./llm/drafter.js"
import { extractBooking } from "./llm/booking.js"
import { classifyConfirmation } from "./llm/confirmation.js"
import { dequote } from "./lib/dequote.js"
import { renderFullThread } from "./lib/thread-text.js"
import { maybeAllergenBlock } from "./tk/allergens.js"
import {
  getThread as getThreadRow,
  upsertThread,
  getPlaybook,
  insertBooking,
  getBookingByThread,
  updateBooking,
  recordLearning,
  startRun,
  finishRun,
} from "./db/queries.js"
import { config } from "./config.js"

const VENUE_BY_CATEGORY: Partial<Record<Category, Venue>> = {
  events_tea_garden_functions: "tea_garden",
  events_beach_house_functions: "beach_house",
  events_tea_garden_high_tea: "tea_garden",
}

const MAX_SLOTS_PROPOSED = 3
const SLOT_DURATION_DEFAULT_HOURS = 3
const FUNCTION_DEPOSIT_AUD = 500
// Deposit invoices BCC accounts + Shawna when sent (Shawna 2026-06-15).
// NOTE: confirm accounts@ address — Chris wrote "accounts@tarte.com"; using
// the .com.au business domain. Update if the .com address is correct.
const INVOICE_BCC = ["shawna@tarte.com.au", "accounts@tarte.com.au"]
const BALANCE_DAYS_BEFORE_EVENT = 14

// Triage labels — the staff work surface. The deal: anything needing a human
// carries ACTION_LABEL (and URGENT_LABEL when hot); everything the agent
// fully handled is archived out of the inbox with its category label intact.
export const ACTION_LABEL = "Tarte / Action needed"
export const URGENT_LABEL = "Tarte / URGENT"
export const AUTO_HANDLED_LABEL = "Tarte / Auto-handled"

// Only archive LLM-classified noise when the classifier is sure. Regex-matched
// noreply receipts archive unconditionally.
const ARCHIVE_CONFIDENCE_MIN = 0.75

// --- entry ---

export async function runTick(): Promise<{ seen: number; acted: number }> {
  const runId = await startRun()
  let seen = 0
  let acted = 0
  try {
    const ids = await listInboxThreads()
    seen = ids.length
    for (const id of ids) {
      try {
        const acted_ = await processThread(id)
        if (acted_) acted++
      } catch (e) {
        console.error(`[pipeline] thread ${id} failed:`, e)
      }
    }
    await finishRun(runId, { threads_seen: seen, threads_acted: acted })
  } catch (e) {
    await finishRun(runId, {
      threads_seen: seen,
      threads_acted: acted,
      error: e instanceof Error ? e.message : String(e),
    })
    throw e
  }
  return { seen, acted }
}

const HANDOFF_ADDRESSES = ["shawna@tarte.com.au"] // forwards to these = humans will handle, agent backs off

function threadHandedOff(thread: ParsedThread): boolean {
  // True if any message in the thread has a handoff address in To/Cc.
  // Pattern: customer emails hello@, someone forwards to shawna@, agent backs off.
  return thread.messages.some((m) => {
    const recipients = [...m.to, ...m.cc].map((r) => r.toLowerCase())
    return recipients.some((r) =>
      HANDOFF_ADDRESSES.some((h) => r.includes(h))
    )
  })
}

// Senders we should never reply to. Mostly automated notification systems
// (order confirmations, invoice receipts, system alerts) where a reply
// either goes to /dev/null or back into a ticketing system.
const NOREPLY_SENDER_PATTERNS = [
  /noreply@/i,
  /no-reply@/i,
  /no_reply@/i,
  /notifications?@/i,
  /donotreply@/i,
  /do-not-reply@/i,
  /mailer@/i,
  /mailer-daemon@/i,
  /postmaster@/i,
  /bounce/i,
  /@ordermentum\.com/i, // supplier ordering platform, automated only
  /@nowbookit\.com/i, // booking confirmations, automated only
  /alerts?@/i,
  /automated@/i,
  /system@/i,
]

// Receipt-style subjects that almost never need a human reply. Targets
// orders@-style supplier addresses that aren't strictly "noreply" but
// still send templated confirmations / invoices.
const RECEIPT_SUBJECT_PATTERNS = [
  /\border confirmation\b/i,
  /\bdelivery confirmation\b/i,
  /\btax invoice\b/i,
  /\bstatement of account\b/i,
  /\breceipt\b/i,
  /\bpayment received\b/i,
  /\bpayment processed\b/i,
  /\binvoice #?\d/i, // "Invoice 12345"
  /^quote #?\d/i,
]

function isAutomatedReceipt(from: string, subject: string): boolean {
  const lowerFrom = from.toLowerCase()
  if (NOREPLY_SENDER_PATTERNS.some((p) => p.test(lowerFrom))) return true
  // Receipt subject + a transactional sender prefix (orders@, billing@, etc.).
  // Deliberately excludes info@/support@/service@ — those are commonly human
  // and a real "Question about invoice #123" from one must not be archived.
  const transactionalSender = /(?:^|<)(orders?|billing|accounts?|invoices?|sales|admin)@/i
  if (
    transactionalSender.test(lowerFrom) &&
    RECEIPT_SUBJECT_PATTERNS.some((p) => p.test(subject))
  ) {
    return true
  }
  return false
}

// --- website contact-form submissions ---
// Squarespace/Wix/Jotform/etc. relay form submissions FROM their own address
// (e.g. form-submission@squarespace.info) with the real customer's email
// buried in the body ("Email: jane@x.com"). Replying to latest.from would
// reach the relay, never the customer — so we parse out the real person and
// reply to THEM in a fresh email.

interface FormSubmission {
  name: string | null
  email: string
  subject: string
  message: string
  interestedIn: string | null
}

const FORM_RELAY_FROM = /squarespace\.info|@(?:wix|jotform|wufoo|typeform|formspree|hubspot)\.com|form-?submission/i

function field(body: string, label: string): string | null {
  const m = body.match(new RegExp(`^\\s*${label}\\s*:?\\s*(.+)$`, "im"))
  return m ? m[1]!.trim() : null
}

export function parseFormSubmission(latest: ParsedMessage): FormSubmission | null {
  const body = latest.bodyText
  const looksLikeForm =
    FORM_RELAY_FROM.test(latest.from) ||
    /sent via form submission/i.test(body) ||
    (/^\s*Name\s*:/im.test(body) &&
      /^\s*Email\s*:/im.test(body) &&
      /^\s*Message\s*:/im.test(body))
  if (!looksLikeForm) return null

  // Real customer email: prefer the "Email:" field, else first address in
  // the body that isn't ours or the relay.
  const emailField = field(body, "Email")
  let email = emailField?.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0] ?? null
  if (!email) {
    const helloMail = config().HELLO_MAILBOX.toLowerCase()
    const all = body.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? []
    email =
      all.find(
        (a) =>
          !a.toLowerCase().includes(helloMail) &&
          !FORM_RELAY_FROM.test(a) &&
          !/squarespace|wixpress|noreply/i.test(a)
      ) ?? null
  }
  if (!email) return null

  // The message often spans multiple lines. Walk lines: start at "Message:",
  // collect until a line that begins another known field or relay footer.
  // (A single multiline regex with /m mis-terminates on the first line end.)
  const TERMINATORS =
    /^\s*(?:Interested in|Phone|Create Invoice|Manage Submissions|Does this submission|Sent via|Report it)\b/i
  const lines = body.split(/\r?\n/)
  const startIdx = lines.findIndex((l) => /^\s*Message\s*:/i.test(l))
  let message: string
  if (startIdx >= 0) {
    const collected: string[] = [
      lines[startIdx]!.replace(/^\s*Message\s*:?\s*/i, ""),
    ]
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (TERMINATORS.test(lines[i]!)) break
      collected.push(lines[i]!)
    }
    message = collected.join("\n").trim()
  } else {
    message = body.trim()
  }

  return {
    name: field(body, "Name"),
    email,
    subject: field(body, "Subject") || latest.subject.replace(/^Form Submission[ -]*/i, "").trim() || "your enquiry",
    message,
    interestedIn: field(body, "Interested in"),
  }
}

function firstNameFromFullName(name: string | null): string | undefined {
  if (!name) return undefined
  const first = name.trim().split(/\s+/)[0]
  return first && /^[A-Za-z][A-Za-z'-]*$/.test(first) ? first : undefined
}

/**
 * Handle a parsed website form submission: classify the real message, draft
 * a reply, and create it as a fresh draft TO THE CUSTOMER (not the relay).
 * Always flagged for human review — the recipient was rewritten, so a person
 * sanity-checks it before sending. Never auto-sends.
 */
async function handleFormSubmission(
  thread: ParsedThread,
  latest: ParsedMessage,
  form: FormSubmission
): Promise<boolean> {
  const result = await classify(form.subject, form.email, form.message)
  await applyLabel(thread.threadId, CATEGORY_LABELS[result.category])

  // Forward-only categories (e.g. job applications → work@): while auto-send
  // is off, DON'T create a forward draft (they pile up disconnected and never
  // send). Just label so staff see it in the inbox + digest.
  const fwdPlaybook = await getPlaybook(result.category)
  if (fwdPlaybook?.forward_to) {
    await applyLabel(thread.threadId, ACTION_LABEL)
    await upsertThread({
      thread_id: thread.threadId,
      last_message_id: latest.id,
      state: "classified",
      last_action: "labeled",
      meta: {
        formSubmission: true,
        formEmail: form.email,
        forwardTo: fwdPlaybook.forward_to,
        forwardSuppressed: true,
      },
    })
    return true
  }

  // Urgent / no-draft categories: flag, don't draft.
  if (result.category === "urgent_escalation") {
    await applyLabel(thread.threadId, URGENT_LABEL)
    await applyLabel(thread.threadId, ACTION_LABEL)
    await upsertThread({
      thread_id: thread.threadId,
      last_message_id: latest.id,
      state: "urgent",
      last_action: "flagged_urgent",
      meta: { formEmail: form.email, formName: form.name },
    })
    return true
  }
  if (
    result.category === "needs_human" ||
    result.category === "accounts_invoices" ||
    result.category === "marketing_cold_outreach" ||
    result.category === "no_action"
  ) {
    await applyLabel(thread.threadId, ACTION_LABEL)
    await upsertThread({
      thread_id: thread.threadId,
      last_message_id: latest.id,
      state: "classified",
      last_action: "labeled",
      meta: { formEmail: form.email, formName: form.name, formSubmission: true },
    })
    return true
  }

  const playbook = await getPlaybook(result.category)
  const allergenBlock = await maybeAllergenBlock(form.subject + "\n" + form.message)
  // Cross-chain context: this form may be from a customer already mid-thread
  // elsewhere — pull their other threads so we give consistent, true answers.
  const formHistory = await fetchCustomerHistory(form.email, thread.threadId)
  const formHistoryBlock = renderCustomerHistory(formHistory)
  const extras: Array<{ role: "user" | "assistant"; content: string }> = [
    {
      role: "user",
      content:
        `This enquiry arrived through our WEBSITE CONTACT FORM. Reply to the customer (${form.name ?? form.email}) directly and naturally — do not mention forms, Squarespace, or how it reached us.` +
        (form.interestedIn ? ` They selected interest: "${form.interestedIn}".` : ""),
    },
  ]
  if (formHistoryBlock) extras.push({ role: "user", content: formHistoryBlock })
  if (allergenBlock) extras.push({ role: "user", content: allergenBlock })

  const d = await draft({
    category: result.category,
    playbook,
    threadHistory: [
      { from: `${form.name ?? "Customer"} <${form.email}>`, date: latest.date, text: form.message },
    ],
    customerName: firstNameFromFullName(form.name),
    customExtras: extras,
  })
  if (!d.body) return await flagDraftFailure(thread, latest, result.category)

  // ALWAYS attach the functions pack on a function/event reply, even via the
  // website-form path (Shawna 2026-06-15) — customers should see the options.
  const formAttachments =
    playbook?.default_attachment_paths?.length
      ? await loadAttachments(playbook.default_attachment_paths)
      : []
  const draftId = await createStandaloneDraft(
    form.email,
    form.subject,
    d.body,
    config().HELLO_MAILBOX,
    "Tarte Team",
    formAttachments
  )
  await applyLabel(thread.threadId, ACTION_LABEL)
  await upsertThread({
    thread_id: thread.threadId,
    last_message_id: latest.id,
    state: "form_drafted",
    last_action: "drafted",
    meta: {
      formSubmission: true,
      formEmail: form.email,
      formName: form.name,
      category: result.category,
      draftId,
      draftBody: d.body,
      draftedAt: new Date().toISOString(),
      flags: d.flags,
    },
  })
  console.log(`[pipeline] form submission -> standalone draft to ${form.email} (${result.category})`)
  return true
}

export async function processThread(
  threadId: string,
  opts: { force?: boolean } = {}
): Promise<boolean> {
  const thread = await getThread(threadId)
  if (!thread.messages.length) return false
  // When forced, pretend the latest customer message is the one to reply to
  // — even if our team has already replied. Used for /thread/:id/redraft so
  // we can test the agent's drafting after a prompt change without waiting
  // for new customer activity.
  let latest = thread.messages[thread.messages.length - 1]!
  if (opts.force) {
    const helloMail = config().HELLO_MAILBOX.toLowerCase()
    // Walk back to the most recent customer-authored message
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      const m = thread.messages[i]!
      if (!m.from.toLowerCase().includes(helloMail)) {
        latest = m
        break
      }
    }
  }
  const helloMail = config().HELLO_MAILBOX.toLowerCase()
  const fromUs = latest.from.toLowerCase().includes(helloMail)

  const existing = await getThreadRow(threadId)

  // Edit-capture: if the latest message is ours, and we previously drafted, log diff.
  if (fromUs && existing?.last_action === "drafted") {
    await captureEdit(thread, existing.meta)
    // Staff replied — their action item is done, clear the flag.
    await removeLabel(threadId, ACTION_LABEL).catch(() => {})
    await upsertThread({
      thread_id: threadId,
      last_message_id: latest.id,
      last_history_id: thread.historyId ?? null,
      state: "sent_by_human",
      last_action: "captured_edit",
    })
    return true
  }

  // Skip if nothing new since last time
  if (existing?.last_message_id === latest.id) return false

  // Skip if no human-facing message (e.g. fully internal/automated)
  if (fromUs) {
    // If staff replied to a thread we'd flagged for them (needs_human etc.),
    // their job is done — clear the flag and mark it handled so the digest
    // stops listing it.
    const wasFlagged =
      (existing?.state === "classified" && existing?.last_action === "labeled") ||
      existing?.state === "urgent"
    if (wasFlagged) await removeLabel(threadId, ACTION_LABEL).catch(() => {})
    await upsertThread({
      thread_id: threadId,
      last_message_id: latest.id,
      last_history_id: thread.historyId ?? null,
      state: wasFlagged ? "sent_by_human" : undefined,
      last_action: "skipped_outbound",
    })
    return false
  }

  // Website contact-form submission? The real customer is in the body, not
  // the From header — handle specially so the reply reaches the person, not
  // the form relay (Squarespace etc.).
  const form = parseFormSubmission(latest)
  if (form) {
    return await handleFormSubmission(thread, latest, form)
  }
  // Looked like a form (relay sender) but we couldn't find a customer email
  // — never reply to the relay; flag for a human.
  if (FORM_RELAY_FROM.test(latest.from)) {
    await applyLabel(threadId, ACTION_LABEL)
    await upsertThread({
      thread_id: threadId,
      last_message_id: latest.id,
      state: "classified",
      last_action: "labeled",
      meta: { formRelayUnparsed: true },
    })
    return true
  }

  // Strip quoted blocks + auto-mailer boilerplate from the latest body
  // before classifying — keeps signal clean when the customer replied into
  // a NBI confirmation or Outlook-quoted chain.
  const cleanLatestBody = dequote(latest.bodyText)

  // --- classify ---
  const result = await classify(latest.subject, latest.from, cleanLatestBody)
  const label = CATEGORY_LABELS[result.category]
  await applyLabel(threadId, label)

  await upsertThread({
    thread_id: threadId,
    last_message_id: latest.id,
    last_history_id: thread.historyId ?? null,
    category: result.category,
    confidence: result.confidence,
    state: "classified",
    last_action: "labeled",
    meta: { rationale: result.rationale },
  })

  // Handed off to a human via forward (e.g. shawna@tarte.com.au)?
  // Label only, don't draft — EXCEPT for invoicing: forwarding a "please
  // invoice" to Shawna is exactly the cue to auto-build the deposit invoice,
  // so the agent does that (as a draft for review) instead of backing off.
  if (threadHandedOff(thread)) {
    const venue = VENUE_BY_CATEGORY[result.category]
    if (
      venue &&
      invoiceConfigReady() &&
      looksLikeInvoiceStage(renderFullThread(thread.messages)) &&
      !(await threadHasInvoice(threadId))
    ) {
      try {
        if (
          await maybeAutoInvoice(
            thread,
            latest,
            venue,
            result.category,
            renderFullThread(thread.messages)
          )
        ) {
          return true
        }
      } catch (e) {
        console.error(
          "[invoice] handed-off auto-invoice failed:",
          e instanceof Error ? e.message : e
        )
      }
    }
    await upsertThread({
      thread_id: threadId,
      last_message_id: latest.id,
      state: "handed_off",
      last_action: "skipped_handoff",
    })
    return true
  }

  // Delivery failures are NOT noise: if an email we sent bounced, a customer
  // is waiting on a reply that never arrived. Flag loudly, never archive.
  if (
    /mailer-daemon|postmaster/i.test(latest.from) &&
    /deliver|undeliver|fail|return|bounce/i.test(latest.subject)
  ) {
    await applyLabel(threadId, ACTION_LABEL)
    await upsertThread({
      thread_id: threadId,
      last_message_id: latest.id,
      state: "delivery_failure",
      last_action: "flagged_bounce",
    })
    return true
  }

  // Automated notification (noreply, order confirmation, statement, etc).
  // No human at the other end — label, archive out of the inbox.
  if (isAutomatedReceipt(latest.from, latest.subject)) {
    await archiveThread(threadId)
    await upsertThread({
      thread_id: threadId,
      last_message_id: latest.id,
      state: "noreply_skipped",
      last_action: "archived_noreply",
    })
    return true
  }

  // Concluded threads and cold outreach: archive when the classifier is
  // confident. Category label stays on for audit; a new reply from the
  // sender brings the thread straight back into the inbox.
  if (
    (result.category === "no_action" ||
      result.category === "marketing_cold_outreach") &&
    result.confidence >= ARCHIVE_CONFIDENCE_MIN
  ) {
    await archiveThread(threadId)
    await upsertThread({
      thread_id: threadId,
      last_message_id: latest.id,
      state: "auto_archived",
      last_action: "archived_" + result.category,
    })
    return true
  }

  // Urgent: never drafted, never archived. Flag loudly and stop.
  if (result.category === "urgent_escalation") {
    await applyLabel(threadId, URGENT_LABEL)
    await applyLabel(threadId, ACTION_LABEL)
    await upsertThread({
      thread_id: threadId,
      last_message_id: latest.id,
      state: "urgent",
      last_action: "flagged_urgent",
    })
    return true
  }

  // --- forward-only categories (e.g. job_applications → work@) ---
  // If the playbook has a forward_to address, we forward the original
  // email to that team instead of drafting a reply to the sender.
  const earlyPlaybook = await getPlaybook(result.category)
  if (earlyPlaybook?.forward_to) {
    return await forwardThread(thread, latest, result.category, earlyPlaybook.forward_to)
  }

  // --- function-flow shortcut for events ---
  const venue = VENUE_BY_CATEGORY[result.category]
  if (venue && result.category !== "events_tea_garden_high_tea") {
    return await handleFunctionEnquiry(thread, latest, venue, result.category)
  }

  // --- label-only categories: no draft, but staff need to see them ---
  if (
    result.category === "marketing_cold_outreach" ||
    result.category === "no_action"
  ) {
    // Low-confidence noise (confident noise was archived above). Leave in
    // the inbox with its category label, no action flag.
    return true
  }
  if (result.category === "needs_human" || result.category === "accounts_invoices") {
    await applyLabel(threadId, ACTION_LABEL)
    return true
  }

  const playbook = earlyPlaybook
  const customerEmailAddr = extractEmail(latest.from)
  const history = customerEmailAddr
    ? await fetchCustomerHistory(customerEmailAddr, thread.threadId)
    : []
  const historyBlock = renderCustomerHistory(history)

  // For existing-booking emails, give the drafter the customer's actual
  // upcoming NBI reservations so the reply speaks to their booking instead
  // of asking them to repeat details. The agent can't modify NBI itself, so
  // the draft always waits for a human (who actions the change, then sends).
  const extras: Array<{ role: "user" | "assistant"; content: string }> = []
  if (historyBlock) extras.push({ role: "user", content: historyBlock })
  if (result.category === "bookings_existing" && customerEmailAddr) {
    const nbi = await nbiBookingsForEmail(customerEmailAddr)
    if (nbi.length) {
      extras.push({
        role: "user",
        content:
          `Customer's upcoming bookings on file (internal — never mention "Now Book It" or booking refs to the customer):\n` +
          nbi
            .map(
              (b) =>
                `  • ${b.booking_date} ${b.booking_time.slice(0, 5)} — ${b.service}, ${b.pax} pax, status ${b.status}` +
                (b.notes ? ` (notes: ${b.notes})` : "")
            )
            .join("\n") +
          `\nUse the matching booking's details in the reply. A teammate will action the requested change in the booking system before sending, so write as if the change is done.`,
      })
    } else {
      extras.push({
        role: "user",
        content:
          "No booking was found on file for this email address. Don't tell the customer we can't find them — write the reply naturally and a teammate will verify the booking before sending.",
      })
    }
  }

  const allergenBlock = await maybeAllergenBlock(latest.subject + "\n" + cleanLatestBody)
  if (allergenBlock) extras.push({ role: "user", content: allergenBlock })

  const d = await draft({
    category: result.category,
    playbook,
    threadHistory: thread.messages.map(toHistoryItem),
    customerName: firstName(latest.from),
    customExtras: extras.length ? extras : undefined,
  })
  if (!d.body) return await flagDraftFailure(thread, latest, result.category)

  return await deliver(thread, latest, d, result.category, playbook)
}

// --- helpers ---

function toHistoryItem(m: ParsedMessage): { from: string; date: Date; text: string } {
  // Dequote so the drafter doesn't see NBI confirmation boilerplate or
  // Outlook-quoted chain noise. Keeps the prompt focused on real content.
  // Read the WHOLE message — never lose info to truncation (Chris's rule).
  // 16k chars ~= 3000 words; covers any realistic email in full.
  return { from: m.from, date: m.date, text: dequote(m.bodyText).slice(0, 16000) }
}

function firstName(from: string): string | undefined {
  // "Jane Smith <jane@x.com>" → "Jane"; "jane@x.com" → undefined
  const nameMatch = from.match(/^([^<]+)</)
  if (!nameMatch) return undefined
  const name = nameMatch[1]!.trim().replace(/^["']|["']$/g, "")
  const first = name.split(/\s+/)[0]
  return first && /^[A-Za-z][A-Za-z'-]*$/.test(first) ? first : undefined
}

function extractEmail(from: string): string {
  const m = from.match(/<([^>]+)>/)
  return (m ? m[1] : from)!.trim().toLowerCase()
}

const ATTACHMENTS_DIR = "/app/attachments"

async function loadAttachments(paths: string[]): Promise<Attachment[]> {
  const out: Attachment[] = []
  for (const p of paths) {
    try {
      // Reject paths that escape the attachments dir
      if (p.includes("..") || p.startsWith("/")) {
        console.warn(`[attachments] skip unsafe path: ${p}`)
        continue
      }
      const full = join(ATTACHMENTS_DIR, p)
      const data = await readFile(full)
      out.push({
        filename: p.split("/").pop() ?? p,
        contentType: mimeTypeFor(p),
        data,
      })
    } catch (e) {
      console.warn(
        `[attachments] failed to load ${p}:`,
        e instanceof Error ? e.message : e
      )
    }
  }
  return out
}

function isOurFirstReply(thread: ParsedThread, helloMail: string): boolean {
  // True when none of the prior messages in the thread are from us.
  const lc = helloMail.toLowerCase()
  // Exclude the latest message (it's the incoming we're about to reply to)
  const prior = thread.messages.slice(0, -1)
  return !prior.some((m) => m.from.toLowerCase().includes(lc))
}

/**
 * Forward the latest incoming message to a target address (e.g. work@) and
 * skip drafting a reply to the original sender. Auto-sends when both
 * playbook.auto_send and ENABLE_AUTO_SEND are true; otherwise drafts.
 */
async function forwardThread(
  thread: ParsedThread,
  latest: ParsedMessage,
  category: Category,
  forwardTo: string
): Promise<boolean> {
  const helloMail = config().HELLO_MAILBOX
  const pb = await getPlaybook(category)
  const shouldAutoSend =
    config().ENABLE_AUTO_SEND && pb?.auto_send === true
  if (shouldAutoSend) {
    const sentId = await sendForward(
      latest,
      forwardTo,
      helloMail,
      "Tarte Inbox"
    )
    // Fully handled: the receiving team owns it now. Out of hello@'s inbox.
    await applyLabel(thread.threadId, AUTO_HANDLED_LABEL)
    await archiveThread(thread.threadId)
    await upsertThread({
      thread_id: thread.threadId,
      last_message_id: latest.id,
      state: "forwarded",
      last_action: "sent_forward",
      meta: { forwardTo, sentMessageId: sentId, category },
    })
    return true
  }
  // Auto-send OFF: do NOT create a forward draft. Unsent forward drafts just
  // pile up disconnected from the original thread (Shawna 2026-06-15) and the
  // receiving team never gets them anyway. Just label the thread so staff see
  // it; once auto-send is enabled, forwards actually send to the team.
  await applyLabel(thread.threadId, ACTION_LABEL)
  await upsertThread({
    thread_id: thread.threadId,
    last_message_id: latest.id,
    state: "classified",
    last_action: "labeled",
    meta: { forwardTo, category, forwardSuppressed: true },
  })
  return true
}

async function deliver(
  thread: ParsedThread,
  latest: ParsedMessage,
  d: DraftResult,
  category: Category,
  playbook: Awaited<ReturnType<typeof getPlaybook>>,
  opts: { extraAttachments?: Attachment[]; bcc?: string[] } = {}
): Promise<boolean> {
  const helloMail = config().HELLO_MAILBOX
  // Last-line guard: never address a reply to a no-reply / relay sender that
  // slipped past classification into a drafting category. Flag for a human
  // instead of creating a draft that would bounce or hit a ticket queue.
  if (NOREPLY_SENDER_PATTERNS.some((p) => p.test(latest.from))) {
    await applyLabel(thread.threadId, ACTION_LABEL).catch(() => {})
    await upsertThread({
      thread_id: thread.threadId,
      last_message_id: latest.id,
      state: "classified",
      last_action: "labeled",
      meta: { suppressedNoreplyReply: true, category },
    })
    return true
  }
  const ctx = {
    threadId: thread.threadId,
    to: latest.from,
    bcc: opts.bcc,
    subject: latest.subject,
    inReplyTo: latest.messageIdHeader ?? "",
    references: latest.references ?? latest.messageIdHeader ?? "",
  }
  // Only attach default files on our FIRST reply in the thread.
  const defaultAttachments =
    playbook?.default_attachment_paths?.length && isOurFirstReply(thread, helloMail)
      ? await loadAttachments(playbook.default_attachment_paths)
      : []
  const attachments = [...defaultAttachments, ...(opts.extraAttachments ?? [])]

  const shouldAutoSend =
    config().ENABLE_AUTO_SEND &&
    playbook?.auto_send === true &&
    d.confidence >= (playbook?.min_confidence ?? 0.95) &&
    !d.flags.includes("needs_human") &&
    !d.flags.includes("needs_floor_layout_check") &&
    // Allergen/dietary answers always get human eyes before sending, no
    // matter how trusted the category becomes.
    !d.flags.includes("allergen_question")

  if (shouldAutoSend) {
    // Sweep any superseded pending drafts so staff don't find a stale draft
    // under an already-answered thread.
    await deleteThreadDrafts(thread.threadId)
    const sentId = await sendInThreadReply(
      ctx,
      d.body,
      helloMail,
      "Tarte Team",
      attachments
    )
    // Replied in full — archive so staff never touch it. A customer reply
    // brings the thread back into the inbox automatically.
    await applyLabel(thread.threadId, AUTO_HANDLED_LABEL)
    await archiveThread(thread.threadId)
    await upsertThread({
      thread_id: thread.threadId,
      last_message_id: latest.id,
      last_history_id: thread.historyId ?? null,
      state: "auto_sent",
      last_action: "sent",
      meta: {
        sentMessageId: sentId,
        sentBody: d.body,
        draftConfidence: d.confidence,
        flags: d.flags,
        attachmentCount: attachments.length,
      },
    })
    return true
  }
  // Supersede any pending drafts we made earlier in this thread (e.g. the
  // customer followed up before staff sent one) so Gmail never accumulates
  // stale duplicates.
  await deleteThreadDrafts(thread.threadId)
  const draftId = await createInThreadDraft(
    ctx,
    d.body,
    helloMail,
    "Tarte Team",
    attachments
  )
  await applyLabel(thread.threadId, ACTION_LABEL)
  await upsertThread({
    thread_id: thread.threadId,
    last_message_id: latest.id,
    last_history_id: thread.historyId ?? null,
    state: "drafted",
    last_action: "drafted",
    meta: {
      draftId,
      draftedAt: new Date().toISOString(),
      draftBody: d.body,
      draftConfidence: d.confidence,
      flags: d.flags,
      category,
      attachmentCount: attachments.length,
    },
  })
  return true
}

/**
 * In-thread draft for a follow-up nudge (used by followups.ts). Always a
 * draft — nudges are never auto-sent — and flags the thread for staff.
 */
export async function deliverNudgeDraft(
  thread: ParsedThread,
  lastCustomer: ParsedMessage,
  body: string
): Promise<void> {
  const helloMail = config().HELLO_MAILBOX
  const draftId = await createInThreadDraft(
    {
      threadId: thread.threadId,
      to: lastCustomer.from,
      subject: lastCustomer.subject,
      inReplyTo: lastCustomer.messageIdHeader ?? "",
      references: lastCustomer.references ?? lastCustomer.messageIdHeader ?? "",
    },
    body,
    helloMail,
    "Tarte Team"
  )
  await applyLabel(thread.threadId, ACTION_LABEL)
  await upsertThread({
    thread_id: thread.threadId,
    last_message_id: thread.messages[thread.messages.length - 1]!.id,
    state: "drafted",
    last_action: "drafted",
    meta: {
      draftId,
      draftedAt: new Date().toISOString(),
      draftBody: body,
      nudge: true,
    },
  })
}

/**
 * Empty draft body (LLM hiccup / parse fail) must never leave a thread
 * silently stalled. Flag it for a human and surface it in the digest.
 */
async function flagDraftFailure(
  thread: ParsedThread,
  latest: ParsedMessage,
  category: Category
): Promise<boolean> {
  await applyLabel(thread.threadId, ACTION_LABEL).catch(() => {})
  await upsertThread({
    thread_id: thread.threadId,
    last_message_id: latest.id,
    last_history_id: thread.historyId ?? null,
    state: "draft_failed",
    last_action: "draft_failed",
    meta: { category, draftFailedAt: new Date().toISOString() },
  })
  console.warn(`[pipeline] empty draft for thread ${thread.threadId} (${category}) — flagged for human`)
  return true
}

// --- auto-invoice from a finalised thread ---

// Cheap pre-gate so we only spend an LLM extraction on threads that actually
// look like they've reached the deposit/invoice stage.
const INVOICE_STAGE_RE =
  /\binvoice|\bdeposit\b|secure (?:the|your|my|this)|lock (?:it|in|this|that)|save[- ]?the[- ]?date|final numbers|put a hold|hold (?:on|the|this|it)|confirm[^.]{0,25}(?:date|booking|numbers)/i

function looksLikeInvoiceStage(text: string): boolean {
  return INVOICE_STAGE_RE.test(text)
}

async function threadHasInvoice(threadId: string): Promise<boolean> {
  const { rows } = await db().query(
    `SELECT 1 FROM inbox_invoices WHERE thread_id = $1 AND invoice_number <> 'PENDING' LIMIT 1`,
    [threadId]
  )
  return rows.length > 0
}

/**
 * When a function thread has reached the invoicing stage with all final
 * details agreed, generate the Tarte deposit invoice from the thread and
 * draft a reply with it attached. Always flagged for human review; never
 * auto-sends. Returns false if not ready (caller continues normal flow).
 */
async function maybeAutoInvoice(
  thread: ParsedThread,
  latest: ParsedMessage,
  venue: Venue,
  category: Category,
  fullText: string
): Promise<boolean> {
  if (!invoiceConfigReady()) return false
  if (!looksLikeInvoiceStage(fullText)) return false
  if (await threadHasInvoice(thread.threadId)) return false
  const today = todayBrisbaneStr()
  const weekday = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    weekday: "long",
  }).format(new Date())
  const x = await extractInvoiceDetails(thread, today, weekday)
  if (!invoiceableNow(x)) return false

  const booking = await getBookingByThread(thread.threadId)
  const built = await buildInvoiceFromExtraction(x, {
    bookingId: booking?.id ?? null,
    threadId: thread.threadId,
    todayBrisbane: today,
  })
  const total = x.add_ons.reduce(
    (s, a) => s + a.unit_price * (a.per_person && x.guests ? x.guests : 1),
    (x.per_person_price ?? 0) * (x.guests ?? 0)
  )
  const deposit = Math.round((total * (x.deposit_pct ?? 50)) / 100 * 100) / 100
  const playbook = await getPlaybook(category)
  const dateLabel = x.event_date
    ? new Date(`${x.event_date}T00:00:00+10:00`).toLocaleDateString("en-AU", {
        timeZone: "Australia/Brisbane",
        weekday: "long",
        day: "numeric",
        month: "long",
      })
    : "the agreed date"
  const d = await draft({
    category,
    playbook,
    threadHistory: thread.messages.map(toHistoryItem),
    customerName: x.customer_name ?? firstName(latest.from),
    customExtras: [
      {
        role: "user",
        content:
          `The booking is now CONFIRMED and the deposit invoice (${built.invoiceNumber}) is ATTACHED to this email as a PDF.\n` +
          `Date: ${dateLabel}; Time: ${x.time_label ?? "as agreed"}; Guests: ${x.guests ?? "?"}; Package: ${[x.package_name, x.venue_space].filter(Boolean).join(" in ")}.\n` +
          `Deposit to pay now: ${x.deposit_pct ?? 50}% = $${deposit.toFixed(2)}.\n` +
          `Drafting rule: warm, short reply. Thank them for confirming the details, say their deposit invoice is attached and paying the deposit secures the date, and that final numbers/dietaries can be confirmed closer to the day. Don't re-list every line. Keep it to a few sentences.`,
      },
    ],
  })
  if (!d.body) return await flagDraftFailure(thread, latest, category)
  // Invoices always get human eyes before sending.
  if (!d.flags.includes("needs_human")) d.flags.push("needs_human")
  const safeName = (x.customer_name ?? "customer").replace(/[^A-Za-z0-9 ]/g, "").trim()
  await deliver(thread, latest, d, category, playbook, {
    // BCC accounts + Shawna so the sent invoice copies them in (Chris/Shawna).
    bcc: INVOICE_BCC,
    extraAttachments: [
      {
        filename: `${built.invoiceNumber} - ${safeName}.pdf`,
        contentType: "application/pdf",
        data: built.pdf,
      },
    ],
  })
  console.log(`[invoice] auto-built ${built.invoiceNumber} for thread ${thread.threadId} (${x.guests}pax, $${total})`)
  return true
}

// --- function enquiry pipeline ---

async function handleFunctionEnquiry(
  thread: ParsedThread,
  latest: ParsedMessage,
  venue: Venue,
  category: Category
): Promise<boolean> {
  const helloMail = config().HELLO_MAILBOX
  // Full, dequoted thread — booking extraction + invoice-stage detection both
  // read the ENTIRE conversation, not a truncated slice.
  const fullText = renderFullThread(thread.messages)

  // --- Finalised in-thread? Auto-build the deposit invoice from the FINAL
  // agreed details (date/time/numbers/package) and draft a reply with it
  // attached. Runs whether the booking was agreed via the agent or by staff
  // in plain email. One invoice per thread; always human-reviewed.
  try {
    if (await maybeAutoInvoice(thread, latest, venue, category, fullText)) {
      return true
    }
  } catch (e) {
    console.error(
      "[invoice] auto-build error:",
      e instanceof Error ? e.message : e
    )
  }

  const extracted = await extractBooking(fullText)
  const customerEmail = extractEmail(latest.from)
  const customerName =
    extracted.customer_name ?? firstName(latest.from) ?? null

  let booking = await getBookingByThread(thread.threadId)

  // --- Already locked in: customer replied AFTER a slot was selected /
  // invoiced / paid. Never re-propose slots or re-invoice — answer their
  // message as a normal follow-up and hand to a human (numbers changes,
  // dietaries, logistics all need a person on a committed booking).
  const COMMITTED_STATES = new Set([
    "slot_selected",
    "deposit_invoiced",
    "deposit_paid",
    "balance_invoiced",
    "paid",
  ])
  // Treat a thread we've already invoiced as committed too — never re-propose
  // slots to someone who's been booked and invoiced.
  const alreadyInvoiced = await threadHasInvoice(thread.threadId)
  if (alreadyInvoiced || (booking && COMMITTED_STATES.has(booking.state))) {
    const playbook = await getPlaybook(category)
    const allergenQ = await maybeAllergenBlock(
      latest.subject + "\n" + dequote(latest.bodyText)
    )
    const committedHistory = customerEmail
      ? renderCustomerHistory(await fetchCustomerHistory(customerEmail, thread.threadId))
      : ""
    const slotLabel = booking?.event_start
      ? new Date(booking.event_start).toLocaleString("en-AU", {
          timeZone: "Australia/Brisbane",
          weekday: "long",
          day: "numeric",
          month: "long",
          hour: "numeric",
          minute: "2-digit",
        })
      : null
    const d = await draft({
      category,
      playbook,
      threadHistory: thread.messages.map(toHistoryItem),
      customerName: customerName ?? undefined,
      customExtras: [
        ...(allergenQ ? [{ role: "user" as const, content: allergenQ }] : []),
        ...(committedHistory ? [{ role: "user" as const, content: committedHistory }] : []),
        {
          role: "user",
          content:
            `This customer already has a CONFIRMED function booking with us` +
            (slotLabel ? ` (${slotLabel}, ${booking?.pax ?? "?"} pax)` : "") +
            `. They are following up (a question, a change to numbers/dietaries, or logistics). ` +
            `Do NOT propose new dates or re-pitch packages. Answer their message warmly and briefly. ` +
            `If they want to change guest numbers, the date, or anything affecting the booking or invoice, acknowledge it and note a teammate will confirm — add "needs_human" to flags so a person actions it.`,
        },
      ],
    })
    if (!d.body) return await flagDraftFailure(thread, latest, category)
    if (!d.flags.includes("needs_human")) d.flags.push("needs_human")
    await deliver(thread, latest, d, category, playbook)
    return true
  }

  // --- Follow-up: customer replied to a slots-proposed booking ---
  // If we've already proposed slots, see whether their reply is a
  // confirmation. Runs for BOTH venues: the deposit invoice + calendar event
  // are created either way (the invoice is AUTHORISED in Xero with the PDF
  // attached to the email — void it in Xero if a booking falls through),
  // but for Tea Garden the locking-in REPLY carries needs_floor_layout_check
  // so it never auto-sends — a human confirms the layout, then hits send.
  // Only ever surface daytime, still-future slots — stale evening slots from
  // before the daytime rule must never be re-offered or confirmable.
  const liveSlots = booking ? liveDaytimeSlots(booking.proposed_slots) : []
  if (
    booking &&
    booking.state === "slots_proposed" &&
    liveSlots.length
  ) {
    const slotsHuman = liveSlots
      .map(
        (s, i) =>
          `${i + 1}. ${new Date(s.start).toLocaleString("en-AU", {
            timeZone: "Australia/Brisbane",
            weekday: "long",
            day: "numeric",
            month: "long",
            hour: "numeric",
            minute: "2-digit",
          })}`
      )
      .join("\n")
    const conf = await classifyConfirmation(slotsHuman, dequote(latest.bodyText))

    // Customer pulled out → close the booking gracefully, never re-pitch.
    if (conf.action === "declined" && conf.confidence >= 0.8) {
      await updateBooking(booking.id, { state: "cancelled" })
      const playbook = await getPlaybook(category)
      const d = await draft({
        category,
        playbook,
        threadHistory: thread.messages.map(toHistoryItem),
        customerName: customerName ?? undefined,
        customExtras: [
          {
            role: "user",
            content:
              "The customer has DECLINED / is no longer going ahead with the function. Write a short, gracious sign-off: thank them, no guilt-tripping, no re-pitching, warmly invite them back any time. 2-3 sentences.",
          },
        ],
      })
      if (!d.body) return await flagDraftFailure(thread, latest, category)
      await deliver(thread, latest, d, category, playbook)
      return true
    }

    // Customer asked a question about the proposal → answer it. Keep the
    // existing proposed slots (don't re-roll dates under them) and don't
    // re-run the full pitch.
    if (conf.action === "question") {
      const playbook = await getPlaybook(category)
      const allergenQ = await maybeAllergenBlock(
        latest.subject + "\n" + dequote(latest.bodyText)
      )
      const d = await draft({
        category,
        playbook,
        threadHistory: thread.messages.map(toHistoryItem),
        customerName: customerName ?? undefined,
        customExtras: [
          ...(allergenQ ? [{ role: "user" as const, content: allergenQ }] : []),
          {
            role: "user",
            content:
              `The customer is asking a QUESTION about a function we've already proposed times for — they haven't picked a slot yet.\n` +
              (conf.notes ? `Their question (summarised): ${conf.notes}\n` : "") +
              `Slots already proposed (still on offer — copy labels exactly if you restate them):\n${slotsHuman}\n` +
              `Drafting rule: answer their question directly from the playbook. Don't repeat the full pitch or re-list every package. End with a light nudge to lock in a time when they're ready.`,
          },
        ],
      })
      if (!d.body) return await flagDraftFailure(thread, latest, category)
      await deliver(thread, latest, d, category, playbook)
      return true
    }

    if (
      conf.action === "confirmed" &&
      conf.selected_slot_index !== null &&
      conf.selected_slot_index >= 0 &&
      conf.selected_slot_index < liveSlots.length
    ) {
      const chosen = liveSlots[conf.selected_slot_index]!
      await updateBooking(booking.id, {
        state: "slot_selected",
        event_start: new Date(chosen.start),
        event_end: new Date(chosen.end),
      })

      // Block the slot on the venue calendar so it can't be double-booked
      // (proposeSlots reads this calendar via isSlotFree). It's a TENTATIVE
      // ENQUIRY hold — NOT a confirmed booking — until the deposit is paid.
      try {
        if (!booking.calendar_event_id) {
          const calId = await createEvent(venue, {
            summary: `ENQUIRY (tentative hold) — ${customerName ?? "?"} (${booking.pax ?? "?"} pax)`,
            description: `Tentative hold from inbox booking ${booking.id}. NOT confirmed — awaiting customer go-ahead + deposit. Don't treat as locked.`,
            start: new Date(chosen.start),
            end: new Date(chosen.end),
            attendees: customerEmail ? [customerEmail] : undefined,
          })
          await updateBooking(booking.id, { calendar_event_id: calId })
        }
      } catch (e) {
        console.error("[booking] calendar hold failed:", e instanceof Error ? e.message : e)
      }

      // Generate OUR OWN deposit invoice PDF (no Xero — Chris 2026-06-13) when
      // the business + bank details are configured; attach it to the draft for
      // staff to check. If not configured, fall back to "invoice will follow".
      let invoicePdf: Attachment | undefined
      let invoiceNumber: string | undefined
      try {
        if (invoiceConfigReady()) {
          const gen = await generateDepositInvoice({
            bookingId: booking.id,
            threadId: thread.threadId,
            customerName: customerName ?? "",
            customerEmail: customerEmail ?? "",
            venueLabel: venue === "tea_garden" ? "Tea Garden" : "Beach House",
            eventDate: new Date(chosen.start),
            amount: FUNCTION_DEPOSIT_AUD,
            todayBrisbane: todayBrisbaneStr(),
          })
          invoiceNumber = gen.invoiceNumber
          invoicePdf = {
            filename: `${gen.invoiceNumber}.pdf`,
            contentType: "application/pdf",
            data: gen.pdf,
          }
        }
      } catch (e) {
        console.error("[booking] invoice generation failed:", e instanceof Error ? e.message : e)
      }
      // Draft a confirmation reply with the invoice attached
      const playbook = await getPlaybook(category)
      const history = customerEmail
        ? await fetchCustomerHistory(customerEmail, thread.threadId)
        : []
      const historyBlock = renderCustomerHistory(history)
      const slotLabel = new Date(chosen.start).toLocaleString("en-AU", {
        timeZone: "Australia/Brisbane",
        weekday: "long",
        day: "numeric",
        month: "long",
        hour: "numeric",
        minute: "2-digit",
      })
      const d = await draft({
        category,
        playbook,
        threadHistory: thread.messages.map(toHistoryItem),
        customerName: customerName ?? undefined,
        customExtras: [
          ...(historyBlock
            ? [{ role: "user" as const, content: historyBlock }]
            : []),
          {
            role: "user",
            content:
              `The customer has just CONFIRMED a function slot. Don't re-ask for confirmation — write a short locking-in reply.\n` +
              `Confirmed slot: ${slotLabel}\n` +
              `Pax: ${booking.pax ?? "unknown"}\n` +
              `Venue: ${venue === "tea_garden" ? "Tea Garden" : "Beach House"}\n` +
              `Deposit: $${FUNCTION_DEPOSIT_AUD} save-the-date deposit — it holds their date and comes off the final balance. (Once package and numbers are locked in, a 50% package deposit applies per our policy.)\n` +
              (invoicePdf
                ? `The deposit invoice (${invoiceNumber}) is ATTACHED to this email as a PDF with our bank details for payment. Mention the attached invoice and that paying it secures the date.\n`
                : `The deposit invoice is being prepared and will follow separately.\n`) +
              `\nDrafting rule: Thank them for confirming, restate the date/time briefly, ` +
              `mention the deposit invoice and link if provided, and say we look forward to having them. ` +
              `Keep it short.` +
              (venue === "tea_garden"
                ? ` This is a Tea Garden function: add "needs_floor_layout_check" to flags (a teammate confirms the floor layout before this reply goes out, so write it as locked in — no caveats to the customer).`
                : ""),
          },
        ],
      })
      if (!d.body) return await flagDraftFailure(thread, latest, category)
      // The attached invoice PDF is what staff/customers work from
      // (Chris 2026-06-12). If invoicing or the PDF export failed, hold
      // the reply as a draft for a human instead of auto-sending it
      // incomplete.
      if (!invoicePdf && !d.flags.includes("needs_human")) {
        d.flags.push("needs_human")
      }
      await deliver(thread, latest, d, category, playbook, {
        extraAttachments: invoicePdf ? [invoicePdf] : [],
      })
      return true
    }
    // Only "different_time" falls through — re-extract from their reply
    // and propose fresh slots for the new ask.
  }
  if (!booking) {
    const id = await insertBooking({
      thread_id: thread.threadId,
      venue,
      state: "enquiry_received",
      customer_email: customerEmail,
      customer_name: customerName,
      pax: extracted.pax,
      notes: extracted.notes,
    })
    booking = await getBookingByThread(thread.threadId)
    if (!booking) throw new Error(`booking ${id} vanished`)
  }

  const history = customerEmail
    ? await fetchCustomerHistory(customerEmail, thread.threadId)
    : []
  const historyBlock = renderCustomerHistory(history)

  // Both venues propose slots from the function calendar, cross-checked
  // against Now Book It bookings (daily CSV ingest): Tea Garden slots with
  // 3+ overlapping high teas are filtered out in proposeSlots. Beach House
  // functions run in the Hideout (private space), so downstairs restaurant
  // bookings don't block them.

  // Beach House and Tea Garden: propose slots from the calendar.
  // Three cases:
  //   1. Customer named a specific day → propose times on that day.
  //   2. Customer gave a date range (e.g. "last weekend in July") → enumerate
  //      candidate days within the range and propose free ones.
  //   3. No date info at all → no slots, drafter writes a holding reply.
  let proposed: Array<{ start: string; end: string }> = []
  const duration = extracted.duration_hours ?? SLOT_DURATION_DEFAULT_HOURS
  if (extracted.preferred_date) {
    proposed = await proposeSlots(
      venue,
      extracted.preferred_date,
      extracted.preferred_time,
      duration
    )
  } else if (extracted.date_range_start && extracted.date_range_end) {
    proposed = await proposeSlotsInRange(
      venue,
      extracted.date_range_start,
      extracted.date_range_end,
      extracted.weekends_only,
      extracted.preferred_time,
      duration
    )
  }
  await updateBooking(booking.id, {
    state: proposed.length ? "slots_proposed" : "enquiry_received",
    proposed_slots: proposed,
    notes: extracted.notes ?? booking.notes ?? undefined,
  })

  const playbook = await getPlaybook(category)
  const fnAllergenBlock = await maybeAllergenBlock(
    latest.subject + "\n" + dequote(latest.bodyText)
  )
  const slotsBlock = proposed.length
    ? "Available windows that look open:\n" +
      proposed
        .map(
          (s) =>
            `  • ${new Date(s.start).toLocaleString("en-AU", { timeZone: "Australia/Brisbane", weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" })}`
        )
        .join("\n") +
      "\nCopy these dates, weekdays and times into the reply EXACTLY as written above — never recompute or reword a weekday."
    : venue === "tea_garden"
      ? "(Calendar didn't auto-suggest a window, but the Tea Garden accommodates group bookings — see the drafting rule below; do NOT decline.)"
      : "(No open windows found for the dates given — see the drafting rule below.)"

  const dateBlock = extracted.preferred_date
    ? `Preferred date: ${extracted.preferred_date}`
    : extracted.date_range_start && extracted.date_range_end
      ? `Customer's date range: ${extracted.date_range_start} to ${extracted.date_range_end}${extracted.weekends_only ? " (weekends only)" : ""}`
      : "Date: unspecified"

  // For Tea Garden, look up NBI high tea bookings on the proposed date(s)
  // so we can give a concrete picture of how busy the space already is.
  let nbiContext = ""
  if (venue === "tea_garden" && proposed.length) {
    const dates = new Set(proposed.map((s) => s.start.slice(0, 10)))
    const lines: string[] = []
    for (const d of dates) {
      const bookings = await nbiBookingsForDate("%high tea%", d)
      const tbc = bookings.filter((b) => b.status === "Unconfirmed").length
      lines.push(
        `  ${d}: ${bookings.length} high tea booking(s) already in NBI` +
          (bookings.length
            ? ` (times: ${bookings.map((b) => b.booking_time.slice(0, 5)).join(", ")}${tbc ? `; ${tbc} of these are TBC — held but not locked in` : ""})`
            : "")
      )
    }
    nbiContext =
      `\nNow Book It state on proposed dates:\n${lines.join("\n")}\n` +
      `If a date the customer wants overlaps a TBC booking, you can say that window is currently held but not yet locked in, so it may free up.\n`
  }

  const teaGardenCaveat =
    venue === "tea_garden"
      ? " These Tea Garden slots have already been checked against existing high tea bookings, so propose them confidently. For groups over 12, add one light line that we'll do a final floor-layout check for their group size before locking it in. Never mention 'Now Book It' to the customer."
      : ""

  const wideRangeNote =
    extracted.date_range_start && extracted.date_range_end
      ? " The customer gave a wide date range and we've only listed the first few open windows — say plenty of other dates across their range are also available if none of these suit."
      : ""

  // Safety guards the drafter must respect.
  const guardNotes: string[] = []
  if (extracted.pax && extracted.pax > 30) {
    guardNotes.push(
      `Large group (${extracted.pax}). Don't make it sound hard — we CAN host big groups. Recommend TEA GARDEN WHOLE-VENUE HIRE with a package (High Tea + Beer & Prosecco $55pp, or + Canapés + Cocktails $90pp) and point them to the attached functions pack for the options. Add "needs_human" so the team confirms details.`
    )
  }
  if (!extracted.preferred_date && !extracted.date_range_start && /\b(\d{1,2})(st|nd|rd|th)?\b/.test(latest.subject + " " + latest.bodyText) && !/20\d\d/.test(latest.bodyText)) {
    guardNotes.push(
      `The customer gave a date with NO YEAR. Ask which year they mean before quoting availability — don't assume.`
    )
  }
  const soonCutoff = addDaysStr(todayBrisbaneStr(), 3)
  if (extracted.preferred_date && extracted.preferred_date <= soonCutoff) {
    guardNotes.push(
      `This is a SHORT-NOTICE request (within 3 days). Don't promise the date — say we'll check with the team today whether we can make it happen, and add "needs_human" to flags.`
    )
  }
  const holidaySlots = proposed.filter((s) =>
    QLD_PUBLIC_HOLIDAYS.has(s.start.slice(0, 10))
  )
  if (holidaySlots.length) {
    guardNotes.push(
      `One or more proposed dates fall on a QLD public holiday — mention that a public holiday surcharge applies (confirmed at booking).`
    )
  }

  // No-slots handling is venue-aware. Tea Garden is a shared cafe/garden that
  // seats many groups at once — we ACCOMMODATE group bookings, never decline
  // for "availability". Beach House (Hideout) is exclusive, so a clash there
  // does mean we ask for another date.
  const noSlotsRule =
    venue === "tea_garden"
      ? "DO NOT tell them we have no availability — we can host this group. Warmly confirm we'd love to have them on the date and time they asked for. If it's a group dining/table booking over 12 on a weekend, point them to our Set Brunch Package (from $40pp, details in the attached functions pack) — and DON'T mention a deposit for a table booking. Ask for final numbers and any dietaries to lock it in. Write it as confirmed (a teammate does a final floor-layout check for the group size; no caveats to the customer)."
      : "We don't have the Hideout free on the date(s) they gave. Apologise briefly and ask for an alternative date window, don't make them spell out the same dates again."

  const draftingRules =
    (proposed.length
      ? "We've already checked the calendar. Propose the slots above to the customer with specific dates and times; DON'T ask them to re-confirm dates they've already given." +
        wideRangeNote +
        teaGardenCaveat
      : noSlotsRule) +
    (guardNotes.length ? "\nGuards:\n- " + guardNotes.join("\n- ") : "")

  const d = await draft({
    category,
    playbook,
    threadHistory: thread.messages.map(toHistoryItem),
    customerName: customerName ?? undefined,
    customExtras: [
      ...(historyBlock
        ? [{ role: "user" as const, content: historyBlock }]
        : []),
      ...(fnAllergenBlock
        ? [{ role: "user" as const, content: fnAllergenBlock }]
        : []),
      {
        role: "user",
        content:
          `Booking flow info (use this when drafting):\n` +
          `Venue: ${venue === "tea_garden" ? "Tea Garden" : "Beach House"}\n` +
          `Pax: ${extracted.pax ?? "unknown"}\n` +
          `${dateBlock}\n` +
          `Slots:\n${slotsBlock}\n` +
          nbiContext +
          `Deposit rule: a $${FUNCTION_DEPOSIT_AUD} deposit applies ONLY to EXCLUSIVE PRIVATE HIRE (whole-venue hire, or a private styled function like a baby shower / hens in the Hideout). A group that just wants a TABLE for breakfast / brunch / lunch (even 15+ people) is a normal dining booking — NO deposit, do not mention one; just confirm the table, the set brunch menu for 12+, and take their final numbers and dietaries. Judge which this is from what the customer actually asked for; when unsure, treat it as a table booking and don't raise a deposit.\n` +
          `\nDrafting rule: ${draftingRules}\n`,
      },
    ],
  })
  if (!d.body) return await flagDraftFailure(thread, latest, category)
  await deliver(thread, latest, d, category, playbook)
  return true
}

/** Walk through a date range (inclusive) and return up to MAX_SLOTS_PROPOSED
 *  free time-slots. Optionally restricts to weekends. Stops early once it
 *  has found enough. */
/** Weekday of a calendar date string, independent of server timezone. */
function dateStrDow(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0=Sun, 6=Sat
}

function addDaysStr(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

async function proposeSlotsInRange(
  venue: Venue,
  startStr: string,
  endStr: string,
  weekendsOnly: boolean,
  timeStr: string | null,
  durationHours: number
): Promise<Array<{ start: string; end: string }>> {
  // Walk calendar-date STRINGS, never Date objects: the container runs in
  // UTC, so Date#getDay()/#getDate() on a +10:00 instant land a day early —
  // that's how "Saturday 2 August" went to a customer when Aug 2 is a Sunday.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startStr) || !/^\d{4}-\d{2}-\d{2}$/.test(endStr))
    return []
  const out: Array<{ start: string; end: string }> = []
  const MAX_DAYS = 120
  let cursor = startStr
  let days = 0
  while (cursor <= endStr && days < MAX_DAYS) {
    if (out.length >= MAX_SLOTS_PROPOSED) break
    const dow = dateStrDow(cursor)
    if (!weekendsOnly || dow === 0 || dow === 6) {
      // One slot per candidate day to keep prompt size sane.
      const slots = await proposeSlots(venue, cursor, timeStr, durationHours)
      if (slots.length) out.push(slots[0]!)
    }
    cursor = addDaysStr(cursor, 1)
    days++
  }
  return out
}

// Daytime venue: nothing starts after mid-afternoon (Chris 2026-06-12: "we do
// not offer nights yet"). Earliest 07:00 covers the Tea Garden's 7:30am
// weekend opening for group breakfasts. Evening requests are ignored here;
// the drafter explains daytime-only.
const EARLIEST_START_HOUR = 7
const LATEST_START_HOUR = 14

function todayBrisbaneStr(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Brisbane",
  }).format(new Date())
}

/**
 * Drops any stored slot that isn't a daytime start or has already passed.
 * Guards against stale proposed_slots from before the daytime rule existed
 * (and from any future bug) ever being re-offered to a customer.
 */
function liveDaytimeSlots(
  slots: Array<{ start: string; end: string }>
): Array<{ start: string; end: string }> {
  const now = Date.now()
  return slots.filter((s) => {
    // Past check on the absolute instant — NOT a UTC date-string slice, which
    // is off by a day for morning Brisbane slots (their UTC date is the day
    // before, so a still-future 9:30am slot was wrongly dropped).
    if (new Date(s.start).getTime() <= now) return false
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Australia/Brisbane",
        hour: "2-digit",
        hour12: false,
      }).format(new Date(s.start))
    )
    return hour >= EARLIEST_START_HOUR && hour <= LATEST_START_HOUR
  })
}

// QLD public holidays (statewide). Update yearly; Gold Coast Show Day
// (late Aug, region-gazetted) is deliberately omitted — confirm before adding.
const QLD_PUBLIC_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-26", "2026-04-03", "2026-04-04", "2026-04-05",
  "2026-04-06", "2026-04-25", "2026-05-04", "2026-10-05", "2026-12-25",
  "2026-12-26", "2026-12-28",
  "2027-01-01", "2027-01-26", "2027-03-26", "2027-03-27", "2027-03-28",
  "2027-03-29", "2027-04-25", "2027-05-03", "2027-10-04", "2027-12-25",
  "2027-12-27", "2027-12-28",
])

async function proposeSlots(
  venue: Venue,
  dateStr: string,
  timeStr: string | null,
  durationHours: number
): Promise<Array<{ start: string; end: string }>> {
  // Never propose today or the past — same-day functions need a human, and
  // a past date means the extraction misread (or the enquiry is stale).
  if (dateStr <= todayBrisbaneStr()) return []
  // Candidate slots: the customer's preferred time (if within daytime
  // hours) + lunch (12:00) + morning (9:30).
  const candidates: Array<{ hour: number; minute: number }> = []
  if (timeStr) {
    const [h, m] = timeStr.split(":").map(Number) as [number, number]
    if (!Number.isNaN(h) && h >= EARLIEST_START_HOUR && h <= LATEST_START_HOUR) {
      candidates.push({ hour: h, minute: m ?? 0 })
    }
  }
  for (const c of [
    { hour: 12, minute: 0 },
    { hour: 9, minute: 30 },
  ]) {
    if (!candidates.some((x) => x.hour === c.hour && x.minute === c.minute)) {
      candidates.push(c)
    }
  }
  const out: Array<{ start: string; end: string }> = []
  for (const c of candidates) {
    if (out.length >= MAX_SLOTS_PROPOSED) break
    const start = new Date(`${dateStr}T${pad(c.hour)}:${pad(c.minute)}:00+10:00`)
    const end = new Date(start.getTime() + durationHours * 3600_000)
    if (!(await isSlotFree(venue, { start, end }))) continue
    // The Google calendar only holds functions we created — Now Book It
    // bookings live in inbox_nbi_bookings. For Tea Garden, a slot with 3+
    // overlapping high teas isn't really available (shared space). Beach
    // House functions are in the Hideout (private space upstairs), so
    // restaurant bookings downstairs don't block them.
    if (venue === "tea_garden") {
      const highTeas = await nbiOverlapCount("%high tea%", { start, end }, 90)
      if (highTeas >= 3) continue
    }
    out.push({ start: start.toISOString(), end: end.toISOString() })
  }
  return out
}

function pad(n: number): string {
  return String(n).padStart(2, "0")
}

// --- called when customer confirms a slot (manual progression for now) ---
export async function progressBookingToInvoice(bookingId: number): Promise<void> {
  const { rows } = await (await import("./db/pool.js")).db().query(
    `SELECT * FROM inbox_bookings WHERE id = $1`,
    [bookingId]
  )
  const b = rows[0]
  if (!b) throw new Error(`booking ${bookingId} not found`)
  if (!b.customer_email || !b.customer_name) {
    throw new Error("booking missing customer email/name")
  }
  if (!b.event_start || !b.event_end) {
    throw new Error("booking has no confirmed slot — set event_start/end first")
  }
  const contactId = await findOrCreateContact(
    b.customer_email,
    b.customer_name
  )
  const ref = `Function ${b.venue} ${new Date(b.event_start).toISOString().slice(0, 10)}`
  const depositId = await createAuthorisedInvoice({
    contactId,
    reference: `${ref} — save-the-date deposit`,
    lines: [
      {
        // Matches the published policy: $500 save-the-date holds the date;
        // the 50% package deposit follows once package + numbers are locked.
        description: `Save-the-date deposit to hold ${b.venue.replace("_", " ")} function on ${new Date(b.event_start).toLocaleDateString("en-AU", { timeZone: "Australia/Brisbane" })} (applied toward your final balance)`,
        quantity: 1,
        unitAmount: FUNCTION_DEPOSIT_AUD,
      },
    ],
  })
  const calendarEventId = await createEvent(b.venue, {
    summary: `DEPOSIT INVOICED — ${b.customer_name} (${b.pax ?? "?"} pax)`,
    description: `From inbox booking ${b.id}. Deposit invoice ${depositId} raised — confirmed once deposit is paid.`,
    start: new Date(b.event_start),
    end: new Date(b.event_end),
    attendees: [b.customer_email],
  })
  await updateBooking(b.id, {
    state: "deposit_invoiced",
    xero_contact_id: contactId,
    xero_deposit_invoice_id: depositId,
    calendar_event_id: calendarEventId,
  })
  const url = await getInvoiceOnlineUrl(depositId)
  console.log(`[booking ${b.id}] deposit invoice ${depositId} ready: ${url ?? "(no online url)"}`)
}

// --- edit capture ---

async function captureEdit(
  thread: ParsedThread,
  meta: Record<string, unknown>
): Promise<void> {
  const draftedAtStr = meta["draftedAt"] as string | undefined
  const draftBody = meta["draftBody"] as string | undefined
  const category = meta["category"] as string | undefined
  if (!draftedAtStr || !draftBody) return
  const draftedAt = new Date(draftedAtStr)
  const sent = await findOurSentReply(
    thread,
    config().HELLO_MAILBOX,
    draftedAt
  )
  if (!sent) return
  const sentBody = sent.bodyText.trim()
  // Record verbatim sends too (edit_distance 0) — they're the trust signal
  // for promoting a category to auto-send, and silently dropping them left
  // us blind to how good the drafts actually were.
  await recordLearning({
    thread_id: thread.threadId,
    category: category ?? null,
    our_draft: draftBody,
    sent_reply: sentBody,
    edit_distance:
      sentBody === draftBody.trim()
        ? 0
        : levenshtein(draftBody.trim(), sentBody),
  })
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!
      dp[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, dp[j]!, dp[j - 1]!)
      prev = tmp
    }
  }
  return dp[b.length]!
}
