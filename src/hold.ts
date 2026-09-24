import type { LeaseRecord } from './client.js'
import { XeBudgetError, XePriceError, XeUsageError, isRetryable } from './errors.js'
import type { Hash } from './types.js'
import { leasePaid, nowNs, type RenewGuards, type RenewedLease, type Xe } from './xe.js'

export interface HoldOptions {
  /** Seconds added per renewal. One billing unit (60) is the natural choice. */
  renewSecs?: bigint | number
  /** Stop renewing once the lease's effective term reaches this many seconds. */
  totalSecs?: bigint | number
  /** How long before expiry to renew. Default 30s. */
  leadMs?: number
  /** Give up on a renewal this long before expiry. Default 3s. */
  cutoffMs?: number
  /** Retry spacing for retryable failures. Default 4s. */
  retryMs?: number
  /**
   * micro-XUSD per minute a renewal may cost. Default: the price the lease was
   * opened at — a provider that raises its price does not get renewed
   * (`reason: 'price-changed'`) unless this allows the new price.
   */
  maxPricePerMinute?: bigint
  /** micro-XUSD the whole lease may cost; renewing stops before it would pass this (`reason: 'budget-reached'`). */
  budget?: bigint
  /** Abort to stop renewing; the lease then runs out at its current expiry. */
  signal?: AbortSignal
  onEvent?: (event: HoldEvent) => void
}

export type HoldEvent =
  | { type: 'waiting'; lease: LeaseRecord; renewAt: Date }
  | { type: 'renewed'; renewal: RenewedLease; lease: LeaseRecord }
  | { type: 'retry'; error: Error; attempt: number }
  | { type: 'done'; lease: LeaseRecord; reason: HoldReason }

/** Why renewing stopped. The lease itself runs on to the end of the time already paid for. */
export type HoldReason = 'target-reached' | 'aborted' | 'price-changed' | 'budget-reached'

export interface HoldResult {
  lease: LeaseRecord
  renewals: RenewedLease[]
  reason: HoldReason
  /** micro-XUSD escrowed for the lease: first term plus every renewal. */
  paid: bigint
}

/**
 * Keep an accepted lease alive by renewing it one short segment at a time.
 *
 * This is how "pay for the time you use" works on XE: nothing is escrowed
 * beyond the current segment, so stopping — or this process dying — releases
 * the machine within one segment and wastes at most that much.
 *
 * Every renewal is confirmed against the ledger (the effective term must
 * actually grow) before the next is scheduled, so a renewal that was accepted
 * by one node but never applied does not go unnoticed.
 */
export async function holdLease(xe: Xe, leaseHash: Hash, options: HoldOptions = {}): Promise<HoldResult> {
  const renewSecs = BigInt(options.renewSecs ?? 60)
  const totalSecs = options.totalSecs === undefined ? undefined : BigInt(options.totalSecs)
  const leadMs = options.leadMs ?? 30_000
  const cutoffMs = options.cutoffMs ?? 3_000
  const retryMs = options.retryMs ?? 4_000
  const emit = options.onEvent ?? (() => {})
  const renewals: RenewedLease[] = []

  let lease = await xe.waitForLease(leaseHash, ['accepted'])
  const guards = {
    maxPricePerMinute: options.maxPricePerMinute ?? (await xe.openingPricePerMinute(lease)),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
  }
  const done = (reason: HoldReason): HoldResult => {
    emit({ type: 'done', lease, reason })
    return { lease, renewals, reason, paid: leasePaid(lease) }
  }
  for (;;) {
    if (options.signal?.aborted) return done('aborted')
    if (totalSecs !== undefined && lease.effectiveDuration >= totalSecs) return done('target-reached')

    const expiryMs = Number(lease.effectiveExpiry / 1_000_000n)
    const renewAt = expiryMs - leadMs
    emit({ type: 'waiting', lease, renewAt: new Date(renewAt) })
    await sleepUntil(renewAt, options.signal)
    if (options.signal?.aborted) continue

    const step = totalSecs === undefined ? renewSecs : minBig(renewSecs, totalSecs - lease.effectiveDuration)
    const before = lease.effectiveDuration
    let renewal: RenewedLease
    try {
      renewal = await renewBeforeExpiry(xe, leaseHash, step, guards, expiryMs - cutoffMs, retryMs, emit)
    } catch (err) {
      if (err instanceof XePriceError) return done('price-changed')
      if (err instanceof XeBudgetError) return done('budget-reached')
      throw err
    }
    renewals.push(renewal)
    lease = await confirmExtended(xe, leaseHash, before, expiryMs)
    emit({ type: 'renewed', renewal, lease })
  }
}

async function renewBeforeExpiry(
  xe: Xe,
  leaseHash: Hash,
  secs: bigint,
  guards: RenewGuards,
  giveUpAt: number,
  retryMs: number,
  emit: (e: HoldEvent) => void,
): Promise<RenewedLease> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await xe.renewLease(leaseHash, secs, guards)
    } catch (err) {
      if (!isRetryable(err) || Date.now() + retryMs >= giveUpAt) throw err
      emit({ type: 'retry', error: err as Error, attempt })
      await sleepUntil(Date.now() + retryMs)
    }
  }
}

/** Wait for the ledger to show the longer term; the old expiry is the deadline. */
async function confirmExtended(xe: Xe, leaseHash: Hash, before: bigint, expiryMs: number): Promise<LeaseRecord> {
  for (;;) {
    const lease = await xe.lease(leaseHash)
    if (lease.effectiveDuration > before) return lease
    if (lease.state !== 'accepted') throw new XeUsageError(`lease became ${lease.state} during renewal`)
    if (Number(nowNs() / 1_000_000n) > expiryMs) {
      throw new XeUsageError('renewal was submitted but never applied before the lease expired')
    }
    await sleepUntil(Date.now() + 500)
  }
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}

function sleepUntil(at: number, signal?: AbortSignal): Promise<void> {
  const ms = at - Date.now()
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}
