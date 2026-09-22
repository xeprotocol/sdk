import { describe, expect, it } from 'vitest'

import { fromMicro, toAddress, toHash, toMicro } from '../../src/types.js'

describe('micro-unit conversion', () => {
  it('converts whole and fractional coins', () => {
    expect(toMicro('1')).toBe(1_000_000n)
    expect(toMicro('1.5')).toBe(1_500_000n)
    expect(toMicro('0.000001')).toBe(1n)
  })

  it('rounds UP, as the protocol does', () => {
    // Rounding down would let a caller under-pay by a sub-micro remainder.
    expect(toMicro('0.0000001')).toBe(1n)
    expect(toMicro('1.0000005')).toBe(1_000_001n)
  })

  it('does not round a value that is already exact', () => {
    expect(toMicro('1.000000')).toBe(1_000_000n)
  })

  it('handles amounts beyond Number precision', () => {
    expect(toMicro('18446744073709.551615')).toBe(18446744073709551615n)
  })

  it('rejects nonsense', () => {
    expect(() => toMicro('')).toThrow()
    expect(() => toMicro('-1')).toThrow()
    expect(() => toMicro('1.2.3')).toThrow()
    expect(() => toMicro('abc')).toThrow()
  })

  it('formats back with six decimal places', () => {
    expect(fromMicro(1_500_000n)).toBe('1.500000')
    expect(fromMicro(1n)).toBe('0.000001')
    expect(fromMicro(0n)).toBe('0.000000')
  })

  it('round-trips', () => {
    for (const v of ['0.000000', '1.000000', '123.456789', '18446744073709.551615']) {
      expect(fromMicro(toMicro(v))).toBe(v)
    }
  })
})

describe('branded identifiers', () => {
  it('accepts valid 64-char lowercase hex', () => {
    expect(() => toAddress('a'.repeat(64))).not.toThrow()
    expect(() => toHash('0'.repeat(64))).not.toThrow()
  })

  it('rejects the wrong length, uppercase, and non-hex', () => {
    expect(() => toAddress('a'.repeat(63))).toThrow()
    expect(() => toAddress('A'.repeat(64))).toThrow()
    expect(() => toAddress('g'.repeat(64))).toThrow()
  })
})
