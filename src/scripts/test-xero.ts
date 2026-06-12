// Verifies the Xero connection end-to-end: refreshes the (long-expired
// access) token, persists the rotated refresh token, and reads the org name.
//   docker compose exec inbox node dist/scripts/test-xero.js

import { xero } from "../xero/client.js"
import { getTokens, saveTokens } from "../db/queries.js"

async function main(): Promise<void> {
  const stored = await getTokens("xero")
  if (!stored) throw new Error("xero not linked")
  console.log(`stored token expiry: ${stored.expiry?.toISOString()}`)
  const c = xero()
  c.setTokenSet({
    access_token: stored.access_token,
    refresh_token: stored.refresh_token ?? undefined,
    scope: stored.scope ?? undefined,
    token_type: stored.token_type ?? undefined,
    expires_at: stored.expiry
      ? Math.floor(stored.expiry.getTime() / 1000)
      : undefined,
  })
  const refreshed = await c.refreshToken()
  await saveTokens({
    provider: "xero",
    access_token: refreshed.access_token ?? "",
    refresh_token: refreshed.refresh_token ?? null,
    scope: refreshed.scope ?? null,
    token_type: refreshed.token_type ?? null,
    expiry: refreshed.expires_at ? new Date(refreshed.expires_at * 1000) : null,
  })
  console.log(
    `refreshed OK — new expiry ${refreshed.expires_at ? new Date(refreshed.expires_at * 1000).toISOString() : "?"}`
  )
  const tenants =
    (stored.extra?.["tenants"] as Array<{ tenantId: string; tenantName: string }>) ?? []
  const tenant =
    tenants.find((t) => /Tarte Currumbin/i.test(t.tenantName)) ?? tenants[0]
  if (!tenant) throw new Error("no tenants stored")
  const org = await c.accountingApi.getOrganisations(tenant.tenantId)
  console.log(`org reachable: ${org.body.organisations?.[0]?.name}`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("XERO TEST FAILED:", e instanceof Error ? e.message : e)
    process.exit(1)
  })
