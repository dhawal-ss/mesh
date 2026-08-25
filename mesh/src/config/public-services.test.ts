import { describe, expect, it } from 'vitest'
import {
  MATRIX_ORG_SERVICE,
  PUBLIC_SERVICES,
  publicServiceReviewExpired,
  publicServiceUnavailable,
  validatePublicServiceCatalog,
} from './public-services'

describe('public-service catalog', () => {
  it('ships a valid, explicitly reviewed Matrix.org-first catalog', () => {
    expect(PUBLIC_SERVICES.map((service) => service.id)).toEqual([
      'matrix-org',
      'tchncs-de',
      'quassel-io',
    ])
    expect(MATRIX_ORG_SERVICE).toMatchObject({
      accountDomain: 'matrix.org',
      minimumAge: 18,
      prominent: true,
      operator: 'The Matrix.org Foundation C.I.C.',
      freeUseLimits: {
        maxAttachmentBytes: 10 * 1024 * 1024,
        dailyUploadBytes: 100 * 1024 * 1024,
      },
    })
  })

  it('marks metadata unavailable after its explicit review window', () => {
    expect(publicServiceReviewExpired(PUBLIC_SERVICES[0], new Date('2027-02-28T23:59:59Z'))).toBe(false)
    expect(publicServiceReviewExpired(PUBLIC_SERVICES[0], new Date('2027-03-01T00:00:00Z'))).toBe(true)
  })

  it('separates a lapsed review from the entry ageing out entirely', () => {
    // The window between the two dates is the whole point: the build ships with
    // no update channel, so an installed copy must keep working through a review
    // lapse instead of losing every account option on one day.
    const service = PUBLIC_SERVICES[0]
    const betweenTheDates = new Date('2027-05-01T00:00:00Z')
    expect(publicServiceReviewExpired(service, betweenTheDates)).toBe(true)
    expect(publicServiceUnavailable(service, betweenTheDates)).toBe(false)

    expect(publicServiceUnavailable(service, new Date('2027-08-31T23:59:59Z'))).toBe(false)
    expect(publicServiceUnavailable(service, new Date('2027-09-01T00:00:00Z'))).toBe(true)
  })

  it('gives every shipped service a hard expiry well past its review date', () => {
    for (const service of PUBLIC_SERVICES) {
      expect(service.hardExpiryAfter > service.reviewAfter).toBe(true)
    }
  })

  it('rejects a hard expiry that does not follow the review date', () => {
    const collapsed = {
      ...PUBLIC_SERVICES[0],
      hardExpiryAfter: PUBLIC_SERVICES[0].reviewAfter,
    }
    const result = validatePublicServiceCatalog([collapsed])
    expect(result.errors).toContain('catalog[0].hardExpiryAfter must follow reviewAfter')
  })

  it('rejects duplicate domains and unsafe service URLs', () => {
    const duplicate = {
      ...PUBLIC_SERVICES[0],
      id: 'duplicate',
      homeserverUrl: 'http://matrix.example',
      prominent: false,
    }
    const result = validatePublicServiceCatalog([PUBLIC_SERVICES[0], duplicate])

    expect(result.services).toEqual([])
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('accountDomain duplicates matrix.org'),
      expect.stringContaining('homeserverUrl must be a credential-free HTTPS origin'),
    ]))
  })

  it('validates provider-owned account help URLs when a service publishes one', () => {
    const unsafe = {
      ...PUBLIC_SERVICES[0],
      id: 'unsafe-help',
      accountDomain: 'unsafe-help.example',
      accountHelpUrl: 'http://unsafe-help.example/login',
      prominent: false,
    }
    const result = validatePublicServiceCatalog([PUBLIC_SERVICES[0], unsafe])

    expect(result.services).toEqual([])
    expect(result.errors).toContain(
      'catalog[1].accountHelpUrl must be undefined or a safe HTTPS URL',
    )
  })

  it('requires legal, registration, and review metadata', () => {
    const incomplete = {
      ...PUBLIC_SERVICES[0],
      id: 'incomplete',
      accountDomain: 'incomplete.example',
      termsUrl: '',
      registration: { kind: 'external', url: 'https://user:secret@example.com/', label: '' },
      minimumAge: 0,
      reviewAfter: '2026-07-01',
    }
    const result = validatePublicServiceCatalog([incomplete])

    expect(result.services).toEqual([])
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('registration must provide a safe external HTTPS flow'),
      expect.stringContaining('termsUrl must be a safe HTTPS URL'),
      expect.stringContaining('minimumAge must be an explicit age'),
      expect.stringContaining('reviewAfter must follow lastReviewedAt'),
    ]))
  })
})
