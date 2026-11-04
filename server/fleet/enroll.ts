/**
 * Claiming a fresh tenant, and enrolling agents into it.
 *
 * Enrollment is the frontend's mintEnrollment and enroll/claim with their logic
 * unchanged, except who may mint: any owner or manager of the tenant, where the
 * frontend allowed only the system's owner.
 */
import { buildClientConfig, DEFAULT_TTL_MS, generateEnrollmentToken, generateSystemKey, hashToken, randomHex, resolvePlugins } from "~/server/utils/enrollment"
import { atLeast, ownerId, roleOf } from "./access"
import { HttpError } from "./ctx"
import type { Identity } from "./jwt"
import type { Db } from "./db"

/** Same length either way, so the comparison can't leak how much matched. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([hashToken(a), hashToken(b)])
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i)
  return diff === 0
}

/**
 * The first sign-in to a new tenant. CLAIM_CODE is set when the tenant is
 * deployed; without it, whoever reached a fresh deploy first would own it.
 * Works once: after that the tenant has an owner and this refuses.
 */
export async function claimTenant(db: Db, who: Identity, code: string, claimCode: string | undefined) {
  if (!claimCode) throw new HttpError(503, "This tenant has no CLAIM_CODE set. Add it as a secret and redeploy.")
  const { count } = await db.from("members").select("*", { count: "exact", head: true })
  if (count) throw new HttpError(409, "This tenant already has an owner")
  if (!code || !(await sameSecret(code, claimCode))) throw new HttpError(403, "Wrong claim code")
  await db.from("members").insert({ user_id: who.sub, email: who.email, role: "owner" })
  return { role: "owner" as const }
}

/** A token an agent trades for its key, creating the system unless one is named. */
export async function mintEnrollment(
  db: Db,
  who: Identity,
  opts: { systemId?: string; name?: string; plugins?: string[] },
  origin: string,
) {
  if (!atLeast(await roleOf(db, who), "manager")) throw new HttpError(403, "Only an owner or manager can add systems")
  const owner = await ownerId(db)
  if (!owner) throw new HttpError(409, "This tenant hasn't been claimed yet")

  const plugins = (opts.plugins || []).map(String).filter(Boolean)
  let systemId = opts.systemId
  // A blank name means the agent's hostname wins at claim time.
  const requestedName = (opts.name || "").trim()
  let autoname = !requestedName

  if (systemId) {
    const { data: existing } = await db.from("systems").select("id").eq("id", systemId).maybeSingle()
    if (!existing) throw new HttpError(404, "System not found")
    // The system already has whatever name it has.
    autoname = false
  } else {
    const name = requestedName || "Awaiting agent"
    // The random suffix only earns its place on the placeholder name, where
    // several unclaimed systems would otherwise collide on "awaiting-agent".
    const base = name.toLowerCase().replace(/[^\w-]+/g, "-")
    const slug = autoname ? `${base}-${randomHex(3)}` : base
    const { data: created, error } = await db
      .from("systems")
      .insert({ user_id: owner, name, slug, key_hash: await hashToken(generateSystemKey()), status: "pending", status_reason: "Waiting for the agent to enroll" })
      .select("id")
      .single()
    if (error) throw new HttpError(500, error.message)
    systemId = created.id
  }

  const token = generateEnrollmentToken()
  const expiresAt = new Date(Date.now() + DEFAULT_TTL_MS).toISOString()
  const { error: tokenError } = await db.from("enrollment_tokens").insert({
    user_id: who.sub,
    system_id: systemId,
    token_hash: await hashToken(token),
    plugins,
    autoname,
    expires_at: expiresAt,
  })
  if (tokenError) throw new HttpError(500, tokenError.message)

  // A tenant is never at the agent's compiled-in default, so the endpoint is always spelled out.
  return { systemId: systemId!, token, expiresAt, command: `npx @daemonitor/client --token ${token} --endpoint ${origin}/api` }
}

/**
 * Trade a single-use enrollment token for a system key. Unauthenticated by
 * necessity: the agent has no credentials yet, and the token is the credential.
 */
export async function claimEnrollment(db: Db, body: any, clientIp: string | null, origin: string) {
  const token = typeof body?.token === "string" ? body.token.trim() : ""
  if (!token) throw new HttpError(400, "Missing enrollment token")
  const tokenHash = await hashToken(token)

  // Burn the token and read it back in one statement, so two agents racing on
  // one token can't both get a key.
  const claimedAt = new Date().toISOString()
  const { data: claimed, error: claimError } = await db
    .from("enrollment_tokens")
    .update({
      claimed_at: claimedAt,
      claimed_ip: clientIp,
      claimed_hostname: body?.hostname || null,
      claimed_machine_id: body?.machineId || null,
    })
    .eq("token_hash", tokenHash)
    .is("claimed_at", null)
    .gt("expires_at", claimedAt)
    .select("id, user_id, system_id, plugins, autoname")
    .maybeSingle()
  if (claimError) throw new HttpError(500, claimError.message)

  if (!claimed) {
    // Say which of the three it was: a typo, a second run, or too late.
    const { data: existing } = await db.from("enrollment_tokens").select("claimed_at, expires_at").eq("token_hash", tokenHash).maybeSingle()
    if (!existing) throw new HttpError(401, "Enrollment token not recognized")
    if (existing.claimed_at) throw new HttpError(409, "Enrollment token was already used. Generate a new one from the dashboard.")
    throw new HttpError(410, "Enrollment token has expired. Generate a new one from the dashboard.")
  }

  const { data: system } = await db.from("systems").select("id, name").eq("id", claimed.system_id).maybeSingle()
  if (!system) throw new HttpError(404, "System not found")

  // What the agent found on the box beats what the dialog guessed.
  // ponytail: no module filter yet; plugins outside the tenant's entitlement
  // come back once entitlements exist.
  const plugins = resolvePlugins(claimed.plugins || [], body?.detected || [])

  // Only the hash is stored, so the agent gets a new key here. Re-enrolling a
  // system replaces its agent's key.
  const systemKey = generateSystemKey()
  const updates: Record<string, any> = {
    key_hash: await hashToken(systemKey),
    previous_key_hash: null,
    previous_key_used_at: null,
    ip_address: clientIp,
    updated_at: claimedAt,
  }
  if (body?.os) {
    updates.os = { type: body.os.type || "other", name: body.os.name || "", version: body.os.version || "", arch: body.os.arch || "" }
  }
  // The operator left the name blank, so the machine names itself.
  if (claimed.autoname && body?.hostname) {
    updates.name = body.hostname
    updates.slug = String(body.hostname).toLowerCase().replace(/[^\w-]+/g, "-")
  }
  const { data: updated } = await db.from("systems").update(updates).eq("id", system.id).select("name").maybeSingle()

  return {
    systemKey,
    systemId: system.id,
    name: updated?.name || system.name,
    config: buildClientConfig(plugins, { apiBaseUrl: `${origin}/api` }),
  }
}
