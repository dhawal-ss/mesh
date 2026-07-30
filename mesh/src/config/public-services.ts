import catalogDocument from './public-services.json'

export type PublicServiceLoginMethod = 'password' | 'browser'

export interface PublicServiceRegistration {
  kind: 'external'
  url: string
  label: string
}

export interface PublicServiceLimits {
  maxAttachmentBytes: number | null
  dailyUploadBytes: number | null
  summary: string
}

export interface PublicService {
  id: string
  displayName: string
  accountDomain: string
  serviceAddress: string
  homeserverUrl: string
  operator: string
  jurisdiction: string
  registration: PublicServiceRegistration
  loginMethods: PublicServiceLoginMethod[]
  termsUrl: string
  privacyUrl: string
  supportUrl: string
  statusUrl: string | null
  freeUseLimits: PublicServiceLimits
  notes: string[]
  sourceUrls: string[]
  lastReviewedAt: string
  reviewAfter: string
  prominent: boolean
}

export interface PublicServiceCatalogValidation {
  services: PublicService[]
  errors: string[]
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const LOGIN_METHODS = new Set<PublicServiceLoginMethod>(['password', 'browser'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0
}

function safeHttpsUrl(
  value: unknown,
  options: { originOnly?: boolean; allowFragment?: boolean } = {},
): value is string {
  if (!nonEmptyString(value)) return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return false
    if (!options.allowFragment && url.hash) return false
    if (options.originOnly && (url.pathname !== '/' || url.search || url.hash)) return false
    return true
  } catch {
    return false
  }
}

function validDate(value: unknown): value is string {
  if (!nonEmptyString(value) || !DATE_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

function optionalPositiveInteger(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && Number(value) > 0)
}

export function validatePublicServiceCatalog(value: unknown): PublicServiceCatalogValidation {
  if (!Array.isArray(value)) {
    return { services: [], errors: ['catalog must be an array'] }
  }

  const services: PublicService[] = []
  const errors: string[] = []
  const ids = new Set<string>()
  const domains = new Set<string>()

  value.forEach((candidate, index) => {
    const path = `catalog[${index}]`
    if (!isRecord(candidate)) {
      errors.push(`${path} must be an object`)
      return
    }

    const id = candidate.id
    const domain = candidate.accountDomain
    if (!nonEmptyString(id) || !ID_PATTERN.test(id)) {
      errors.push(`${path}.id must be a stable lowercase identifier`)
    } else if (ids.has(id)) {
      errors.push(`${path}.id duplicates ${id}`)
    } else {
      ids.add(id)
    }
    if (!nonEmptyString(domain) || !DOMAIN_PATTERN.test(domain)) {
      errors.push(`${path}.accountDomain must be a DNS domain`)
    } else {
      const normalizedDomain = domain.toLowerCase()
      if (domains.has(normalizedDomain)) {
        errors.push(`${path}.accountDomain duplicates ${normalizedDomain}`)
      } else {
        domains.add(normalizedDomain)
      }
    }

    for (const key of ['displayName', 'serviceAddress', 'operator', 'jurisdiction'] as const) {
      if (!nonEmptyString(candidate[key])) errors.push(`${path}.${key} is required`)
    }
    if (!safeHttpsUrl(candidate.homeserverUrl, { originOnly: true })) {
      errors.push(`${path}.homeserverUrl must be a credential-free HTTPS origin`)
    }

    const registration = candidate.registration
    if (
      !isRecord(registration)
      || registration.kind !== 'external'
      || !safeHttpsUrl(registration.url, { allowFragment: true })
      || !nonEmptyString(registration.label)
    ) {
      errors.push(`${path}.registration must provide a safe external HTTPS flow`)
    }

    const loginMethods = candidate.loginMethods
    if (
      !Array.isArray(loginMethods)
      || loginMethods.length === 0
      || loginMethods.some((method) => typeof method !== 'string' || !LOGIN_METHODS.has(method as PublicServiceLoginMethod))
      || new Set(loginMethods).size !== loginMethods.length
    ) {
      errors.push(`${path}.loginMethods must contain unique supported methods`)
    }

    for (const key of ['termsUrl', 'privacyUrl', 'supportUrl'] as const) {
      if (!safeHttpsUrl(candidate[key])) errors.push(`${path}.${key} must be a safe HTTPS URL`)
    }
    if (candidate.statusUrl !== null && !safeHttpsUrl(candidate.statusUrl)) {
      errors.push(`${path}.statusUrl must be null or a safe HTTPS URL`)
    }

    const limits = candidate.freeUseLimits
    if (
      !isRecord(limits)
      || !optionalPositiveInteger(limits.maxAttachmentBytes)
      || !optionalPositiveInteger(limits.dailyUploadBytes)
      || !nonEmptyString(limits.summary)
    ) {
      errors.push(`${path}.freeUseLimits must document known values and unknowns`)
    }

    if (
      !Array.isArray(candidate.notes)
      || candidate.notes.length === 0
      || candidate.notes.some((note) => !nonEmptyString(note))
    ) {
      errors.push(`${path}.notes must contain reader-facing disclosures`)
    }
    if (
      !Array.isArray(candidate.sourceUrls)
      || candidate.sourceUrls.length === 0
      || candidate.sourceUrls.some((url) => !safeHttpsUrl(url))
    ) {
      errors.push(`${path}.sourceUrls must contain safe operator or endpoint URLs`)
    }

    if (!validDate(candidate.lastReviewedAt)) {
      errors.push(`${path}.lastReviewedAt must be an ISO date`)
    }
    if (!validDate(candidate.reviewAfter)) {
      errors.push(`${path}.reviewAfter must be an ISO date`)
    } else if (
      validDate(candidate.lastReviewedAt)
      && candidate.reviewAfter <= candidate.lastReviewedAt
    ) {
      errors.push(`${path}.reviewAfter must follow lastReviewedAt`)
    }
    if (typeof candidate.prominent !== 'boolean') {
      errors.push(`${path}.prominent must be a boolean`)
    }

    const errorCount = errors.length
    if (errorCount === 0 || !errors.slice(0, errorCount).some((error) => error.startsWith(`${path}.`))) {
      services.push(candidate as unknown as PublicService)
    }
  })

  if (services.filter((service) => service.prominent).length !== 1) {
    errors.push('catalog must contain exactly one prominent public service')
  }

  return { services: errors.length === 0 ? services : [], errors }
}

export function publicServiceReviewExpired(service: PublicService, now = new Date()): boolean {
  return new Date(`${service.reviewAfter}T23:59:59.999Z`).valueOf() < now.valueOf()
}

const validatedCatalog = validatePublicServiceCatalog(catalogDocument)
if (validatedCatalog.errors.length > 0) {
  throw new Error(`Invalid public-service catalog: ${validatedCatalog.errors.join('; ')}`)
}

export const PUBLIC_SERVICES = Object.freeze(validatedCatalog.services)
const matrixOrgService = PUBLIC_SERVICES.find((service) => service.id === 'matrix-org')

if (!matrixOrgService?.prominent) {
  throw new Error('The public-service catalog must make Matrix.org the prominent option')
}

export const MATRIX_ORG_SERVICE: PublicService = matrixOrgService
