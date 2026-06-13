// Verifies parseFormSubmission against real-world form-relay bodies.
//   docker compose exec inbox node dist/scripts/test-form-parse.js

import { parseFormSubmission } from "../pipeline.js"
import type { ParsedMessage } from "../google/gmail.js"

function msg(from: string, subject: string, body: string): ParsedMessage {
  return {
    id: "x", threadId: "t", from, to: ["hello@tarte.com.au"], cc: [],
    subject, messageIdHeader: undefined, references: undefined,
    inReplyTo: undefined, date: new Date(), bodyText: body, bodyHtml: "",
    labelIds: [], snippet: "",
  }
}

const cases: Array<{ name: string; m: ParsedMessage; expectEmail: string | null }> = [
  {
    name: "Squarespace (Liz, running late)",
    m: msg(
      "Squarespace <form-submission@squarespace.info>",
      "Form Submission - Contact - Running late",
      `Sent via form submission from Tarte.

Name: Liz Uruci
Email: liz.uruci@gmail.com
Subject: Running late
Message: Hi we have a 10am reservation but we are running 15 mins late. Definitely coming
Interested in: Reservations

Create Invoice
Manage Submissions
Does this submission look like spam? Report it here.`
    ),
    expectEmail: "liz.uruci@gmail.com",
  },
  {
    name: "multi-line message + phone field",
    m: msg(
      "Squarespace <form-submission@squarespace.info>",
      "Form Submission - Contact - Function",
      `Sent via form submission from Tarte.
Name: Jane Doe
Email: jane.doe@bigpond.com
Phone: 0412345678
Subject: Baby shower
Message: Hi there,
We'd love to book a baby shower for 20 in August.
Could you send pricing?
Interested in: Events
Manage Submissions`
    ),
    expectEmail: "jane.doe@bigpond.com",
  },
  {
    name: "genuine direct email (NOT a form)",
    m: msg(
      "Sarah <sarah@gmail.com>",
      "High tea booking",
      "Hi, can I book a high tea for 6 on Saturday? Thanks Sarah"
    ),
    expectEmail: null,
  },
]

let pass = 0
for (const c of cases) {
  const r = parseFormSubmission(c.m)
  const ok = (r?.email ?? null) === c.expectEmail
  pass += ok ? 1 : 0
  console.log(`${ok ? "PASS" : "FAIL"}: ${c.name}`)
  if (r) console.log(`   name=${r.name} email=${r.email} subject="${r.subject}"\n   message="${r.message}"`)
  else console.log(`   (not a form submission)`)
}
console.log(`\n${pass}/${cases.length} passed`)
process.exit(pass === cases.length ? 0 : 1)
