import type { Playbook } from "../db/queries.js"

// Seed playbooks. Voice will be tuned once we ingest real past replies from
// hello@tarte.com.au's Sent folder. These are starting points only.

const VOICE_BASE =
  'Warm but brisk. Australian English. No corporate fluff, no "we appreciate your business". ' +
  'Open with "Hey {first name}," (or "Hey there," if no name). Sign off "Kind regards,\nTarte Team".'

const SIGNOFF = "\n\nKind regards,\nTarte Team"

export const DEFAULTS: Playbook[] = [
  {
    category: "events_tea_garden_high_tea",
    description:
      "High tea enquiries at Tea Garden for groups of 12 or fewer. Most arrive via Now Book It; if they come by email, redirect.",
    voice_guidance: VOICE_BASE,
    reply_template:
      "Hey {{first_name}},\n\nThanks for getting in touch. High tea bookings for 12 or fewer go straight through our booking system — you can pick a date and time here: https://nowbookit.com/.../tea-garden\n\nI've attached our functions & events packages in case you'd like to extend the booking or add anything special." +
      SIGNOFF,
    auto_send: false,
    min_confidence: 0.8,
    examples: [],
    default_attachment_paths: ["functions-events-packages.pdf"],
    forward_to: null,
  },
  {
    category: "events_tea_garden_functions",
    description:
      "Function enquiries at Tea Garden over 12 pax. Floor layout has to be checked by a human before we commit.",
    voice_guidance:
      VOICE_BASE +
      " For functions, never lock in a time — always say 'checking availability and back to you within the day'.",
    reply_template:
      "Hey {{first_name}},\n\nThanks for getting in touch — lovely to hear from you. Tea Garden functions for groups over 12 need a quick floor-layout check from our side before we can confirm timing. I've attached our functions & events packages in the meantime, and we'll come back to you within the day with available windows." +
      SIGNOFF,
    auto_send: false,
    min_confidence: 0.85,
    examples: [],
    default_attachment_paths: ["functions-events-packages.pdf"],
    forward_to: null,
  },
  {
    category: "events_beach_house_functions",
    description: "Beach House function / event enquiries. Exclusive-use venue.",
    voice_guidance: VOICE_BASE,
    reply_template:
      "Hey {{first_name}},\n\nThanks for getting in touch — we'd love to host you at the Beach House. I've attached our functions & events packages which covers menus, pricing and what's included.\n\n{{proposed_slots}}\n\nWe hold a date with a deposit ({{deposit_amount}})." +
      SIGNOFF,
    auto_send: false,
    min_confidence: 0.85,
    examples: [],
    default_attachment_paths: ["functions-events-packages.pdf"],
    forward_to: null,
  },
  {
    category: "suppliers",
    description:
      "Supplier emails — price changes, deliveries, statements, product questions.",
    voice_guidance:
      VOICE_BASE +
      " Be direct. If they've raised a price, acknowledge but don't accept on the spot.",
    reply_template: null,
    auto_send: false,
    min_confidence: 0.85,
    examples: [],
    default_attachment_paths: [],
    forward_to: null,
  },
  {
    category: "reviews",
    description: "Customer review notifications or direct customer feedback.",
    voice_guidance:
      VOICE_BASE +
      " For positive reviews, brief thanks. For negative, acknowledge specifically, never defensive, offer to follow up offline.",
    reply_template: null,
    auto_send: false,
    min_confidence: 0.9,
    examples: [],
    default_attachment_paths: [],
    forward_to: null,
  },
  {
    category: "bookings_dine_in",
    description:
      "Regular dine-in reservations that came by email instead of Now Book It.",
    voice_guidance: VOICE_BASE,
    reply_template:
      "Hey {{first_name}},\n\nThanks for reaching out — easiest way to lock this in is our booking system, which shows live availability: https://nowbookit.com/.../book\n\nIf you'd prefer we book it for you, give us a date, time and number of guests and we'll sort it." +
      SIGNOFF,
    auto_send: false,
    min_confidence: 0.85,
    examples: [],
    default_attachment_paths: [],
    forward_to: null,
  },
  {
    category: "job_applications",
    description:
      "Job applications and casual work enquiries. Auto-forwarded to work@tarte.com.au — no reply to the candidate.",
    voice_guidance:
      "Forward only. No drafted reply to the candidate. The hiring team at work@tarte.com.au will respond directly.",
    reply_template: null,
    auto_send: false,
    min_confidence: 0.9,
    examples: [],
    default_attachment_paths: [],
    forward_to: "work@tarte.com.au",
  },
  {
    category: "marketing_cold_outreach",
    description: "Sales pitches, SEO/agency outreach, cold B2B offers.",
    voice_guidance: "Don't reply. Label only.",
    reply_template: null,
    auto_send: false,
    min_confidence: 0.7,
    examples: [],
    default_attachment_paths: [],
    forward_to: null,
  },
  {
    category: "accounts_invoices",
    description: "Invoices to pay, statements, accounting matters.",
    voice_guidance: "Don't reply from hello@. Label so accounts can pick up.",
    reply_template: null,
    auto_send: false,
    min_confidence: 0.8,
    examples: [],
    default_attachment_paths: [],
    forward_to: null,
  },
  {
    category: "needs_human",
    description: "Default for low confidence or ambiguous threads.",
    voice_guidance: "Don't draft. Just label.",
    reply_template: null,
    auto_send: false,
    min_confidence: 1.0,
    examples: [],
    default_attachment_paths: [],
    forward_to: null,
  },
]
