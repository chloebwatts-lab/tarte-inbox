// Strip quoted reply blocks, signatures, and forwarded auto-mailer boilerplate
// from an email body. Used both at ingest time (storing clean past replies)
// and at live drafting time (clean input to the classifier + drafter).
//
// Handles:
//   - single-line "On X wrote:"
//   - multi-line "On X / <email> / wrote:" wrapped across 2-4 lines
//   - Outlook chain headers ("From: ... Sent: ...")
//   - "-----Original Message-----" markers
//   - "Sent from my iPhone/Outlook/etc" trailers
//   - Hanging "wrote:" or "> wrote:" lines
//   - Now Book It / Ordermentum auto-confirmation boilerplate
//   - HTML noise (style/script blocks remain in some plain-text bodies)

export function dequote(body: string): string {
  const lines = body.split("\n")
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const trimmed = line.trim()
    if (/^On .+wrote:?\s*$/i.test(trimmed)) break
    if (/^From:\s/.test(trimmed) && i > 1) break
    if (/^-+\s*Original Message\s*-+/i.test(trimmed)) break
    if (/^>\s?/.test(line)) continue
    if (/^--\s*$/.test(trimmed)) break
    out.push(line)
  }
  let text = out.join("\n").trim()
  text = text
    // Multi-line "On X\n<email>\nwrote:" pattern
    .replace(/(^|\n)On\s[^\n]*(?:\n[^\n]*){0,4}wrote:?[\s\S]*$/i, "")
    .replace(/\n+Sent from my (iPhone|iPad|Android|Outlook)[\s\S]*$/i, "")
    .replace(/\n[>\s]*wrote:?\s*$/i, "")
    // Now Book It confirmation boilerplate (very common in customer replies
    // to a booking-confirmation email)
    .replace(
      /Booking Confirmation[\s\S]*?(?:View booking|Manage booking|nowbookit\.com)[\s\S]*$/i,
      ""
    )
    .replace(/Order Confirmation[\s\S]*?ordermentum\.com[\s\S]*$/i, "")
  return text.trim()
}
