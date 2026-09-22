const HEX = /^[0-9a-f]*$/

/** Decode a lowercase hex string. Throws on odd length, non-hex, or wrong size. */
export function hexToBytes(hex: string, expectedLen?: number): Uint8Array {
  if (typeof hex !== 'string') throw new TypeError('hexToBytes: expected a string')
  if (hex.length % 2 !== 0) throw new Error('hexToBytes: odd-length string')
  if (!HEX.test(hex)) throw new Error('hexToBytes: not lowercase hex')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  if (expectedLen != null && out.length !== expectedLen) {
    throw new Error(`hexToBytes: expected ${expectedLen} bytes, got ${out.length}`)
  }
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** Big-endian uint64. Values are bigint because uint64 exceeds Number's safe range. */
export function u64be(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new RangeError(`u64be: ${value} out of uint64 range`)
  }
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, value, false)
  return out
}

/** Little-endian uint64 — used only inside the proof-of-work digest input. */
export function u64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, value & 0xffffffffffffffffn, true)
  return out
}

export function readU64be(bytes: Uint8Array, offset = 0): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, false)
}
