# Tarte Functions app API

For Georgia (and her Claude). This is how the Functions app gets invoices, hello@ drafts, enquiries and the calendar without any Google Cloud setup. The Tarte inbox service already signs in as hello@tarte.com.au, so the app just calls it. No service account, no Super Admin, no Zapier.

Base URL: `https://inbox.tarte.com.au/fn`

## Signing the calls

Every call needs the header `Authorization: Bearer <key>`. Chloe has the key.

Do not paste the key into the app code. An Expo web app ships its code to every browser, so anything in the bundle is public. Two safe places for it:

1. A Supabase Edge Function secret, with the app calling the Edge Function (best).
2. A one-row Supabase table (for example `app_secrets`) with row level security so only signed-in users can read it. The app reads the key after sign-in and keeps it in memory.

Browser calls are allowed from `https://tarte-functions-app.expo.app` and from local dev on `http://localhost:8081` and `http://localhost:19006`. Tell Chloe if the app moves to another address.

Check it works: `GET /fn/ping` returns `{ "ok": true }`.

Every answer is JSON with `ok: true` or `ok: false` plus an `error` sentence that is safe to show on screen.

## Invoices

Invoices belong to a function. Use the function's own id from the `functions` table as `function_id`. Each function has one deposit invoice and one balance invoice. Calling again with the same `function_id` and `kind` regenerates the same invoice with the same number, so "Generate" and "Save edits" are the same call.

### Generate or edit: `POST /fn/invoice`

```json
{
  "function_id": "the functions row id",
  "kind": "deposit",
  "customer_name": "Jane Doe",
  "customer_email": "jane@example.com",
  "event_type": "Baby Shower",
  "package_name": "Private High Tea in The Hideout",
  "venue_space": "The Hideout",
  "event_date": "06/12/2026",
  "time_label": "11:00am - 2:00pm",
  "guests": 20,
  "per_person_price": 89,
  "deposit_pct": 50,
  "dietaries": "2x GF, 1x vegan",
  "add_ons": [
    { "description": "Celebration cake", "unit_price": 120, "per_person": false },
    { "description": "Drinks package", "unit_price": 35, "per_person": true }
  ]
}
```

- `kind` is `"deposit"` or `"balance"`.
- Needed the first time: `customer_name`, `customer_email`, and either `guests` + `per_person_price`, or `flat_deposit_amount` (a fixed save-the-date deposit, for example 500), or at least one priced add-on.
- On later calls send only what changed. Anything left out keeps its stored value. `add_ons`, when sent, replaces the whole list (send `[]` to clear it).
- `event_date` takes `DD/MM/YYYY` or `YYYY-MM-DD`.
- Money in: `amount_paid` (dollars received so far, shows on the PDF) or `"paid_in_full": true`.
- If the function already has the other invoice, it is rebuilt with the same numbers so the two always agree.

The answer:

```json
{
  "ok": true,
  "invoice": {
    "invoice_number": "TARTE-2026-00123",
    "kind": "deposit",
    "function_id": "...",
    "total": 2600,
    "deposit_amount": 1300,
    "amount_paid": 0,
    "balance_due": 2600,
    "paid_in_full": false,
    "lines": [{ "description": "...", "qty": 20, "unit_price": 89, "amount": 1780 }],
    "fields": { "the stored values, to prefill the edit form": "..." },
    "pdf_path": "/fn/invoice/TARTE-2026-00123/pdf",
    "drafted_at": null,
    "draft_url": null,
    "in_xero": false,
    "created_at": "2026-10-05T03:00:00.000Z"
  }
}
```

Generating and editing is private. Nothing goes to the customer, to Gmail or to Xero at this step.

### Show what a function has: `GET /fn/invoices?function_id=...`

Returns `{ "ok": true, "invoices": [ ... ] }` with the same shape as above. Use it to fill the Deposit and Balance slots on the function page. The invoices live on the Tarte server, so they cannot disappear from the app.

### The PDF: `GET /fn/invoice/TARTE-2026-00123/pdf`

Returns the PDF bytes. It needs the Authorization header, so fetch it and open the result:

```ts
const res = await fetch(`${BASE}/invoice/${number}/pdf`, { headers: { Authorization: `Bearer ${key}` } })
const url = URL.createObjectURL(await res.blob())
window.open(url)
```

### "Draft deposit invoice email": `POST /fn/invoice/TARTE-2026-00123/draft-email`

Body is optional: `{ "subject": "...", "body": "..." }`. Leave them out for the standard Tarte wording.

This puts a draft in hello@ Drafts, addressed to the customer with the PDF attached and accounts, Shawna and Louise on BCC. It never sends. Open `invoice.draft_url`, glance over it, press send in Gmail. Pressing the button again replaces the unsent draft.

This is also the moment the function becomes real for the accounts: the Xero draft invoice (dated the event day) is created for Louise, and from then on every edit keeps Xero in step. So play with test functions as much as you like, but only draft emails for real ones.

## Enquiries: `GET /fn/enquiries?days=120`

The inbox already reads every function enquiry that lands in hello@ and pulls out the details. This returns them, newest first:

```json
{
  "ok": true,
  "enquiries": [
    {
      "id": 41,
      "status": "pending",
      "state": "slots_proposed",
      "venue": "beach_house",
      "customer_name": "Jane Doe",
      "customer_email": "jane@example.com",
      "pax": 20,
      "event_date": "2026-12-06",
      "event_type": "Baby Shower",
      "package_name": null,
      "time_label": null,
      "invoice_number": null,
      "gmail_url": "https://mail.google.com/mail/u/0/#all/...",
      "received_at": "2026-10-01T02:11:00.000Z"
    }
  ]
}
```

`status` is `pending`, `confirmed` (deposit paid) or `cancelled`. Use `id` to remember which ones have already been turned into a function. Some fields are null until the customer has given them.

## Calendar: `POST /fn/calendar`

```json
{
  "function_id": "the functions row id",
  "title": "Baby Shower: Jane Doe, The Hideout",
  "date": "06/12/2026",
  "start_time": "11:00",
  "end_time": "14:00",
  "pax": 20,
  "notes": "High tea. 2x GF.",
  "status": "confirmed"
}
```

- Call it whenever a function is confirmed or changed. Same `function_id` updates the same calendar entry, so there are never doubles.
- `status`: `"confirmed"`, `"tbc"` (title gets a TBC prefix) or `"cancelled"` (removes the entry).
- Times are 24 hour Brisbane time. Leave `start_time` out for an all-day entry.

## Any draft from the app: `POST /fn/draft-email`

For emails the app composes itself: its own invoice file (the PDF or photo in the app's private `invoices` bucket) or the thank-you note. The inbox puts the email in hello@ Drafts and never sends it.

```json
{
  "to": "jane@example.com",
  "subject": "Your deposit invoice from Tarte",
  "body": "Hi Jane,\n\nPlease find your deposit invoice attached ...",
  "kind": "invoice",
  "ref": "fn:<function id>:deposit",
  "replace_draft_id": "r1234567890",
  "attachments": [
    { "filename": "Deposit invoice - Jane Doe.pdf", "content_type": "application/pdf", "data_base64": "JVBERi0x..." }
  ]
}
```

- `kind` is `"invoice"` (accounts, Shawna and Louise go on BCC, like every invoice email) or `"thank_you"` (customer only). Anything else is treated as `"other"`, customer only.
- `attachments` is optional. Up to 20 MB in total, base64 in `data_base64` (a `data:` prefix is stripped).
- `replace_draft_id`: pass back the `draft_id` from last time and that unsent draft is removed first, so pressing the button twice never leaves two drafts.
- `ref` is anything that helps a person trace the draft back (the function id and slot). It is stored, not shown to the customer.
- The subject is used exactly as given (no "Re:").

The answer:

```json
{
  "ok": true,
  "draft": {
    "draft_id": "r1234567890",
    "thread_id": "18f3...",
    "draft_url": "https://mail.google.com/mail/u/0/#all/18f3...",
    "drafted_at": "2026-10-16T03:00:00.000Z"
  }
}
```

Keep `draft_id` and `draft_url` against the invoice or function in the app: the url is the "Open in Gmail" link, the id is what you send as `replace_draft_id` next time.

Nothing goes to Xero from this call. The inbox's own generated invoices (`POST /fn/invoice` ... `/draft-email`) are the ones Louise's Xero drafts come from; the app's uploaded invoice files are just attached and sent by a person.

## Thank-you emails

Use `POST /fn/draft-email` with `kind: "thank_you"`, the app's own wording, and no attachments. It lands in hello@ Drafts for a person to read and send. One-click sending from hello@ stays Chloe's call.
