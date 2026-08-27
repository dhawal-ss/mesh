import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const catalogUrl = new URL('../src/config/public-services.json', import.meta.url)
const defaultTimeoutMs = 10_000
const allowedLoginMethods = new Set(['password', 'browser'])
const datePattern = /^\d{4}-\d{2}-\d{2}$/
const maxResponseBytes = 128 * 1024
const maxHealthResponseBytes = 1024

function safeHttpsUrl(value, { originOnly = false, allowFragment = false } = {}) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return false
    if (!allowFragment && url.hash) return false
    if (originOnly && (url.pathname !== '/' || url.search || url.hash)) return false
    return true
  } catch {
    return false
  }
}

function safeMatrixRtcAuthorizationUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && url.port === ''
      && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(url.hostname)
  } catch {
    return false
  }
}

function normalizedEndpoint(value) {
  return String(value ?? '').replace(/\/+$/u, '')
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0
}

function validDate(value) {
  if (!nonEmptyString(value) || !datePattern.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

function optionalPositiveInteger(value) {
  return value === null || (Number.isSafeInteger(value) && value > 0)
}

/**
 * Evaluate the reviewed public-service catalog.
 *
 * Two kinds of assertion live here and they are deliberately not the same kind.
 *
 * Integrity and drift -- a reviewed service quietly changing a security-relevant
 * property -- is fatal, because that is the thing this gate exists to catch.
 *
 * Liveness -- someone else's homeserver being briefly unreachable -- is a
 * warning. Three third-party operators sit behind this check and it gates every
 * merge and every release, so one of them having a bad minute used to block all
 * of them. That is an availability signal about another organisation's
 * infrastructure, not a defect in this repository, and it belongs in the
 * nightly soak instead of on the merge path.
 *
 * The two must not blur: a service that could not be reached has not been
 * checked for drift, so its report says so rather than looking clean.
 */
export async function evaluatePublicServices(catalog, {
  fetchImpl = fetch,
  now = new Date(),
  timeoutMs = defaultTimeoutMs,
} = {}) {
  const errors = []
  // A lapsed review degrades the offer but must never fail the build. See the
  // hard-expiry gate below for why the two are deliberately separate.
  const warnings = []
  const reports = []
  const ids = new Set()
  const domains = new Set()

  function requireValue(condition, message) {
    if (!condition) errors.push(message)
  }

  /**
   * Record that a service could not be reached. Never fatal, but it clears
   * `reachable` so the drift verdict cannot be misread as "checked and clean".
   */
  function markUnreachable(report, message) {
    report.reachable = false
    warnings.push(message)
  }

  async function readBoundedJson(response, label) {
    const declaredLength = Number(response.headers.get('content-length'))
    requireValue(
      !Number.isFinite(declaredLength) || declaredLength <= maxResponseBytes,
      `${label} response exceeds ${maxResponseBytes} bytes`,
    )
    if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) return null

    const bytes = await response.arrayBuffer()
    requireValue(bytes.byteLength <= maxResponseBytes, `${label} response exceeds ${maxResponseBytes} bytes`)
    if (bytes.byteLength > maxResponseBytes) return null
    return JSON.parse(new TextDecoder().decode(bytes))
  }

  if (!Array.isArray(catalog) || catalog.length === 0) {
    errors.push('catalog must be a non-empty array')
  } else {
    for (const [index, service] of catalog.entries()) {
      const path = `catalog[${index}]`
      requireValue(typeof service.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(service.id), `${path}.id is invalid`)
      requireValue(!ids.has(service.id), `${path}.id duplicates ${service.id}`)
      ids.add(service.id)

      const domain = String(service.accountDomain ?? '').toLowerCase()
      requireValue(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain), `${path}.accountDomain is invalid`)
      requireValue(!domains.has(domain), `${path}.accountDomain duplicates ${domain}`)
      domains.add(domain)

      for (const key of ['displayName', 'serviceAddress', 'operator', 'jurisdiction']) {
        requireValue(nonEmptyString(service[key]), `${path}.${key} is required`)
      }
      requireValue(
        Number.isSafeInteger(service.minimumAge)
          && service.minimumAge >= 13
          && service.minimumAge <= 120,
        `${path}.minimumAge must be an explicit age from 13 to 120`,
      )
      requireValue(safeHttpsUrl(service.homeserverUrl, { originOnly: true }), `${path}.homeserverUrl is unsafe`)
      requireValue(
        service.matrixRtc?.type === 'livekit'
          && safeMatrixRtcAuthorizationUrl(service.matrixRtc?.authorizationUrl),
        `${path}.matrixRtc must identify one reviewed HTTPS LiveKit authorization endpoint`,
      )
      requireValue(
        service.registration?.kind === 'external'
          && safeHttpsUrl(service.registration?.url, { allowFragment: true })
          && nonEmptyString(service.registration?.label),
        `${path}.registration must describe a safe external flow`,
      )
      requireValue(
        Array.isArray(service.loginMethods)
          && service.loginMethods.length > 0
          && service.loginMethods.every((method) => allowedLoginMethods.has(method))
          && new Set(service.loginMethods).size === service.loginMethods.length,
        `${path}.loginMethods is invalid`,
      )
      for (const key of ['termsUrl', 'privacyUrl', 'supportUrl']) {
        requireValue(safeHttpsUrl(service[key]), `${path}.${key} is unsafe`)
      }
      requireValue(service.statusUrl === null || safeHttpsUrl(service.statusUrl), `${path}.statusUrl is unsafe`)
      requireValue(
        service.freeUseLimits
          && optionalPositiveInteger(service.freeUseLimits.maxAttachmentBytes)
          && optionalPositiveInteger(service.freeUseLimits.dailyUploadBytes)
          && nonEmptyString(service.freeUseLimits.summary),
        `${path}.freeUseLimits must document known values and unknowns`,
      )
      requireValue(
        Array.isArray(service.notes)
          && service.notes.length > 0
          && service.notes.every(nonEmptyString),
        `${path}.notes are required`,
      )
      requireValue(
        Array.isArray(service.sourceUrls)
          && service.sourceUrls.length > 0
          && service.sourceUrls.every((url) => safeHttpsUrl(url)),
        `${path}.sourceUrls are unsafe`,
      )
      requireValue(typeof service.prominent === 'boolean', `${path}.prominent must be a boolean`)

      const reviewed = new Date(`${service.lastReviewedAt}T00:00:00Z`)
      const expires = new Date(`${service.reviewAfter}T23:59:59.999Z`)
      const hardExpires = new Date(`${service.hardExpiryAfter}T23:59:59.999Z`)
      requireValue(validDate(service.lastReviewedAt), `${path}.lastReviewedAt is invalid`)
      requireValue(validDate(service.reviewAfter) && expires > reviewed, `${path}.reviewAfter is invalid`)
      requireValue(
        validDate(service.hardExpiryAfter) && hardExpires > expires,
        `${path}.hardExpiryAfter must be a valid date after reviewAfter`,
      )
      /*
        The build gate keys off hard expiry, not review expiry, and the difference
        is the point of the split.

        Keying it off reviewAfter meant one date both degraded every installed copy
        and blocked the team from shipping the fix through its own gate: the day
        the catalog went stale was the day the release that would refresh it
        stopped building. A stale review is a prompt to re-check an operator, not a
        reason to make the product unreleasable.
      */
      requireValue(
        hardExpires >= now,
        `${path} passed its hard expiry on ${service.hardExpiryAfter} and must be re-reviewed or removed`,
      )
      if (expires < now) {
        warnings.push(
          `${path} review lapsed on ${service.reviewAfter}: it is still offered for sign-in, `
          + 'but it is no longer recommended and account creation is withdrawn. Re-review it.',
        )
      }
    }
  }

  requireValue(catalog.filter((service) => service.prominent).length === 1, 'catalog must have one prominent service')
  requireValue(catalog.find((service) => service.id === 'matrix-org')?.prominent === true, 'Matrix.org must be the prominent service')

  if (errors.length === 0) {
    for (const service of catalog) {
      const report = {
        id: service.id,
        accountDomain: service.accountDomain,
        reviewedAt: service.lastReviewedAt,
        reviewAfter: service.reviewAfter,
        discovery: 'failed',
        versions: 'failed',
        loginMethods: [],
        matrixRtcFocus: 'failed',
        matrixRtcHealth: 'failed',
        // Whether every endpoint answered. False means the drift checks below
        // did not all run.
        reachable: true,
        // Only true once every live integrity check has actually executed.
        // Never infer "clean" from an unreachable service.
        driftChecked: false,
      }
      try {
        const wellKnownResponse = await fetchImpl(
          `https://${service.accountDomain}/.well-known/matrix/client`,
          { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' },
        )
        // Where the redirect landed is an integrity property, so it stays fatal
        // whatever the status was.
        requireValue(safeHttpsUrl(wellKnownResponse.url), `${service.id} .well-known redirected unsafely`)
        if (!wellKnownResponse.ok) {
          markUnreachable(report, `${service.id} .well-known returned ${wellKnownResponse.status}`)
          reports.push(report)
          continue
        }
        const wellKnown = await readBoundedJson(wellKnownResponse, `${service.id} .well-known`)
        if (!wellKnown) {
          reports.push(report)
          continue
        }
        const discovered = wellKnown?.['m.homeserver']?.base_url
        requireValue(discovered === service.homeserverUrl, `${service.id} discovery changed to ${String(discovered)}`)
        report.discovery = discovered

        const liveKitFoci = (wellKnown?.['org.matrix.msc4143.rtc_foci'] ?? [])
          .filter((focus) => focus?.type === 'livekit')
        const expectedFocus = normalizedEndpoint(service.matrixRtc.authorizationUrl)
        requireValue(liveKitFoci.length === 1, `${service.id} must advertise exactly one LiveKit focus`)
        requireValue(
          liveKitFoci.every((focus) => safeMatrixRtcAuthorizationUrl(focus?.livekit_service_url)),
          `${service.id} advertises an unsafe LiveKit focus`,
        )
        requireValue(
          normalizedEndpoint(liveKitFoci[0]?.livekit_service_url) === expectedFocus,
          `${service.id} LiveKit focus changed from the reviewed endpoint`,
        )
        report.matrixRtcFocus = liveKitFoci[0]?.livekit_service_url ?? 'failed'

        const healthResponse = await fetchImpl(`${expectedFocus}/healthz`, {
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        })
        if (healthResponse.status !== 200) {
          markUnreachable(report, `${service.id} MatrixRTC health returned ${healthResponse.status}`)
        }
        // The size bound is an anti-abuse limit, not a liveness signal, so it
        // stays fatal even when the endpoint is unhealthy.
        const healthLength = Number(healthResponse.headers.get('content-length'))
        requireValue(
          !Number.isFinite(healthLength) || healthLength <= maxHealthResponseBytes,
          `${service.id} MatrixRTC health response exceeds ${maxHealthResponseBytes} bytes`,
        )
        if (healthResponse.status === 200
          && (!Number.isFinite(healthLength) || healthLength <= maxHealthResponseBytes)) {
          const healthBytes = await healthResponse.arrayBuffer()
          requireValue(
            healthBytes.byteLength <= maxHealthResponseBytes,
            `${service.id} MatrixRTC health response exceeds ${maxHealthResponseBytes} bytes`,
          )
          if (healthBytes.byteLength <= maxHealthResponseBytes) report.matrixRtcHealth = 'healthy'
        }

        const versionsResponse = await fetchImpl(
          `${service.homeserverUrl}/_matrix/client/versions`,
          { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' },
        )
        if (!versionsResponse.ok) {
          markUnreachable(report, `${service.id} versions returned ${versionsResponse.status}`)
        }
        if (versionsResponse.ok) {
          const versions = await readBoundedJson(versionsResponse, `${service.id} versions`)
          if (!versions) {
            reports.push(report)
            continue
          }
          requireValue(Array.isArray(versions.versions) && versions.versions.length > 0, `${service.id} returned no Matrix versions`)
          report.versions = versions.versions
        }

        const loginResponse = await fetchImpl(
          `${service.homeserverUrl}/_matrix/client/v3/login`,
          { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' },
        )
        if (!loginResponse.ok) {
          markUnreachable(report, `${service.id} login discovery returned ${loginResponse.status}`)
        }
        if (loginResponse.ok) {
          const login = await readBoundedJson(loginResponse, `${service.id} login discovery`)
          if (!login) {
            reports.push(report)
            continue
          }
          const liveMethods = new Set((login.flows ?? []).map((flow) => flow.type))
          const expectedPassword = service.loginMethods.includes('password')
          const expectedBrowser = service.loginMethods.includes('browser')
          requireValue(liveMethods.has('m.login.password') === expectedPassword, `${service.id} password login metadata is stale`)
          requireValue((liveMethods.has('m.login.sso') || liveMethods.has('m.login.token')) === expectedBrowser, `${service.id} browser login metadata is stale`)
          report.loginMethods = [...liveMethods].sort()
        }
        // Every live integrity check above ran only if every endpoint answered.
        report.driftChecked = report.reachable
      } catch (error) {
        // A timeout, a DNS blip or a malformed response from someone else's
        // homeserver is an availability fact about them, not a defect here.
        // driftChecked stays false, so this can never read as "verified clean".
        markUnreachable(
          report,
          `${service.id} endpoint check failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      reports.push(report)
    }
  }

  return {
    checkedAt: now.toISOString(),
    catalog: reports,
    errors,
    warnings,
  }
}

async function main() {
  const catalog = JSON.parse(await readFile(catalogUrl, 'utf8'))
  const result = await evaluatePublicServices(catalog)
  console.log(JSON.stringify(result, null, 2))
  if (result.errors.length > 0) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
