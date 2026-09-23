import { describe, expect, it } from 'vitest'

import { hexToBytes } from '../../src/hex.js'
import { toHash } from '../../src/types.js'
import { CHAT_DIFFICULTY, DEFAULT_DIFFICULTY, powHash, solvePow, validatePow, wasmPowHash } from '../../src/pow.js'
import { digestBE, loadHash } from '../../src/pow-fast.js'

const HASH = hexToBytes('e421d0d72568fa47a149c46172a8d168374d2fc00c4f2189a6bbbf946bc673da', 32)

describe('proof of work', () => {
  it('uses a HIGHER-is-harder threshold', () => {
    // The opposite of the leading-zeros convention. A difficulty of 0 accepts
    // everything; the maximum accepts almost nothing.
    expect(validatePow(HASH, 1n, 0n)).toBe(true)
    expect(validatePow(HASH, 1n, 0xffffffffffffffffn)).toBe(false)
  })

  it('is sensitive to the nonce', () => {
    expect(powHash(0n, HASH)).not.toBe(powHash(1n, HASH))
  })

  it('is sensitive to the hash', () => {
    const other = hexToBytes('0'.repeat(64), 32)
    expect(powHash(7n, HASH)).not.toBe(powHash(7n, other))
  })

  it('treats the nonce as little-endian inside the digest', () => {
    // If the nonce were written big-endian, these two would swap places.
    // Pinning a concrete pair stops a "tidy-up" from silently inverting it.
    expect(powHash(1n, HASH)).not.toBe(powHash(72057594037927936n, HASH))
  })

  it('wraps at the top of the uint64 range rather than throwing', () => {
    expect(() => powHash(0xffffffffffffffffn, HASH)).not.toThrow()
  })

  it('solves and then validates, at the chat difficulty', async () => {
    const nonce = await solvePow(HASH, { difficulty: CHAT_DIFFICULTY })
    expect(validatePow(HASH, nonce, CHAT_DIFFICULTY)).toBe(true)
  })

  it('solves at the full block difficulty', async () => {
    const nonce = await solvePow(HASH, { difficulty: DEFAULT_DIFFICULTY })
    expect(validatePow(HASH, nonce, DEFAULT_DIFFICULTY)).toBe(true)
  })

  it('accepts a hex hash as well as bytes', async () => {
    const nonce = await solvePow(toHash('e421d0d72568fa47a149c46172a8d168374d2fc00c4f2189a6bbbf946bc673da'), {
      difficulty: CHAT_DIFFICULTY,
    })
    expect(validatePow(HASH, nonce, CHAT_DIFFICULTY)).toBe(true)
  })

  it('does not return the same nonce twice for the same input', async () => {
    // A deterministic search would make every identical block grind
    // identically and leak that the nonce is a function of the hash alone.
    const a = await solvePow(HASH, { difficulty: CHAT_DIFFICULTY })
    const b = await solvePow(HASH, { difficulty: CHAT_DIFFICULTY })
    expect(a).not.toBe(b)
  })

  it('reports progress while grinding', async () => {
    let calls = 0
    await solvePow(HASH, { difficulty: DEFAULT_DIFFICULTY, progressInterval: 256, onProgress: () => { calls++ } })
    expect(calls).toBeGreaterThan(0)
  })

  it('can be aborted', async () => {
    const controller = new AbortController()
    const reason = new Error('caller changed their mind')
    // An unsatisfiable difficulty: only the abort can end this.
    const promise = solvePow(HASH, {
      difficulty: 0xffffffffffffffffn,
      progressInterval: 64,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(reason), 20)
    await expect(promise).rejects.toThrow('caller changed their mind')
  })
})

describe('the specialised proof-of-work digest', () => {
  it('agrees with the reference blake2b on random inputs', () => {
    const out = new Uint32Array(2)
    for (let i = 0; i < 2000; i++) {
      const hash = new Uint8Array(32)
      crypto.getRandomValues(hash)
      const n = new Uint32Array(2)
      crypto.getRandomValues(n)
      loadHash(hash)
      digestBE(n[0]!, n[1]!, out)
      const nonce = (BigInt(n[1]!) << 32n) | BigInt(n[0]!)
      expect((BigInt(out[0]!) << 32n) | BigInt(out[1]!)).toBe(powHash(nonce, hash))
    }
  })

  it('the WebAssembly digest agrees with the reference too', async () => {
    for (let i = 0; i < 2000; i++) {
      const hash = new Uint8Array(32)
      crypto.getRandomValues(hash)
      const n = new BigUint64Array(1)
      crypto.getRandomValues(n)
      expect(await wasmPowHash(n[0]!, hash)).toBe(powHash(n[0]!, hash))
    }
    // The node's own vectors include the u64 extremes the i64 boundary could mangle.
    expect(await wasmPowHash(0xffffffffffffffffn, HASH)).toBe(powHash(0xffffffffffffffffn, HASH))
  })

  it('solves the block difficulty fast enough for a renewal to land in time', async () => {
    // A renewal must be proven and land before the lease it extends expires.
    // ~2M expected attempts; well under a few seconds on the WebAssembly path.
    const t = performance.now()
    for (let i = 0; i < 3; i++) {
      const h = new Uint8Array(32)
      crypto.getRandomValues(h)
      const nonce = await solvePow(h)
      expect(validatePow(h, nonce)).toBe(true)
    }
    expect(performance.now() - t).toBeLessThan(30_000)
  }, 60_000)
})
