import { EventEmitter } from 'node:events'
import { FAULT_KINDS, type FaultKind } from './types.js'

export type FaultState = {
  kind: FaultKind | null
  /** Sends left that will fail. 0 when failure mode is off. */
  remaining: number
  /** How long a `timeout` fault holds the connection before dropping it. */
  timeoutMs: number
}

export const FAULT_LABELS: Record<FaultKind, { short: string; label: string }> = {
  rate_limit: { short: '429', label: 'Rate limited' },
  invalid_recipient: { short: '422', label: 'Invalid recipient' },
  unauthorized: { short: '401', label: 'Bad API key' },
  outage: { short: '5xx', label: 'Provider outage' },
  timeout: { short: 'T/O', label: 'Timeout' },
}

/** `429`, `rate_limit`, `5xx`, `503`, `timeout`… → a fault kind. */
export function parseFaultKind(value: unknown): FaultKind | null {
  const v = String(value ?? '').trim().toLowerCase()
  if (!v) return null
  if ((FAULT_KINDS as string[]).includes(v)) return v as FaultKind
  if (v === '429' || v === 'rate-limit' || v === 'ratelimit' || v === 'rate_limited') return 'rate_limit'
  if (v === '422' || v === '400' || v === 'invalid-recipient' || v === 'bad_recipient') return 'invalid_recipient'
  if (v === '401' || v === '403' || v === 'bad_key' || v === 'auth') return 'unauthorized'
  if (v === '5xx' || /^5\d\d$/.test(v) || v === 'down') return 'outage'
  if (v === 't/o' || v === 'timeout' || v === 'timed_out') return 'timeout'
  return null
}

export class Faults extends EventEmitter {
  private state: FaultState

  constructor(timeoutMs = 30_000) {
    super()
    this.state = { kind: null, remaining: 0, timeoutMs }
  }

  get(): FaultState {
    return { ...this.state }
  }

  set(kind: FaultKind, next = 1, timeoutMs?: number): FaultState {
    this.state = {
      kind: next > 0 ? kind : null,
      remaining: Math.max(0, Math.floor(next)),
      timeoutMs: timeoutMs ?? this.state.timeoutMs,
    }
    this.emit('change', this.get())
    return this.get()
  }

  clear(): FaultState {
    this.state = { ...this.state, kind: null, remaining: 0 }
    this.emit('change', this.get())
    return this.get()
  }

  /** Take one fault for this send, if failure mode is on. */
  take(): FaultKind | null {
    if (!this.state.kind || this.state.remaining <= 0) return null
    const kind = this.state.kind
    this.state.remaining -= 1
    if (this.state.remaining <= 0) this.state.kind = null
    this.emit('change', this.get())
    this.emit('fault', kind)
    return kind
  }
}
