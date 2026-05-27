import type { Playbook } from "../db/queries.js"

// Seed playbooks. Voice will be tuned once we ingest real past replies from
// hello@tarte.com.au's Sent folder. These are starting points only.

const VOICE_BASE =
  "Warm but brisk. Australian English. No corporate fluff, no 'we appreciate your business'. Use first name if known."

export const DEFAULTS: Playbook[] = [
  {
    category: "events_tea_garden_high_tea",
    description:
      "High tea enquiries at Tea Garden for groups of 12 or fewer. Most arrive via Now Book It; if they come by email, redirect.",
    voice_guidance: VOICE_BASE,
    reply_template:
      "Thanks for getting in touch. High tea bookings for 12 or fewer go straight through our booking system — you can pick a date and time here: https://nowbookit.com/.../tea-garden\n\nIf you'd like anything customised on top of the standard high tea (dietaries, extras, gift), reply here and we'll sort it.\n\nTarte Team",
    auto_send: false,
    min_confidence: 0.8,
    examples: [],
  },
  {
    category: "events_tea_garden_functions",
    description:
      "Function enquiries at Tea Garden over 12 pax. Floor layout has to be checked by a human before we commit.",
    voice_guidance:
      VOICE_BASE +
      " For functions, never lock in a time — always say 'checking availability and back to you within the day'.",
    reply_template:
      "Thanks {{first_name}}, lovely to hear from you. Tea Garden functions for groups over 12 need a quick floor-layout check from our side before we can confirm timing. We'll come back to you within the day with available windows and our function pack.\n\nTarte Team",
    auto_send: false,
    min_confidence: 0.85,
    examples: [],
  },
  {
    category: "events_beach_house_functions",
    description: "Beach House function / event enquiries. Exclusive-use venue.",
    voice_guidance: VOICE_BASE,
    reply_template:
      "Thanks {{first_name}}, lovely to hear from you. We'd love to host you at the Beach House.\n\n{{proposed_slots}}\n\nOur function pack covers menus, pricing and what's included — happy to send it through. We hold a date with a deposit ({{deposit_amount}}).\n\nTarte Team",
    auto_send: false,
    min_confidence: 0.85,
    examples: [],
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
  },
  {
    category: "bookings_dine_in",
    description:
      "Regular dine-in reservations that came by email instead of Now Book It.",
    voice_guidance: VOICE_BASE,
    reply_template:
      "Thanks for reaching out — easiest way to lock this in is our booking system, which shows live availability: https://nowbookit.com/.../book\n\nIf you'd prefer we book it for you, give us a date, time and number of guests and we'll sort it.\n\nTarte Team",
    auto_send: false,
    min_confidence: 0.85,
    examples: [],
  },
  {
    category: "job_applications",
    description: "Job applications and casual work enquiries.",
    voice_guidance: VOICE_BASE,
    reply_template:
      "Thanks for sending your application through, {{first_name}}. We'll have a look and come back to you if there's a fit.\n\nTarte Team",
    auto_send: false,
    min_confidence: 0.9,
    examples: [],
  },
  {
    category: "marketing_cold_outreach",
    description: "Sales pitches, SEO/agency outreach, cold B2B offers.",
    voice_guidance: "Don't reply. Label only.",
    reply_template: null,
    auto_send: false,
    min_confidence: 0.7,
    examples: [],
  },
  {
    category: "accounts_invoices",
    description: "Invoices to pay, statements, accounting matters.",
    voice_guidance: "Don't reply from hello@. Label so accounts can pick up.",
    reply_template: null,
    auto_send: false,
    min_confidence: 0.8,
    examples: [],
  },
  {
    category: "needs_human",
    description: "Default for low confidence or ambiguous threads.",
    voice_guidance: "Don't draft. Just label.",
    reply_template: null,
    auto_send: false,
    min_confidence: 1.0,
    examples: [],
  },
]
