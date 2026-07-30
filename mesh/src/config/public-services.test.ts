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

  it('requires legal, registration, and review metadata', () => {
    const incomplete = {
      ...PUBLIC_SERVICES[0],
      id: 'incomplete',
      accountDomain: 'incomplete.example',
      termsUrl: '',
      registration: { kind: 'external', url: 'https://user:secret@example.com/', label: '' },
      reviewAfter: '2026-07-01',
    }
    const result = validatePublicServiceCatalog([incomplete])

    expect(result.services).toEqual([])
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('registration must provide a safe external HTTPS flow'),
      expect.stringContaining('termsUrl must be a safe HTTPS URL'),
      expect.stringContaining('reviewAfter must follow lastReviewedAt'),
    ]))
  })
})
