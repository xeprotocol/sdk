import { describe, expect, it, vi } from 'vitest'

import {
  MAX_ATTESTATIONS_PER_BLOCK,
  attestationPayload,
  attestedTime,
  discoverTimekeepers,
  gatherAttestations,
  verifyAttestation,
  type Timekeeper,
} from '../../src/attestation.js'
import { XeClient, type TimekeeperSet } from '../../src/client.js'
import { XeUsageError } from '../../src/errors.js'
import { bytesToHex } from '../../src/hex.js'
import { toHash, toPublicKey, type Attestation, type PublicKey } from '../../src/types.js'
import { Wallet } from '../../src/wallet.js'

const TEST_LEASE = toHash('1'.repeat(64))
const MAX_INT64 = (1n << 63n) - 1n

function mockClient(
  url: string,
  handler: (path: string, options?: RequestInit) => { status: number; body: unknown },
): XeClient {
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(input)
    const path = urlStr.replace(/^https?:\/\/[^/]+/, '')
    const res = handler(path, init)
    return new Response(JSON.stringify(res.body), { status: res.status })
  }) as unknown as typeof globalThis.fetch
  return new XeClient({ url, fetch: fetchFn, retries: 0 })
}

describe('attestation int64 bounds and payload validation', () => {
  const wallet = Wallet.create()

  it('attestationPayload rejects negative and > MAX_INT64 timestamps', () => {
    expect(() => attestationPayload(TEST_LEASE, -1n)).toThrow(XeUsageError)
    expect(() => attestationPayload(TEST_LEASE, 1n << 63n)).toThrow(XeUsageError)
    expect(attestationPayload(TEST_LEASE, 0n)).toBeInstanceOf(Uint8Array)
    expect(attestationPayload(TEST_LEASE, MAX_INT64)).toBeInstanceOf(Uint8Array)
  })

  it('verifyAttestation accepts 0n and rejects negative and > MAX_INT64 timestamps', () => {
    const sign = (ts: bigint): Attestation => {
      let sig = ''
      try {
        sig = bytesToHex(wallet.sign(attestationPayload(TEST_LEASE, ts)))
      } catch {
        sig = '0'.repeat(128)
      }
      return { publicKey: wallet.publicKey, timestamp: ts, signature: sig }
    }

    expect(verifyAttestation(sign(-1n), TEST_LEASE)).toBe(false)
    expect(verifyAttestation(sign(1n << 63n), TEST_LEASE)).toBe(false)
    expect(verifyAttestation(sign(0n), TEST_LEASE)).toBe(true)

    const validAtt = sign(1_000_000_000n)
    expect(verifyAttestation(validAtt, TEST_LEASE)).toBe(true)
  })

  it('attestedTime accepts 0n and rejects empty array, negative, and > MAX_INT64 timestamps', () => {
    expect(() => attestedTime([])).toThrow(XeUsageError)

    const at = (ts: bigint): Attestation => ({
      publicKey: wallet.publicKey,
      timestamp: ts,
      signature: '',
    })

    expect(() => attestedTime([at(-1n)])).toThrow('attestedTime: timestamp out of int64 range')
    expect(() => attestedTime([at(1n << 63n)])).toThrow('attestedTime: timestamp out of int64 range')

    expect(attestedTime([at(0n)])).toBe(0n)
    expect(attestedTime([at(100n), at(300n), at(200n)])).toBe(200n)
  })
})

describe('timekeeper discovery spoofing defense', () => {
  it('retains both spoofed and honest endpoints for the same key, enabling failover', async () => {
    const realWallet = Wallet.create()
    const set: TimekeeperSet = {
      threshold: 1,
      keys: [realWallet.publicKey],
    }

    // Candidate 1: malicious node spoofing realWallet.publicKey in /node but returning bad signature
    const spoofClient = mockClient('http://spoof.test', (path) => {
      if (path === '/node') {
        return { status: 200, body: { public_key: realWallet.publicKey } }
      }
      if (path === '/attestation/request') {
        return {
          status: 200,
          body: {
            public_key: realWallet.publicKey,
            timestamp: '1700000000000000000',
            signature: 'f'.repeat(128),
          },
        }
      }
      return { status: 404, body: {} }
    })

    // Candidate 2: honest timekeeper node with valid signature
    const honestClient = mockClient('http://honest.test', (path) => {
      if (path === '/node') {
        return { status: 200, body: { public_key: realWallet.publicKey } }
      }
      if (path === '/attestation/request') {
        const ts = 1_700_000_000_000_000_000n
        const payload = attestationPayload(TEST_LEASE, ts)
        const sig = bytesToHex(realWallet.sign(payload))
        return {
          status: 200,
          body: {
            public_key: realWallet.publicKey,
            timestamp: ts.toString(),
            signature: sig,
          },
        }
      }
      return { status: 404, body: {} }
    })

    // discoverTimekeepers must retain both URLs instead of evicting honest endpoint
    const candidates = [spoofClient, honestClient]
    const discovered = await discoverTimekeepers(set, candidates)
    expect(discovered).toHaveLength(2)
    expect(discovered[0]!.client.url).toBe('http://spoof.test')
    expect(discovered[1]!.client.url).toBe('http://honest.test')

    // gatherAttestations must reject the spoofed signature and succeed with the honest one
    const atts = await gatherAttestations(TEST_LEASE, set, discovered)
    expect(atts).toHaveLength(1)
    expect(atts[0]!.publicKey).toBe(realWallet.publicKey)
    expect(verifyAttestation(atts[0]!, TEST_LEASE)).toBe(true)
  })
})

describe('quorum validation and distinct-key enforcement', () => {
  it('rejects upfront if distinct reachable keys is less than threshold', async () => {
    const w1 = Wallet.create()
    const set: TimekeeperSet = {
      threshold: 2,
      keys: [w1.publicKey],
    }

    const c1 = mockClient('http://m1.test', () => ({
      status: 200,
      body: { public_key: w1.publicKey },
    }))
    const c2 = mockClient('http://m2.test', () => ({
      status: 200,
      body: { public_key: w1.publicKey },
    }))

    const tks: Timekeeper[] = [
      { publicKey: w1.publicKey, client: c1 },
      { publicKey: w1.publicKey, client: c2 },
    ]

    await expect(gatherAttestations(TEST_LEASE, set, tks)).rejects.toThrow(
      /only 1 reachable timekeeper\(s\), need 2 — pass more timekeeper URLs/,
    )
  })

  it('deduplicates multiple responses from mirrors of the same key to 1 attestation', async () => {
    const w1 = Wallet.create()
    const w2 = Wallet.create()
    const set: TimekeeperSet = {
      threshold: 2,
      keys: [w1.publicKey, w2.publicKey],
    }

    const makeAttClient = (url: string, wallet: Wallet, ts: bigint): XeClient => {
      return mockClient(url, (path) => {
        if (path === '/attestation/request') {
          const sig = bytesToHex(wallet.sign(attestationPayload(TEST_LEASE, ts)))
          return {
            status: 200,
            body: { public_key: wallet.publicKey, timestamp: ts.toString(), signature: sig },
          }
        }
        return { status: 404, body: {} }
      })
    }

    // Two mirrors for w1, one mirror for w2
    const tks: Timekeeper[] = [
      { publicKey: w1.publicKey, client: makeAttClient('http://w1a.test', w1, 100n) },
      { publicKey: w1.publicKey, client: makeAttClient('http://w1b.test', w1, 200n) },
      { publicKey: w2.publicKey, client: makeAttClient('http://w2.test', w2, 300n) },
    ]

    const atts = await gatherAttestations(TEST_LEASE, set, tks)
    expect(atts).toHaveLength(2)
    const keys = atts.map((a) => a.publicKey)
    expect(new Set(keys).size).toBe(2)
    expect(keys).toContain(w1.publicKey)
    expect(keys).toContain(w2.publicKey)
  })

  it('excludes rotated-out timekeepers not in set.keys', async () => {
    const wValid = Wallet.create()
    const wRotated = Wallet.create()
    const set: TimekeeperSet = {
      threshold: 1,
      keys: [wValid.publicKey],
    }

    const makeAttClient = (url: string, wallet: Wallet): XeClient => {
      return mockClient(url, (path) => {
        if (path === '/node') return { status: 200, body: { public_key: wallet.publicKey } }
        if (path === '/attestation/request') {
          const ts = 1_000n
          const sig = bytesToHex(wallet.sign(attestationPayload(TEST_LEASE, ts)))
          return {
            status: 200,
            body: { public_key: wallet.publicKey, timestamp: ts.toString(), signature: sig },
          }
        }
        return { status: 404, body: {} }
      })
    }

    // discoverTimekeepers excludes rotated-out key
    const discovered = await discoverTimekeepers(set, [
      makeAttClient('http://rotated.test', wRotated),
      makeAttClient('http://valid.test', wValid),
    ])
    expect(discovered).toHaveLength(1)
    expect(discovered[0]!.publicKey).toBe(wValid.publicKey)

    // If passed directly to gatherAttestations, rotated-out key is filtered out
    const manualTks: Timekeeper[] = [
      { publicKey: wRotated.publicKey, client: makeAttClient('http://rotated.test', wRotated) },
      { publicKey: wValid.publicKey, client: makeAttClient('http://valid.test', wValid) },
    ]
    const atts = await gatherAttestations(TEST_LEASE, set, manualTks)
    expect(atts).toHaveLength(1)
    expect(atts[0]!.publicKey).toBe(wValid.publicKey)
  })
})

describe('threshold validation and MAX_ATTESTATIONS_PER_BLOCK cap', () => {
  it('rejects non-integer, non-positive, or >20 threshold with XeUsageError', async () => {
    const w = Wallet.create()
    const dummyTk: Timekeeper = {
      publicKey: w.publicKey,
      client: new XeClient({ url: 'http://dummy.test' }),
    }

    await expect(
      gatherAttestations(TEST_LEASE, { threshold: 0, keys: [w.publicKey] }, [dummyTk]),
    ).rejects.toThrow('invalid timekeeper threshold 0')
    await expect(
      gatherAttestations(TEST_LEASE, { threshold: -1, keys: [w.publicKey] }, [dummyTk]),
    ).rejects.toThrow('invalid timekeeper threshold -1')
    await expect(
      gatherAttestations(TEST_LEASE, { threshold: 21, keys: [w.publicKey] }, [dummyTk]),
    ).rejects.toThrow('invalid timekeeper threshold 21')
    await expect(
      gatherAttestations(TEST_LEASE, { threshold: 1.5, keys: [w.publicKey] }, [dummyTk]),
    ).rejects.toThrow('invalid timekeeper threshold 1.5')
  })

  it('caps verified attestations to MAX_ATTESTATIONS_PER_BLOCK (20) when >20 respond', async () => {
    const wallets: Wallet[] = []
    const tks: Timekeeper[] = []
    for (let i = 0; i < 22; i++) {
      const w = Wallet.create()
      wallets.push(w)
      const ts = BigInt(1_000_000 + i)
      const client = mockClient(`http://node${i}.test`, (path) => {
        if (path === '/attestation/request') {
          const sig = bytesToHex(w.sign(attestationPayload(TEST_LEASE, ts)))
          return {
            status: 200,
            body: { public_key: w.publicKey, timestamp: ts.toString(), signature: sig },
          }
        }
        return { status: 404, body: {} }
      })
      tks.push({ publicKey: w.publicKey, client })
    }

    const set: TimekeeperSet = {
      threshold: 2,
      keys: wallets.map((w) => w.publicKey),
    }

    const atts = await gatherAttestations(TEST_LEASE, set, tks)
    expect(atts).toHaveLength(MAX_ATTESTATIONS_PER_BLOCK)
    expect(atts).toHaveLength(20)
  })
})

describe('case-insensitivity of hex public keys', () => {
  it('normalizes uppercase public keys in set.keys, /node, and attestation responses', async () => {
    const w = Wallet.create()
    const upperKey = w.publicKey.toUpperCase()
    const lowerKey = w.publicKey.toLowerCase() as PublicKey

    const set: TimekeeperSet = {
      threshold: 1,
      keys: [upperKey as unknown as PublicKey],
    }

    const c = mockClient('http://case.test', (path) => {
      if (path === '/node') return { status: 200, body: { public_key: upperKey } }
      if (path === '/attestation/request') {
        const ts = 100_000n
        const sig = bytesToHex(w.sign(attestationPayload(TEST_LEASE, ts)))
        return {
          status: 200,
          body: { public_key: upperKey, timestamp: ts.toString(), signature: sig },
        }
      }
      return { status: 404, body: {} }
    })

    const discovered = await discoverTimekeepers(set, [c])
    expect(discovered).toHaveLength(1)
    expect(discovered[0]!.publicKey).toBe(lowerKey)

    const atts = await gatherAttestations(TEST_LEASE, set, discovered)
    expect(atts).toHaveLength(1)
    expect(atts[0]!.publicKey).toBe(lowerKey)
    expect(verifyAttestation(atts[0]!, TEST_LEASE)).toBe(true)
  })
})
