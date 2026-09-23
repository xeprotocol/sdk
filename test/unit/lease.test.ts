import { describe, expect, it } from 'vitest'

import vectorsJson from '../vectors.json?raw'

import { attestationPayload, attestedTime, verifyAttestation } from '../../src/attestation.js'
import { toLeaseRecord, toWire } from '../../src/client.js'
import { holdLease, type HoldEvent } from '../../src/hold.js'
import { bytesToHex } from '../../src/hex.js'
import { parseLossless } from '../../src/json.js'
import { leaseCost } from '../../src/lease.js'
import { toAddress, toHash, toPublicKey, type Attestation, type Hash, type SignedBlock } from '../../src/types.js'
import type { LeaseRecord } from '../../src/client.js'
import type { RenewedLease, Xe } from '../../src/xe.js'

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
  function fakeXe(opts: { failFirst?: number } = {}) {
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
      renewLease: async (hash: Hash, secs: bigint): Promise<RenewedLease> => {
        if (failures-- > 0) throw Object.assign(new Error('rate limited'), { retryable: true, name: 'XeApiError' })
        renewTimes.push(Date.now())
        lease.renewals.push({ renewHash: toHash('d'.repeat(64)), duration: secs, cost: 1n, startTime: 0n })
        lease.effectiveDuration += secs
        lease.effectiveExpiry = lease.startTime + lease.effectiveDuration * 1_000_000_000n
        return { hash: toHash('d'.repeat(64)), accepted: true, lease: hash, cost: 1n, durationSecs: secs, renewTime: 0n, epoch: {} as never }
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

  it('stops renewing when aborted, leaving the lease to run out', async () => {
    const { xe, lease } = fakeXe()
    const ac = new AbortController()
    ac.abort()
    const result = await holdLease(xe, lease.hash, { renewSecs: 1, totalSecs: 10, signal: ac.signal })
    expect(result.reason).toBe('aborted')
    expect(result.renewals).toHaveLength(0)
  })
})
