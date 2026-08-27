import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { evaluatePublicServices } from './check-public-services.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/*
  These run against the real reviewed catalog rather than a hand-written one, so
  a change to src/config/public-services.json that breaks its own shape shows up
  here too. Only the network is stubbed.

  `now` is pinned inside every service's review window; the hard-expiry gate is
  a real fatal assertion and a wall-clock `now` would eventually fire it here.
*/
const now = new Date('2026-09-01T00:00:00.000Z')

async function catalog() {
  return JSON.parse(await readFile(path.join(projectRoot, 'src/config/public-services.json'), 'utf8'))
}

function jsonResponse(url, body, status = 200) {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: () => null },
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  }
}

function healthResponse(url, status = 200) {
  return {
    ok: status === 200,
    status,
    url,
    headers: { get: () => null },
    arrayBuffer: async () => new TextEncoder().encode('OK').buffer,
  }
}

/**
 * Serve exactly what a healthy, undrifted deployment would return, with
 * per-service overrides for the failure cases.
 */
function stubFetch(services, overrides = {}) {
  const byDomain = new Map(services.map((service) => [service.accountDomain, service]))
  const byHomeserver = new Map(services.map((service) => [service.homeserverUrl, service]))
  const byFocus = new Map(services.map((service) => [service.matrixRtc.authorizationUrl, service]))

  return async (url) => {
    const target = String(url)

    for (const [domain, service] of byDomain) {
      if (target === `https://${domain}/.well-known/matrix/client`) {
        const override = overrides[service.id] ?? {}
        if (override.wellKnownStatus) return jsonResponse(target, {}, override.wellKnownStatus)
        if (override.throws) throw new Error(override.throws)
        return jsonResponse(target, {
          'm.homeserver': { base_url: service.homeserverUrl },
          'org.matrix.msc4143.rtc_foci': [{
            type: 'livekit',
            livekit_service_url: override.focus ?? service.matrixRtc.authorizationUrl,
          }],
        })
      }
    }

    for (const [focus, service] of byFocus) {
      if (target === `${focus}/healthz`) {
        const override = overrides[service.id] ?? {}
        if (override.throws) throw new Error(override.throws)
        return healthResponse(target, override.healthStatus ?? 200)
      }
    }

    for (const [homeserver, service] of byHomeserver) {
      const override = overrides[service.id] ?? {}
      if (target === `${homeserver}/_matrix/client/versions`) {
        if (override.throws) throw new Error(override.throws)
        return jsonResponse(target, { versions: ['v1.11'] }, override.versionsStatus ?? 200)
      }
      if (target === `${homeserver}/_matrix/client/v3/login`) {
        if (override.throws) throw new Error(override.throws)
        const flows = []
        if (service.loginMethods.includes('password')) flows.push({ type: 'm.login.password' })
        if (service.loginMethods.includes('browser')) flows.push({ type: 'm.login.sso' })
        return jsonResponse(target, { flows }, override.loginStatus ?? 200)
      }
    }

    throw new Error(`unstubbed request: ${target}`)
  }
}

test('all services healthy and undrifted passes with no errors or warnings', async () => {
  const services = await catalog()
  const result = await evaluatePublicServices(services, { fetchImpl: stubFetch(services), now })

  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, [])
  assert.equal(result.catalog.length, services.length)
  for (const entry of result.catalog) {
    assert.equal(entry.reachable, true, `${entry.id} should be reachable`)
    assert.equal(entry.driftChecked, true, `${entry.id} drift should have been checked`)
    assert.equal(entry.matrixRtcHealth, 'healthy')
  }
})

test('a 502 from one MatrixRTC health endpoint warns instead of failing the build', async () => {
  const services = await catalog()
  const result = await evaluatePublicServices(services, {
    fetchImpl: stubFetch(services, { 'tchncs-de': { healthStatus: 502 } }),
    now,
  })

  // The whole point: someone else's server being down must not block a merge.
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, ['tchncs-de MatrixRTC health returned 502'])

  const degraded = result.catalog.find((entry) => entry.id === 'tchncs-de')
  assert.equal(degraded.reachable, false)
  assert.equal(degraded.driftChecked, false, 'an unreachable service must not read as drift-checked')

  // The other operators are unaffected and still fully verified.
  for (const entry of result.catalog.filter((item) => item.id !== 'tchncs-de')) {
    assert.equal(entry.reachable, true)
    assert.equal(entry.driftChecked, true)
  }
})

test('an unreachable .well-known warns and reports the service as unverified', async () => {
  const services = await catalog()
  const result = await evaluatePublicServices(services, {
    fetchImpl: stubFetch(services, { 'quassel-io': { wellKnownStatus: 503 } }),
    now,
  })

  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, ['quassel-io .well-known returned 503'])
  const degraded = result.catalog.find((entry) => entry.id === 'quassel-io')
  assert.equal(degraded.reachable, false)
  assert.equal(degraded.driftChecked, false)
})

test('a stale versions or login endpoint warns without failing the build', async () => {
  const services = await catalog()
  const result = await evaluatePublicServices(services, {
    fetchImpl: stubFetch(services, {
      'matrix-org': { versionsStatus: 500 },
      'tchncs-de': { loginStatus: 429 },
    }),
    now,
  })

  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings.sort(), [
    'matrix-org versions returned 500',
    'tchncs-de login discovery returned 429',
  ])
  for (const id of ['matrix-org', 'tchncs-de']) {
    assert.equal(result.catalog.find((entry) => entry.id === id).driftChecked, false)
  }
})

test('a LiveKit focus moving off the reviewed endpoint still fails the build', async () => {
  const services = await catalog()
  const result = await evaluatePublicServices(services, {
    fetchImpl: stubFetch(services, {
      'matrix-org': { focus: 'https://livekit-jwt.attacker.example' },
    }),
    now,
  })

  // Drift is the thing this gate exists to catch. It must survive the liveness
  // relaxation completely.
  assert.equal(result.errors.length > 0, true, 'focus drift must be fatal')
  assert.deepEqual(result.errors, ['matrix-org LiveKit focus changed from the reviewed endpoint'])
})

test('a fetch that throws warns rather than failing the build', async () => {
  const services = await catalog()
  const result = await evaluatePublicServices(services, {
    fetchImpl: stubFetch(services, { 'tchncs-de': { throws: 'ETIMEDOUT' } }),
    now,
  })

  assert.deepEqual(result.errors, [])
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /^tchncs-de endpoint check failed: ETIMEDOUT$/)

  const degraded = result.catalog.find((entry) => entry.id === 'tchncs-de')
  assert.equal(degraded.reachable, false)
  assert.equal(degraded.driftChecked, false)
})

test('catalog shape problems remain fatal', async () => {
  const services = await catalog()
  const broken = services.map((service) => ({ ...service, prominent: false }))
  const result = await evaluatePublicServices(broken, { fetchImpl: stubFetch(broken), now })

  assert.equal(result.errors.includes('catalog must have one prominent service'), true)
})
