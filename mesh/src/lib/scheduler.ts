export interface PollRegistration {
  key: string
  intervalMs: number
  run: () => void | Promise<void>
  pauseWhenHidden?: boolean
  backoffOnError?: boolean
  maxBackoffMs?: number
}

export interface BackoffOptions {
  baseMs?: number
  maxMs?: number
  jitterRatio?: number
  random?: () => number
}

interface PollEntry {
  key: string
  intervalMs: number
  run: () => void | Promise<void>
  pauseWhenHidden: boolean
  backoffOnError: boolean
  maxBackoffMs: number
  consecutiveFailures: number
  nextRunAt: number
  running: boolean
}

const polls = new Map<string, PollEntry>()
let wakeTimer: ReturnType<typeof setTimeout> | null = null
let listenersInstalled = false

function documentIsHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function shouldPause(entry: PollEntry) {
  return entry.pauseWhenHidden && documentIsHidden()
}

export function getBackoffDelay(
  attempt: number,
  {
    baseMs = 1_000,
    maxMs = 30_000,
    jitterRatio = 0.2,
    random = Math.random,
  }: BackoffOptions = {},
) {
  const safeAttempt = Math.max(0, Math.floor(attempt))
  const exponential = Math.min(maxMs, baseMs * (2 ** safeAttempt))
  const jitterMultiplier = 1 + ((random() * 2) - 1) * jitterRatio
  return Math.max(0, Math.min(maxMs, Math.round(exponential * jitterMultiplier)))
}

function clearWakeTimer() {
  if (wakeTimer === null) return
  clearTimeout(wakeTimer)
  wakeTimer = null
}

function scheduleWake() {
  clearWakeTimer()

  const now = Date.now()
  let nextRunAt = Number.POSITIVE_INFINITY
  for (const entry of polls.values()) {
    if (entry.running || shouldPause(entry)) continue
    nextRunAt = Math.min(nextRunAt, entry.nextRunAt)
  }
  if (!Number.isFinite(nextRunAt)) return

  wakeTimer = setTimeout(runDuePolls, Math.max(0, nextRunAt - now))
}

async function executePoll(entry: PollEntry) {
  try {
    await entry.run()
    entry.consecutiveFailures = 0
    entry.nextRunAt = Date.now() + entry.intervalMs
  } catch {
    entry.consecutiveFailures += 1
    const delay = entry.backoffOnError
      ? getBackoffDelay(entry.consecutiveFailures, {
          baseMs: entry.intervalMs,
          maxMs: entry.maxBackoffMs,
        })
      : entry.intervalMs
    entry.nextRunAt = Date.now() + delay
  } finally {
    entry.running = false
    if (polls.get(entry.key) !== entry) return
    if (shouldPause(entry)) {
      entry.nextRunAt = Number.POSITIVE_INFINITY
    }
    scheduleWake()
  }
}

function runDuePolls() {
  wakeTimer = null
  const now = Date.now()
  for (const entry of polls.values()) {
    if (entry.running || shouldPause(entry) || entry.nextRunAt > now) continue
    entry.running = true
    entry.nextRunAt = Number.POSITIVE_INFINITY
    void executePoll(entry)
  }
  scheduleWake()
}

function resumePausedPolls() {
  if (documentIsHidden()) return
  const now = Date.now()
  for (const entry of polls.values()) {
    if (entry.pauseWhenHidden && !entry.running) {
      entry.nextRunAt = now
    }
  }
  scheduleWake()
}

function handleVisibilityChange() {
  if (!documentIsHidden()) {
    resumePausedPolls()
    return
  }
  for (const entry of polls.values()) {
    if (entry.pauseWhenHidden && !entry.running) {
      entry.nextRunAt = Number.POSITIVE_INFINITY
    }
  }
  scheduleWake()
}

function installListeners() {
  if (listenersInstalled || typeof document === 'undefined') return
  document.addEventListener('visibilitychange', handleVisibilityChange)
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', resumePausedPolls)
  }
  listenersInstalled = true
}

function removeListeners() {
  if (!listenersInstalled || typeof document === 'undefined') return
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  if (typeof window !== 'undefined') {
    window.removeEventListener('focus', resumePausedPolls)
  }
  listenersInstalled = false
}

export function registerPoll(registration: PollRegistration) {
  if (!registration.key.trim()) {
    throw new Error('Poll key must not be empty')
  }
  if (!Number.isFinite(registration.intervalMs) || registration.intervalMs <= 0) {
    throw new Error('Poll interval must be a positive finite number')
  }

  installListeners()
  const pauseWhenHidden = registration.pauseWhenHidden ?? true
  const entry: PollEntry = {
    ...registration,
    pauseWhenHidden,
    backoffOnError: registration.backoffOnError ?? false,
    maxBackoffMs:
      registration.maxBackoffMs
      ?? Math.max(registration.intervalMs, 5 * 60_000),
    consecutiveFailures: 0,
    nextRunAt: pauseWhenHidden && documentIsHidden()
      ? Number.POSITIVE_INFINITY
      : Date.now(),
    running: false,
  }
  polls.set(entry.key, entry)
  scheduleWake()

  return () => {
    if (polls.get(entry.key) !== entry) return
    polls.delete(entry.key)
    scheduleWake()
  }
}

export function waitForDelay(delayMs: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, Math.max(0, delayMs))

    function done() {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }

    function onAbort() {
      clearTimeout(timer)
      done()
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function __resetPollSchedulerForTests() {
  clearWakeTimer()
  polls.clear()
  removeListeners()
}
