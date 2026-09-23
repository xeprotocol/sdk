import { describe, expect, it } from 'vitest'

import { asBigInt, parseLossless, stringifyWithBigInts } from '../../src/json.js'

describe('lossless JSON', () => {
  it('preserves a nanosecond timestamp that JSON.parse would round', () => {
    const text = '{"timestamp": 1781800000000000001}'
    expect(JSON.parse(text).timestamp).toBe(1781800000000000000) // the bug
    const parsed = parseLossless(text) as { timestamp: bigint }
    expect(parsed.timestamp).toBe(1781800000000000001n) // the fix
  })

  it('preserves the largest uint64', () => {
    const parsed = parseLossless('{"amount": 18446744073709551615}') as { amount: bigint }
    expect(parsed.amount).toBe(18446744073709551615n)
  })

  it('reaches nested fields', () => {
    const parsed = parseLossless('{"block":{"balance": 9007199254740993}}') as { block: { balance: bigint } }
    expect(parsed.block.balance).toBe(9007199254740993n)
  })

  it('leaves unrelated numbers alone', () => {
    const parsed = parseLossless('{"count": 5, "amount": 5}') as { count: number; amount: bigint }
    expect(parsed.count).toBe(5)
    expect(parsed.amount).toBe(5n)
  })

  it('parses a float with a long fraction (a certificate score) as a number', () => {
    // Go prints float64 at up to 17 significant digits. The scanner used to
    // treat the digits after the point as a fresh integer, quote them, and
    // hand JSON.parse `0."…"` — every certificate read failed as "not JSON".
    const out = parseLossless('{"score":0.12345678901234568,"x":1.2345678901234568e-05,"n":1}') as Record<string, unknown>
    expect(out['score']).toBe(0.12345678901234568)
    expect(out['x']).toBe(1.2345678901234568e-5)
  })

  it('leaves a float under a known uint64 key as a number', () => {
    // The key pattern used to match the integer part alone and quote only
    // `1`, leaving `.5` dangling after the string.
    expect(parseLossless('{"duration":1.5}')).toEqual({ duration: 1.5 })
    expect(parseLossless('{"cost":15.25,"stake":2e3}')).toEqual({ cost: 15.25, stake: 2000 })
  })

  it('does not corrupt strings that merely contain a key name', () => {
    const parsed = parseLossless('{"note":"the amount: 12 was fine"}') as { note: string }
    expect(parsed.note).toBe('the amount: 12 was fine')
  })

  describe('asBigInt', () => {
    it('accepts strings, bigints and safe numbers', () => {
      expect(asBigInt('12', 'x')).toBe(12n)
      expect(asBigInt(12n, 'x')).toBe(12n)
      expect(asBigInt(12, 'x')).toBe(12n)
    })

    it('refuses an unsafe number rather than silently rounding', () => {
      // The literal below genuinely loses precision — that is what is being
      // tested, so the lint rule that flags it is disabled deliberately here.
      // eslint-disable-next-line no-loss-of-precision
      expect(() => asBigInt(1781800000000000001, 'ts')).toThrow(/ts: expected an integer/)
    })

    it('names the field it failed on', () => {
      expect(() => asBigInt(null, 'balance.XE')).toThrow(/balance\.XE/)
    })
  })

  describe('stringifyWithBigInts', () => {
    it('emits bigints as JSON numbers without passing through Number', () => {
      expect(stringifyWithBigInts({ timestamp: 1781800000000000001n })).toBe(
        '{"timestamp":1781800000000000001}',
      )
    })

    it('round-trips through the lossless parser', () => {
      const out = stringifyWithBigInts({ amount: 18446744073709551615n })
      expect((parseLossless(out) as { amount: bigint }).amount).toBe(18446744073709551615n)
    })

    it('leaves ordinary values untouched', () => {
      expect(stringifyWithBigInts({ a: 1, b: 'x', c: null })).toBe('{"a":1,"b":"x","c":null}')
    })
  })
})

describe('marker safety', () => {
  it('does not revive a string the node genuinely sent', () => {
    // The marker is only ever written by this module, in front of digits, and
    // a string that merely looks numeric must stay a string.
    const parsed = parseLossless('{"note":"12345678901234567890"}') as { note: string }
    expect(parsed.note).toBe('12345678901234567890')
    expect(typeof parsed.note).toBe('string')
  })

  it('leaves a memo containing digits untouched', () => {
    const parsed = parseLossless('{"memo":"paid 1781800000000000001 units"}') as { memo: string }
    expect(parsed.memo).toBe('paid 1781800000000000001 units')
  })
})
