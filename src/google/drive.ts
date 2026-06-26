import { google, type drive_v3 } from "googleapis"
import { Readable } from "node:stream"
import { ensureGoogleAuthed, googleHasScope } from "./oauth.js"
import { config } from "../config.js"

const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file"

async function drive(): Promise<drive_v3.Drive> {
  const auth = await ensureGoogleAuthed()
  return google.drive({ version: "v3", auth })
}

/** Whether we can upload to Drive yet (token granted the drive.file scope).
 * Until Chris re-auths, callers no-op so the rest of the flow is unaffected. */
export async function driveReady(): Promise<boolean> {
  return googleHasScope(DRIVE_FILE_SCOPE)
}

let cachedFolderId: string | undefined

/** Resolve the invoice folder: a configured ID wins; otherwise find-or-create a
 * folder the app owns (drive.file can only see/create its own files, which is
 * exactly what we want — it won't trawl the user's Drive). */
async function invoiceFolderId(): Promise<string> {
  if (cachedFolderId) return cachedFolderId
  const c = config()
  if (c.INVOICE_DRIVE_FOLDER_ID) {
    cachedFolderId = c.INVOICE_DRIVE_FOLDER_ID
    return cachedFolderId
  }
  const d = await drive()
  const name = c.INVOICE_DRIVE_FOLDER_NAME
  // drive.file list only returns app-created files, so this finds our own
  // folder from a previous run rather than making a new one each time.
  const found = await d.files.list({
    q: `mimeType = 'application/vnd.google-apps.folder' and name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
    fields: "files(id,name)",
    pageSize: 1,
  })
  const existing = found.data.files?.[0]?.id
  if (existing) {
    cachedFolderId = existing
    return existing
  }
  const created = await d.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder" },
    fields: "id",
  })
  const id = created.data.id
  if (!id) throw new Error("drive: failed to create invoice folder")
  console.log(`[drive] created invoice folder "${name}" (${id})`)
  cachedFolderId = id
  return id
}

/** Upload an invoice PDF into the Drive invoice folder. Returns the file id. */
export async function uploadInvoicePdf(opts: {
  filename: string
  bytes: Buffer
}): Promise<string> {
  const d = await drive()
  const folderId = await invoiceFolderId()
  const res = await d.files.create({
    requestBody: { name: opts.filename, parents: [folderId] },
    media: { mimeType: "application/pdf", body: Readable.from(opts.bytes) },
    fields: "id",
  })
  const id = res.data.id
  if (!id) throw new Error("drive: upload returned no file id")
  return id
}
