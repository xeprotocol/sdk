import { describe, expect, it } from 'vitest'

import { hexToBytes } from '../../src/hex.js'
import { toPublicKey } from '../../src/types.js'
import { Wallet, deriveAddress, verifySignature } from '../../src/wallet.js'

const SEED = '4e3f2a1b0c9d8e7f60514233445566778899aabbccddeeff0011223344556677'

describe('Wallet', () => {
  it('derives a stable address and public key from a seed', () => {
    const a = Wallet.fromSeedHex(SEED)
    const b = Wallet.fromSeedHex(SEED)
    expect(a.address).toBe(b.address)
    expect(a.publicKey).toBe(b.publicKey)
  })

  it('makes address and public key DIFFERENT values', () => {
    // Identity is not credential. Conflating them was a real protocol bug;
    // anything that treats a 64-hex account field as a verifying key is wrong.
    const w = Wallet.fromSeedHex(SEED)
    expect(w.address).not.toBe(w.publicKey)
    expect(deriveAddress(hexToBytes(w.publicKey, 32))).toBe(w.address)
  })

  it('generates distinct wallets', () => {
    expect(Wallet.create().address).not.toBe(Wallet.create().address)
  })

  it('round-trips through its seed', () => {
    const w = Wallet.create()
    expect(Wallet.fromSeedHex(w.seedHex()).address).toBe(w.address)
  })

  it('signs verifiably', () => {
    const w = Wallet.fromSeedHex(SEED)
    const msg = new TextEncoder().encode('hello')
    expect(verifySignature(w.publicKey, msg, w.sign(msg))).toBe(true)
  })

  it('rejects a tampered message', () => {
    const w = Wallet.fromSeedHex(SEED)
    const sig = w.sign(new TextEncoder().encode('hello'))
    expect(verifySignature(w.publicKey, new TextEncoder().encode('hellp'), sig)).toBe(false)
  })

  describe('the seed does not leak', () => {
    const w = Wallet.fromSeedHex(SEED)

    it('is absent from JSON', () => {
      expect(JSON.stringify(w)).not.toContain(SEED)
      expect(JSON.parse(JSON.stringify(w))).toEqual({ address: w.address, publicKey: w.publicKey })
    })

    it('is absent from toString', () => {
      expect(String(w)).not.toContain(SEED)
    })

    it('is absent from template interpolation and log-style formatting', () => {
      expect(`${w}`).not.toContain(SEED)
      expect(Object.values(w).join(' ')).not.toContain(SEED)
    })

    it('is reachable only by an explicit call', () => {
      expect(w.seedHex()).toBe(SEED)
    })
  })

  it('rejects a seed of the wrong length', () => {
    expect(() => Wallet.fromSeedHex('00')).toThrow(/expected 32 bytes/)
    expect(() => Wallet.fromSeed(new Uint8Array(31))).toThrow(/32 bytes/)
  })

  it('rejects a public key of the wrong length', () => {
    expect(() => deriveAddress(new Uint8Array(31))).toThrow(/32 bytes/)
  })

  it('rejects malformed hex for a public key', () => {
    expect(() => toPublicKey('nothex')).toThrow(/64 lowercase hex/)
    expect(() => toPublicKey('AB'.repeat(32))).toThrow(/64 lowercase hex/)
  })
})
