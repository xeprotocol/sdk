import { describe, expect, it, vi } from 'vitest'

import vectorsJson from '../vectors.json?raw'

import { attestationPayload, attestedTime, verifyAttestation } from '../../src/attestation.js'
import { toLeaseRecord, toWire } from '../../src/client.js'
import { holdLease, type HoldEvent } from '../../src/hold.js'
import { bytesToHex } from '../../src/hex.js'
import { parseLossless } from '../../src/json.js'
import { leaseCost } from '../../src/lease.js'
import { toAddress, toHash, toPublicKey, type Attestation, type Hash, type SignedBlock } from '../../src/types.js'
import type { LeaseRecord } from '../../src/client.js'
import { Xe, type RenewedLease } from '../../src/xe.js'
import { Wallet } from '../../src/wallet.js'
import { XeApiError, XeBudgetError, XePriceError, XeUsageError } from '../../src/errors.js'

const fixture = parseLossless(vectorsJson) as {
  attestation_vectors: { lease_hash: string; timestamp: bigint; payload_hex: string; public_key: string; signature: string }[]
}

describe('leaseCost mirrors core.LeaseCost', () => {
  const dims = (vcpus: number, memoryMb: number, diskGb: number) => ({
    vcpus: BigInt(vcpus),
    memoryMb: BigInt(memoryMb),
    diskGb: BigInt(diskGb),
  })

  it('matches a lease the live testnet settled (1 vCPU / 1 GiB / 1 GB, 60s, 2.5×)', () => {
    expect(leaseCost(dims(1, 1024, 1), 60n, 2500n)).toBe(1293n)
  })

  it('bills whole minutes and whole GiB, rounding up', () => {
    // 61s is two minutes; 1025 MB is two GiB.
    expect(leaseCost(dims(0, 1025, 0), 61n, 1000n)).toBe(leaseCost(dims(0, 2048, 0), 120n, 1000n))
  })

  it('never prices a lease at zero', () => {
    expect(leaseCost(dims(0, 0, 1), 1n, 1n)).toBe(1n)
  })

  it('rejects an empty machine', () => {
    expect(() => leaseCost(dims(0, 0, 0), 60n, 1000n)).toThrow(/resources/)
  })
})

describe('attestations', () => {
  for (const v of fixture.attestation_vectors) {
    it(`payload and signature match the node @ ts=${v.timestamp}`, () => {
      const hash = toHash(v.lease_hash)
      expect(bytesToHex(attestationPayload(hash, BigInt(v.timestamp)))).toBe(v.payload_hex)
      const att: Attestation = { publicKey: toPublicKey(v.public_key), timestamp: BigInt(v.timestamp), signature: v.signature }
      expect(verifyAttestation(att, hash)).toBe(true)
      expect(verifyAttestation({ ...att, timestamp: att.timestamp + 1n }, hash)).toBe(false)
      expect(verifyAttestation(att, toHash('0'.repeat(64)))).toBe(false)
    })
  }

  it('takes the LOWER median, as the ledger does', () => {
    const at = (ts: bigint): Attestation => ({ publicKey: toPublicKey('a'.repeat(64)), timestamp: ts, signature: '' })
    expect(attestedTime([at(30n), at(10n), at(20n)])).toBe(20n)
    expect(attestedTime([at(40n), at(10n)])).toBe(10n)
  })
})

describe('lease wire form', () => {
  it('writes lease fields snake_case, omits zeros, keeps uint64 precision', () => {
    const block: SignedBlock = {
      type: 'lease_renew',
      account: toAddress('a'.repeat(64)),
      previous: toHash('b'.repeat(64)),
      balance: 18446744073709551000n,
      timestamp: 1790155844400578712n,
      asset: 'XUSD',
      source: toHash('c'.repeat(64)),
      amount: 1293n,
      duration: 60n,
      lockedR: 2000n,
      lockedPayoutCap: 0n,
      lockedTwap: 250n,
      certificateHash: toHash('d'.repeat(64)),
      attestations: [{ publicKey: toPublicKey('e'.repeat(64)), timestamp: 1790155844400578999n, signature: 'ff' }],
      hash: toHash('f'.repeat(64)),
      signature: '00',
      powNonce: 7n,
    }
    const wire = toWire(block)
    expect(wire['locked_twap_milli']).toBe(250n)
    expect(wire['locked_payout_cap']).toBeUndefined()
    expect(wire['certificate_hash']).toBe('d'.repeat(64))
    expect(wire['attestations']).toEqual([{ public_key: 'e'.repeat(64), timestamp: 1790155844400578999n, signature: 'ff' }])
  })

  it('derives the effective expiry from the base term plus every renewal', () => {
    const rec = toLeaseRecord(
      parseLossless(
        '{"lease_hash":"' + 'a'.repeat(64) + '","state":"accepted","duration":60,"cost":10,"start_time":1790000000000000000,' +
          '"renewals":[{"renew_hash":"' + 'b'.repeat(64) + '","duration":60,"cost":10,"start_time":1790000030000000000}]}',
      ) as Record<string, unknown>,
    )
    expect(rec.effectiveDuration).toBe(120n)
    expect(rec.effectiveExpiry).toBe(1790000120000000000n)
  })
})

describe('holdLease', () => {
  /** A fake ledger: one accepted lease that each renewal extends. */
  function fakeXe(opts: { failFirst?: number; price?: () => bigint } = {}) {
    const price = opts.price ?? (() => 1n)
    const start = BigInt(Date.now()) * 1_000_000n
    const lease: LeaseRecord = {
      hash: toHash('a'.repeat(64)),
      state: 'accepted',
      consumer: toAddress('b'.repeat(64)),
      provider: toAddress('c'.repeat(64)),
      vcpus: 1n,
      memoryMb: 1024n,
      diskGb: 1n,
      duration: 1n,
      cost: 1n,
      startTime: start,
      settled: false,
      certificateHash: '',
      renewals: [],
      effectiveDuration: 1n,
      effectiveExpiry: start + 1_000_000_000n,
      raw: {},
    }
    let failures = opts.failFirst ?? 0
    const renewTimes: number[] = []
    const xe = {
      waitForLease: async () => ({ ...lease }),
      lease: async () => ({ ...lease, renewals: [...lease.renewals] }),
      openingPricePerMinute: async () => 1n,
      renewLease: async (hash: Hash, secs: bigint, guards: { maxPricePerMinute?: bigint; budget?: bigint } = {}): Promise<RenewedLease> => {
        const cost = price()
        if (guards.maxPricePerMinute !== undefined && cost > guards.maxPricePerMinute) {
          throw new XePriceError(lease.provider, cost, guards.maxPricePerMinute)
        }
        const paid = lease.renewals.reduce((sum, r) => sum + r.cost, lease.cost)
        if (guards.budget !== undefined && paid + cost > guards.budget) throw new XeBudgetError(paid, cost, guards.budget)
        if (failures-- > 0) throw Object.assign(new Error('rate limited'), { retryable: true, name: 'XeApiError' })
        renewTimes.push(Date.now())
        lease.renewals.push({ renewHash: toHash('d'.repeat(64)), duration: secs, cost, startTime: 0n })
        lease.effectiveDuration += secs
        lease.effectiveExpiry = lease.startTime + lease.effectiveDuration * 1_000_000_000n
        return { hash: toHash('d'.repeat(64)), accepted: true, lease: hash, cost, durationSecs: secs, renewTime: 0n, epoch: {} as never }
      },
    }
    return { xe: xe as unknown as Xe, lease, renewTimes }
  }

  it('renews segment by segment until the target term, each before expiry', async () => {
    const { xe, lease, renewTimes } = fakeXe()
    const events: HoldEvent['type'][] = []
    const result = await holdLease(xe, lease.hash, {
      renewSecs: 1,
      totalSecs: 4,
      leadMs: 400,
      onEvent: (e) => events.push(e.type),
    })
    expect(result.reason).toBe('target-reached')
    expect(result.renewals).toHaveLength(3)
    expect(result.lease.effectiveDuration).toBe(4n)
    const startMs = Number(lease.startTime / 1_000_000n)
    renewTimes.forEach((t, i) => expect(t).toBeLessThan(startMs + (i + 1) * 1000))
    expect(events.at(-1)).toBe('done')
  }, 10_000)

  it('keeps the opening price: a raised price stops the renewing instead of being paid', async () => {
    let price = 1n
    const { xe, lease } = fakeXe({ price: () => price })
    const events: HoldEvent[] = []
    const result = await holdLease(xe, lease.hash, {
      renewSecs: 1,
      totalSecs: 10,
      leadMs: 400,
      onEvent: (e) => {
        events.push(e)
        if (e.type === 'renewed') price = 2n // the provider raises its price after the first renewal
      },
    })
    expect(result.reason).toBe('price-changed')
    expect(result.renewals).toHaveLength(1)
    expect(result.paid).toBe(2n) // first term + one renewal at the opening price, nothing at the new one
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'price-changed' })
  }, 10_000)

  it('pays a raised price when maxPricePerMinute allows it', async () => {
    let price = 1n
    const { xe, lease } = fakeXe({ price: () => price })
    const result = await holdLease(xe, lease.hash, {
      renewSecs: 1,
      totalSecs: 3,
      leadMs: 400,
      maxPricePerMinute: 2n,
      onEvent: (e) => {
        if (e.type === 'renewed') price = 2n
      },
    })
    expect(result.reason).toBe('target-reached')
    expect(result.renewals.map((r) => r.cost)).toEqual([1n, 2n])
  }, 10_000)

  it('stops before a renewal would take the lease past its budget', async () => {
    const { xe, lease } = fakeXe()
    const result = await holdLease(xe, lease.hash, { renewSecs: 1, leadMs: 400, budget: 3n })
    expect(result.reason).toBe('budget-reached')
    expect(result.paid).toBe(3n) // first term + two renewals; a third would make 4
    expect(result.renewals).toHaveLength(2)
  }, 10_000)

  it('stops renewing when aborted, leaving the lease to run out', async () => {
    const { xe, lease } = fakeXe()
    const ac = new AbortController()
    ac.abort()
    const result = await holdLease(xe, lease.hash, { renewSecs: 1, totalSecs: 10, signal: ac.signal })
    expect(result.reason).toBe('aborted')
    expect(result.renewals).toHaveLength(0)
  })
})

describe('rentLease', () => {
  const opts = { provider: toAddress('c'.repeat(64)), vcpus: 1, memoryMb: 1024, diskGb: 1, durationSecs: 60 }
  const timeout = () => new XeApiError('still created after timeout', 503, true, null)

  function setup(outcomes: Array<'accept' | 'timeout'>, cancelRace = false) {
    const xe = new Xe({ client: 'http://node.test', wallet: Wallet.create() })
    let n = 0
    const opened: string[] = []
    const cancelled: string[] = []
    vi.spyOn(xe, 'openLease').mockImplementation(async () => {
      const hash = toHash(String(++n).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, 'a'))
      opened.push(hash)
      return { hash, accepted: true, cost: 1n, certificate: {} as never }
    })
    vi.spyOn(xe, 'waitForLease').mockImplementation(async (hash, states) => {
      if (states.includes('cancelled')) return { state: 'cancelled' } as LeaseRecord
      const outcome = outcomes[opened.indexOf(hash)]
      if (outcome === 'accept') return { hash, state: 'accepted' } as LeaseRecord
      throw timeout()
    })
    vi.spyOn(xe, 'cancelLease').mockImplementation(async (hash) => {
      if (cancelRace) throw new Error('lease is accepted; only an unaccepted lease can be cancelled')
      cancelled.push(hash)
      return { hash, accepted: true }
    })
    vi.spyOn(xe.client, 'lease').mockImplementation(async (hash) => ({ hash, state: 'accepted' }) as LeaseRecord)
    return { xe, opened, cancelled }
  }

  it('returns the first accepted lease', async () => {
    const { xe, cancelled } = setup(['accept'])
    const r = await xe.rentLease(opts)
    expect(r.attempts).toBe(1)
    expect(cancelled).toHaveLength(0)
  })

  it('cancels an unanswered request (refunding it) and opens a fresh one', async () => {
    const { xe, opened, cancelled } = setup(['timeout', 'accept'])
    const r = await xe.rentLease(opts, { acceptTimeoutMs: 1 })
    expect(r.attempts).toBe(2)
    expect(cancelled).toEqual([opened[0]])
    expect(r.opened.hash).toBe(opened[1])
  })

  it('keeps a lease the provider accepted while the cancel was going in', async () => {
    const { xe, opened } = setup(['timeout'], true)
    const r = await xe.rentLease(opts, { acceptTimeoutMs: 1 })
    expect(r.opened.hash).toBe(opened[0])
    expect(r.lease.state).toBe('accepted')
  })

  it('gives up after the attempt budget, having cancelled every request', async () => {
    const { xe, cancelled } = setup(['timeout', 'timeout'])
    await expect(xe.rentLease(opts, { acceptTimeoutMs: 1, attempts: 2 })).rejects.toThrow(/timeout/)
    expect(cancelled).toHaveLength(2)
  })
})

describe('price protection before signing', () => {
  const provider = toAddress('c'.repeat(64))
  const cert = (milli: bigint, expiresAt = 0n) => ({ hash: toHash('e'.repeat(64)), provider, priceMultiplierMilli: milli, expiresAt, raw: {} })
  const accepted = {
    hash: toHash('a'.repeat(64)),
    state: 'accepted',
    provider,
    vcpus: 1n,
    memoryMb: 1024n,
    diskGb: 1n,
    cost: 517n,
    renewals: [],
    settled: false,
    effectiveExpiry: (BigInt(Date.now()) + 60_000n) * 1_000_000n,
  } as unknown as LeaseRecord

  function xeWith(certMilli: bigint) {
    const xe = new Xe({ client: 'http://node.test', wallet: Wallet.create() })
    vi.spyOn(xe.client, 'certificate').mockResolvedValue(cert(certMilli))
    vi.spyOn(xe.client, 'lease').mockResolvedValue({ ...accepted, consumer: xe.address })
    // Anything past the guards would go to the network; make that loud.
    const network = vi.spyOn(xe.client, 'balances').mockRejectedValue(new Error('reached the network'))
    return { xe, network }
  }

  it('renewLease refuses a price above the ceiling without attesting or signing', async () => {
    const { xe, network } = xeWith(2500n)
    await expect(xe.renewLease(accepted.hash, 60, { maxPricePerMinute: 517n })).rejects.toMatchObject({
      name: 'XePriceError',
      price: 1293n,
      ceiling: 517n,
    })
    expect(network).not.toHaveBeenCalled()
  })

  it('renewLease refuses a renewal that would pass the budget', async () => {
    const { xe } = xeWith(1000n)
    const err = await xe.renewLease(accepted.hash, 60, { budget: 1000n }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(XeBudgetError)
    expect(err).toMatchObject({ paid: 517n, next: 517n, budget: 1000n })
  })

  it('openLease refuses a provider above the ceiling', async () => {
    const { xe, network } = xeWith(2500n)
    const err = await xe
      .openLease({ provider, vcpus: 1, memoryMb: 1024, diskGb: 1, durationSecs: 60, maxPricePerMinute: 1000n })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(XePriceError)
    expect(network).not.toHaveBeenCalled()
  })

  it('bills whole minutes only: other durations are refused, not rounded up', async () => {
    const { xe } = xeWith(1000n)
    await expect(xe.openLease({ provider, vcpus: 1, memoryMb: 1024, diskGb: 1, durationSecs: 61 })).rejects.toThrow(XeUsageError)
    await expect(xe.renewLease(accepted.hash, 90)).rejects.toThrow(/whole number of minutes/)
  })
})

describe('quote', () => {
  it('lists providers that can take the machine, cheapest first', async () => {
    const xe = new Xe({ client: 'http://node.test', wallet: Wallet.create() })
    const p = (c: string, usedVcpus: bigint) => ({
      account: toAddress(c.repeat(64)),
      vcpus: 4n,
      memoryMb: 8192n,
      diskGb: 50n,
      maxConcurrentLeases: 5n,
      usedVcpus,
      usedMemoryMb: 0n,
      usedDiskGb: 0n,
      activeLeases: 0n,
      raw: {},
    })
    vi.spyOn(xe.client, 'providers').mockResolvedValue([p('1', 0n), p('2', 0n), p('3', 4n), p('4', 0n)])
    const certs: Record<string, bigint | 'expired' | 'none'> = { '1': 2500n, '2': 1000n, '4': 'expired' }
    vi.spyOn(xe.client, 'certificate').mockImplementation(async (a) => {
      const c = certs[a[0]!]
      if (c === undefined || c === 'none') throw new Error('404')
      if (c === 'expired') return { hash: toHash('e'.repeat(64)), provider: a, priceMultiplierMilli: 1000n, expiresAt: 1n, raw: {} }
      return { hash: toHash('e'.repeat(64)), provider: a, priceMultiplierMilli: c, expiresAt: 0n, raw: {} }
    })
    const quotes = await xe.quote({ vcpus: 1, memoryMb: 1024, diskGb: 1 })
    // '3' is full, '4' has an expired certificate.
    expect(quotes.map((q) => [q.provider[0], q.pricePerMinute])).toEqual([
      ['2', 517n],
      ['1', 1293n],
    ])
  })
})
