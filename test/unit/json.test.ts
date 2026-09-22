import { describe, expect, it } from 'vitest'

import { asBigInt, parseLossless, stringifyWithBigInts } from '../../src/json.js'

describe('lossless JSON', () => {
  it('preserves a nanosecond timestamp that JSON.parse would round', () => {
    const text = '{"timestamp": 1781800000000000001}'
    expect(JSON.parse(text).timestamp).toBe(1781800000000000000) // the bug
    const parsed = parseLossless(text) as { timestamp: string }
    expect(BigInt(parsed.timestamp)).toBe(1781800000000000001n) // the fix
  })

  it('preserves the largest uint64', () => {
    const parsed = parseLossless('{"amount": 18446744073709551615}') as { amount: string }
    expect(BigInt(parsed.amount)).toBe(18446744073709551615n)
  })

  it('reaches nested fields', () => {
    const parsed = parseLossless('{"block":{"balance": 9007199254740993}}') as { block: { balance: string } }
    expect(BigInt(parsed.block.balance)).toBe(9007199254740993n)
  })

  it('leaves unrelated numbers alone', () => {
    const parsed = parseLossless('{"count": 5, "amount": 5}') as { count: number; amount: string }
    expect(parsed.count).toBe(5)
    expect(parsed.amount).toBe('5')
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
      expect(BigInt((parseLossless(out) as { amount: string }).amount)).toBe(18446744073709551615n)
    })

    it('leaves ordinary values untouched', () => {
      expect(stringifyWithBigInts({ a: 1, b: 'x', c: null })).toBe('{"a":1,"b":"x","c":null}')
    })
  })
})
