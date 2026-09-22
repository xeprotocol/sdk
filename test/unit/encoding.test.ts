import { describe, expect, it } from 'vitest'

import { CANONICAL_SIZES, marshalAux, marshalCanonical } from '../../src/encoding.js'
import { XeUsageError } from '../../src/errors.js'
import { hexToBytes } from '../../src/hex.js'
import { toAddress, toHash, toPublicKey, type Block } from '../../src/types.js'

const ADDR = toAddress('2ca26366310210ce3b26d472f37060826091ddd2259fecbea86b7e0d4e5c5496')
const DEST = toAddress('4feede759012ae67f4d4636322485f04e7d995525c6ce171da2601fdbe2e2a76')
const HASH = toHash('946597b85290426dfab812778387b93b2b3a41291ebceaac02ca0bbb0e3791ab')
const PUB = toPublicKey('54b9f36b72c7c94f247562b542b2bd48fc36be0713217396482984459e5bd06b')

const send = (over: Partial<Block> = {}): Block => ({
  type: 'send', account: ADDR, previous: HASH, balance: 1n, timestamp: 2n,
  asset: 'XE', destination: DEST, amount: 3n, ...over,
})

describe('canonical encoding', () => {
  it('produces the documented fixed sizes', () => {
    expect(marshalCanonical(send()).length).toBe(CANONICAL_SIZES.send)
    expect(
      marshalCanonical({ type: 'receive', account: ADDR, previous: HASH, balance: 1n, timestamp: 2n, asset: 'XE', source: HASH }).length,
    ).toBe(CANONICAL_SIZES.receive)
    expect(
      marshalCanonical({ type: 'burn', account: ADDR, previous: HASH, balance: 1n, timestamp: 2n, asset: 'XE', amount: 3n }).length,
    ).toBe(CANONICAL_SIZES.burn)
  })

  it('grows by exactly the memo byte length', () => {
    const memo = 'héllo' // 6 UTF-8 bytes from 5 characters
    expect(marshalCanonical(send({ memo })).length).toBe(CANONICAL_SIZES.send + 6)
  })

  it('encodes a missing memo and an empty memo identically', () => {
    // The length byte is always present, so these must not diverge.
    expect(marshalCanonical(send())).toEqual(marshalCanonical(send({ memo: '' })))
  })

  it('puts the representative AFTER the type tail, not in the header', () => {
    const withRep = marshalCanonical(send({ representative: DEST }))
    const tailStart = 90 + 40 // header + send tail
    expect(Array.from(withRep.slice(tailStart, tailStart + 32)))
      .toEqual(Array.from(hexToBytes(DEST, 32)))
  })

  it('zero-fills an absent representative', () => {
    const bytes = marshalCanonical(send())
    expect(bytes.slice(130, 162).every((b) => b === 0)).toBe(true)
  })

  it('treats previous "0" as the open-block marker, not a 64-zero hash', () => {
    const open = marshalCanonical(send({ previous: '0' }))
    expect(open.length).toBe(CANONICAL_SIZES.send)
    expect(open.slice(42, 74).every((b) => b === 0)).toBe(true)
  })

  it('left-aligns and zero-pads the asset field', () => {
    const bytes = marshalCanonical(send({ asset: 'XE' }))
    expect(Array.from(bytes.slice(2, 10))).toEqual([0x58, 0x45, 0, 0, 0, 0, 0, 0])
    const xusd = marshalCanonical(send({ asset: 'XUSD' }))
    expect(Array.from(xusd.slice(2, 10))).toEqual([0x58, 0x55, 0x53, 0x44, 0, 0, 0, 0])
  })

  describe('memo rules', () => {
    it('rejects a memo on a receive block', () => {
      expect(() =>
        marshalCanonical({ type: 'receive', account: ADDR, previous: HASH, balance: 1n, timestamp: 2n, asset: 'XE', source: HASH, memo: 'no' }),
      ).toThrow(XeUsageError)
    })

    it('rejects a memo over 64 bytes', () => {
      expect(() => marshalCanonical(send({ memo: 'a'.repeat(65) }))).toThrow(/memo too long/)
    })

    it('counts BYTES, not characters, against the limit', () => {
      // 33 two-byte characters is 66 bytes — over the limit despite being
      // only 33 "characters" long.
      expect(() => marshalCanonical(send({ memo: 'é'.repeat(33) }))).toThrow(/memo too long/)
      expect(() => marshalCanonical(send({ memo: 'é'.repeat(32) }))).not.toThrow()
    })
  })

  it('rejects a block missing a required field', () => {
    const { amount: _a, ...noAmount } = send()
    expect(() => marshalCanonical(noAmount as Block)).toThrow(/requires amount/)
  })

  it('refuses block types it cannot yet encode, rather than guessing', () => {
    expect(() =>
      marshalCanonical({ type: 'lease', account: ADDR, previous: HASH, balance: 1n, timestamp: 2n, asset: 'XUSD' }),
    ).toThrow(/not encodable by this SDK yet/)
  })
})

describe('aux encoding', () => {
  it('is empty when no key is declared, so non-opening blocks hash unchanged', () => {
    expect(marshalAux(send()).length).toBe(0)
  })

  it('frames the tag and the key as length-prefixed sections', () => {
    const aux = marshalAux(send({ previous: '0', pubKey: PUB }))
    // len8("xe/block/pubkey/v1") + 18 + len8(64 hex chars) + 64
    expect(aux.length).toBe(8 + 18 + 8 + 64)
  })

  it('frames the key as its ASCII hex CHARACTERS, not decoded bytes', () => {
    const aux = marshalAux(send({ previous: '0', pubKey: PUB }))
    expect(new TextDecoder().decode(aux.slice(8 + 18 + 8))).toBe(PUB)
  })
})
