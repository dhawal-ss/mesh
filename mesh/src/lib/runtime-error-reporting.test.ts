import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_RUNTIME_ERROR_RECORDS,
  captureRuntimeError,
  clearRuntimeErrorRecords,
  createRuntimeErrorReport,
  getRuntimeErrorSummary,
  installRuntimeErrorListeners,
  serializeRuntimeErrorReport,
  setRuntimeErrorRecordingEnabled,
} from './runtime-error-reporting'

describe('runtime error reporting privacy boundary', () => {
  beforeEach(() => {
    setRuntimeErrorRecordingEnabled(false)
    clearRuntimeErrorRecords()
  })

  it('records nothing until the user opts in and clears records on opt-out', () => {
    captureRuntimeError('window', new TypeError('private message'))
    expect(getRuntimeErrorSummary()).toEqual({
      recordingEnabled: false,
      storedCount: 0,
      recent: [],
    })

    setRuntimeErrorRecordingEnabled(true)
    captureRuntimeError('window', new TypeError('private message'), new Date('2026-08-08T12:00:00Z'))
    expect(getRuntimeErrorSummary().recent).toEqual([{
      occurredAt: '2026-08-08T12:00:00.000Z',
      source: 'window',
      kind: 'TypeError',
    }])

    setRuntimeErrorRecordingEnabled(false)
    setRuntimeErrorRecordingEnabled(true)
    expect(getRuntimeErrorSummary().storedCount).toBe(0)
  })

  it('bounds stored records and excludes messages, paths, account details, and unknown names', () => {
    setRuntimeErrorRecordingEnabled(true)
    const privateText = '@person:private.example C:\\Users\\person access_token=secret message body'
    for (let index = 0; index < MAX_RUNTIME_ERROR_RECORDS + 5; index += 1) {
      const error = new Error(privateText)
      error.name = index === 0 ? privateText : 'Error'
      captureRuntimeError('promise', error, new Date(Date.UTC(2026, 7, 8, 12, index)))
    }

    const serialized = serializeRuntimeErrorReport(
      createRuntimeErrorReport(new Date('2026-08-08T13:00:00Z')),
    )
    expect(getRuntimeErrorSummary().storedCount).toBe(MAX_RUNTIME_ERROR_RECORDS)
    expect(serialized).not.toContain(privateText)
    expect(serialized).not.toContain('private.example')
    expect(serialized).not.toContain('access_token')
    expect(serialized).toContain('"automaticUpload": false')
  })

  it('turns an unhandled rejection into a bounded report and an actionable notice signal', () => {
    setRuntimeErrorRecordingEnabled(true)
    const onUnexpectedFailure = vi.fn()
    const uninstall = installRuntimeErrorListeners(onUnexpectedFailure)
    const event = new Event('unhandledrejection', { cancelable: true })
    Object.defineProperty(event, 'reason', {
      value: new RangeError('private content'),
    })

    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(onUnexpectedFailure).toHaveBeenCalledOnce()
    expect(getRuntimeErrorSummary().recent).toEqual([
      expect.objectContaining({ source: 'promise', kind: 'RangeError' }),
    ])
    uninstall()
  })
})
