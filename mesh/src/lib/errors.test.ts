import { describe, expect, it } from 'vitest'
import {
  AppError,
  describeError,
  errorDetail,
  normalizeError,
} from './errors'

describe('normalizeError', () => {
  const rustCodes = [
    'not_authenticated',
    'database_error',
    'network_unavailable',
    'crypto_error',
    'identity_error',
    'not_found',
    'permission_denied',
    'serialization_error',
    'validation_error',
    'rate_limited',
    'banned',
    'unsupported_operation',
    'login_cancelled',
    'login_timed_out',
    'unexpected_error',
  ] as const

  it('normalizes string rejections from Tauri into a real coded Error', () => {
    const error = normalizeError('connection refused while contacting the server')

    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(AppError)
    expect(error.code).toBe('network_unavailable')
    expect(error.detail).toBe('connection refused while contacting the server')
    expect(error.retryable).toBe(true)
  })

  it('preserves an Error message while assigning an inferred code', () => {
    const source = new Error('M_FORBIDDEN: membership required')
    const error = normalizeError(source)

    expect(error).not.toBe(source)
    expect(error.code).toBe('permission_denied')
    expect(error.detail).toBe(source.message)
    expect(error.retryable).toBe(false)
  })

  it('reads the planned serialized Rust error payload', () => {
    const error = normalizeError({
      code: 'RateLimited',
      detail: 'M_LIMIT_EXCEEDED; retry_after_ms=5000',
      retryable: false,
    })

    expect(error.code).toBe('rate_limited')
    expect(error.detail).toContain('M_LIMIT_EXCEEDED')
    expect(error.retryable).toBe(false)
  })

  it('accepts object rejections with a message field', () => {
    const error = normalizeError({ message: 'room not found' })

    expect(error.code).toBe('room_not_found')
    expect(error.detail).toBe('room not found')
  })

  it('turns nullish and opaque values into a safe unknown error', () => {
    expect(normalizeError(null)).toMatchObject({
      code: 'unknown',
      detail: 'Unknown error',
      retryable: false,
    })
    expect(normalizeError(42)).toMatchObject({
      code: 'unknown',
      detail: 'Unknown error',
      retryable: false,
    })
  })

  it('does not wrap an already normalized error again', () => {
    const source = new AppError('server_error', 'status 500')
    expect(normalizeError(source)).toBe(source)
  })

  it.each(rustCodes)('preserves the Rust command code %s', (code) => {
    const error = normalizeError({ code, detail: `technical detail for ${code}`, retryable: false })
    expect(error.code).toBe(code)
    expect(describeError(error).title).not.toBe('Something went wrong')
  })
})

describe('describeError', () => {
  it('uses stable friendly copy without putting technical detail in the headline', () => {
    const error = new AppError('permission_denied', 'M_FORBIDDEN: internal room !secret:example.org')
    const description = describeError(error, { operation: 'join this server' })

    expect(description).toEqual({
      title: 'Permission needed',
      body: "Mesh couldn't join this server. Your account does not have permission for this action.",
      action: null,
    })
    expect(`${description.title} ${description.body}`).not.toContain('M_FORBIDDEN')
    expect(`${description.title} ${description.body}`).not.toContain('!secret:example.org')
  })

  it('accepts a stable error code directly', () => {
    expect(describeError('not_authenticated', { operation: 'send a message' })).toEqual({
      title: 'Sign in required',
      body: "Mesh couldn't send a message. Sign in again, then retry.",
      action: 'Sign in',
    })
  })

  it('maps a raw string as detail instead of mistaking it for a code', () => {
    expect(describeError('connection refused', { operation: 'refresh' })).toMatchObject({
      title: 'Connection interrupted',
      action: 'Try again',
    })
  })
})

describe('errorDetail', () => {
  it('keeps useful diagnostics while redacting local paths and common secrets', () => {
    const details = errorDetail(
      new Error(
        'failed at C:\\Users\\alice\\Mesh\\session.json access_token=super-secret https://example.org/?token=abc',
      ),
    )

    expect(details).toContain('[unknown]')
    expect(details).toContain('[local path]')
    expect(details).toContain('access_token=[redacted]')
    expect(details).toContain('token=[redacted]')
    expect(details).not.toContain('super-secret')
    expect(details).not.toContain('C:\\Users\\alice')
  })
})
