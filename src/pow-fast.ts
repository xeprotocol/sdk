/**
 * The proof-of-work inner loop, specialised.
 *
 * The digest input is always 40 bytes — nonce_LE(8) || hash(32) — which is a
 * single BLAKE2b block, and the output is 8 bytes. A general-purpose hasher
 * allocates, pads and finalises on every attempt; this does one compression on
 * preallocated 32-bit word pairs and never touches a BigInt. That is roughly
 * an order of magnitude faster, which matters: a renewal has to be proven and
 * land before the lease it extends expires.
 *
 * `powHash` in pow.ts stays the reference; the tests hold the two equal.
 */

const IV = Uint32Array.from([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
])

const SIGMA = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
  11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
  7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
  9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
  2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
  12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
  13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
  6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
  10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
].map((x) => x * 2)

/** h[0] with the parameter block folded in: digest length 8, no key, fanout 1, depth 1. */
const H0_LO = (IV[0]! ^ 0x01010008) >>> 0

const v = new Uint32Array(32)
const m = new Uint32Array(32)

function add(a: number, b: number): void {
  const lo = v[a]! + v[b]!
  v[a] = lo
  v[a + 1] = v[a + 1]! + v[b + 1]! + (lo >= 0x100000000 ? 1 : 0)
}

function addM(a: number, x: number): void {
  const lo = v[a]! + m[x]!
  v[a] = lo
  v[a + 1] = v[a + 1]! + m[x + 1]! + (lo >= 0x100000000 ? 1 : 0)
}

function g(a: number, b: number, c: number, d: number, x: number, y: number): void {
  add(a, b)
  addM(a, x)
  let lo = v[d]! ^ v[a]!
  let hi = v[d + 1]! ^ v[a + 1]!
  v[d] = hi // rotr 32
  v[d + 1] = lo
  add(c, d)
  lo = v[b]! ^ v[c]!
  hi = v[b + 1]! ^ v[c + 1]!
  v[b] = (lo >>> 24) ^ (hi << 8) // rotr 24
  v[b + 1] = (hi >>> 24) ^ (lo << 8)
  add(a, b)
  addM(a, y)
  lo = v[d]! ^ v[a]!
  hi = v[d + 1]! ^ v[a + 1]!
  v[d] = (lo >>> 16) ^ (hi << 16) // rotr 16
  v[d + 1] = (hi >>> 16) ^ (lo << 16)
  add(c, d)
  lo = v[b]! ^ v[c]!
  hi = v[b + 1]! ^ v[c + 1]!
  v[b] = (hi >>> 31) ^ (lo << 1) // rotr 63
  v[b + 1] = (lo >>> 31) ^ (hi << 1)
}

/** Load the 32-byte block hash into message words 1..4 (m[2..9]). Words 5..15 stay zero. */
export function loadHash(hash: Uint8Array): void {
  m.fill(0)
  for (let i = 0; i < 8; i++) {
    const o = i * 4
    m[2 + i] = (hash[o]! | (hash[o + 1]! << 8) | (hash[o + 2]! << 16) | (hash[o + 3]! << 24)) >>> 0
  }
}

/**
 * The digest for one nonce, read big-endian as the node does, returned as its
 * high and low 32 bits in `out`. `loadHash` must have been called first.
 */
export function digestBE(nonceLo: number, nonceHi: number, out: Uint32Array): void {
  m[0] = nonceLo
  m[1] = nonceHi
  v[0] = H0_LO
  for (let i = 1; i < 16; i++) v[i] = IV[i]!
  v.set(IV, 16)
  v[24] = v[24]! ^ 40 // bytes compressed so far
  v[28] = ~v[28]! // final block
  v[29] = ~v[29]!
  for (let r = 0; r < 12; r++) {
    const s = r * 16
    g(0, 8, 16, 24, SIGMA[s]!, SIGMA[s + 1]!)
    g(2, 10, 18, 26, SIGMA[s + 2]!, SIGMA[s + 3]!)
    g(4, 12, 20, 28, SIGMA[s + 4]!, SIGMA[s + 5]!)
    g(6, 14, 22, 30, SIGMA[s + 6]!, SIGMA[s + 7]!)
    g(0, 10, 20, 30, SIGMA[s + 8]!, SIGMA[s + 9]!)
    g(2, 12, 22, 24, SIGMA[s + 10]!, SIGMA[s + 11]!)
    g(4, 14, 16, 26, SIGMA[s + 12]!, SIGMA[s + 13]!)
    g(6, 8, 18, 28, SIGMA[s + 14]!, SIGMA[s + 15]!)
  }
  // Output word 0 is little-endian bytes lo..hi; the node reads them big-endian.
  const lo = (H0_LO ^ v[0]! ^ v[16]!) >>> 0
  const hi = (IV[1]! ^ v[1]! ^ v[17]!) >>> 0
  out[0] = bswap(lo)
  out[1] = bswap(hi)
}

function bswap(x: number): number {
  return (((x & 0xff) << 24) | ((x & 0xff00) << 8) | ((x >>> 8) & 0xff00) | (x >>> 24)) >>> 0
}
