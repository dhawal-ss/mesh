import { describe, expect, it } from 'vitest'
import {
  MATRIX_ORG_SERVICE,
  PUBLIC_SERVICES,
  publicServiceReviewExpired,
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
    expect(publicServiceReviewExpired(PUBLIC_SERVICES[0], new Date('2026-08-29T23:59:59Z'))).toBe(false)
    expect(publicServiceReviewExpired(PUBLIC_SERVICES[0], new Date('2026-08-30T00:00:00Z'))).toBe(true)
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
