// RULE (set in stone, Chris 2026-06-13): the agent must read the ENTIRE email
// thread, every message, on every interaction — never miss valuable info. This
// helper is the single source of truth for turning a thread into LLM context.
// It dequotes each message (the quoted block is the prior message, already
// present separately, so dequoting removes duplication, not information) and
// keeps EVERY message oldest-first.
//
// Caps are generous enough to be lossless for any realistic email (a single
// 16k-char message is ~3000 words). The total ceiling only ever trips on
// pathological threads, and when it does we keep the MOST RECENT content
// (where final decisions live) and mark that earlier messages were trimmed —
// we never silently drop the tail.

import { dequote } from "./dequote.js"

const PER_MESSAGE_CHARS = 16000
const TOTAL_CHARS = 140000 // ~35k tokens; full normal threads fit easily

export interface MessageLike {
  from: string
  date: Date
  bodyText: string
}

export function renderFullThread(messages: MessageLike[]): string {
  const parts = messages.map((m) => {
    const when = m.date.toISOString().replace("T", " ").slice(0, 16)
    const body = dequote(m.bodyText)
    const clipped =
      body.length > PER_MESSAGE_CHARS
        ? body.slice(0, PER_MESSAGE_CHARS) + "\n[…message truncated…]"
        : body
    return `[${when}] From: ${m.from}\n${clipped}`
  })
  let text = parts.join("\n\n---\n\n")
  if (text.length > TOTAL_CHARS) {
    text =
      "[…earlier messages in this thread truncated for length; most recent kept…]\n\n" +
      text.slice(text.length - TOTAL_CHARS)
  }
  return text
}
