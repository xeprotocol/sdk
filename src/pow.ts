import { blake2b } from '@noble/hashes/blake2b'

import { concatBytes, hexToBytes, readU64be, u64le } from './hex.js'
import { digestBE, loadHash } from './pow-fast.js'
import { POW_WASM_BASE64 } from './pow-wasm.js'
import type { Hash } from './types.js'

/**
 * Block proof-of-work threshold (~2 million expected attempts).
 *
 * Higher is HARDER: a nonce is valid when its digest, read as a big-endian
 * uint64, is >= the difficulty. That is the opposite of the leading-zeros
 * convention most chains use, and it is the single easiest thing to invert
 * here.
 */
export const DEFAULT_DIFFICULTY = 0xfffff80000000000n

/** Chat envelope threshold (~262k expected attempts). */
export const CHAT_DIFFICULTY = 0xffffc00000000000n

const U64_MASK = 0xffffffffffffffffn

/**
 * powHash = big-endian uint64 of blake2b(nonce_LE(8) || hash_32, 8-byte digest)
 *
 * Note the deliberate asymmetry, which matches the node: the nonce is written
 * LITTLE-endian into the digest input, and the digest is read BIG-endian.
 */
export function powHash(nonce: bigint, hash: Uint8Array): bigint {
  const digest = blake2b(concatBytes(u64le(nonce & U64_MASK), hash), { dkLen: 8 })
  return readU64be(digest)
}

export function validatePow(hash: Uint8Array, nonce: bigint, difficulty = DEFAULT_DIFFICULTY): boolean {
  return powHash(nonce, hash) >= difficulty
}

export interface SolveOptions {
  difficulty?: bigint
  /** Called every `progressInterval` attempts. Return nothing; throw to abort. */
  onProgress?: (attempts: number) => void
  progressInterval?: number
  /** Aborts the search. The returned promise rejects with the signal's reason. */
  signal?: AbortSignal
}

/**
 * Find a nonce satisfying the difficulty.
 *
 * This is a brute-force search with no shortcut, so it yields to the event loop
 * periodically: a synchronous loop here would freeze a browser tab and stall a
 * server's other work for the duration.
 */
export async function solvePow(hash: Uint8Array | Hash, options: SolveOptions = {}): Promise<bigint> {
  const bytes = typeof hash === 'string' ? hexToBytes(hash, 32) : hash
  const difficulty = options.difficulty ?? DEFAULT_DIFFICULTY
  const interval = options.progressInterval ?? 8192

  // Start from a random nonce rather than zero: identical blocks would
  // otherwise grind the identical search, and the first valid nonce would be a
  // deterministic function of the hash.
  const start = new Uint32Array(2)
  crypto.getRandomValues(start)

  const wasm = await loadWasm()
  if (wasm) return solveWasm(wasm, bytes, (BigInt(start[1]!) << 32n) | BigInt(start[0]!), difficulty, interval, options)
  return solveJs(bytes, start[0]!, start[1]!, difficulty, interval, options)
}

interface PowWasm {
  memory: { buffer: ArrayBuffer }
  search: (start: bigint, count: number, need: bigint) => number
  digest: (nonce: bigint) => bigint
}

/** The slice of the WebAssembly API used here; the SDK's lib targets carry no wasm types. */
interface WasmApi {
  instantiate(bytes: Uint8Array): Promise<{ instance: { exports: unknown } }>
}

let wasmPromise: Promise<PowWasm | null> | undefined

/**
 * The WebAssembly search loop, or null where WebAssembly is unavailable.
 * Compiled asynchronously: browsers refuse synchronous compilation of all but
 * tiny modules on the main thread.
 */
function loadWasm(): Promise<PowWasm | null> {
  wasmPromise ??= (async () => {
    try {
      const api = (globalThis as { WebAssembly?: WasmApi }).WebAssembly
      if (!api) return null
      const bytes = Uint8Array.from(atob(POW_WASM_BASE64), (ch) => ch.charCodeAt(0))
      const { instance } = await api.instantiate(bytes)
      return instance.exports as unknown as PowWasm
    } catch {
      return null
    }
  })()
  return wasmPromise
}

async function solveWasm(
  wasm: PowWasm,
  hash: Uint8Array,
  start: bigint,
  difficulty: bigint,
  interval: number,
  options: SolveOptions,
): Promise<bigint> {
  // Batches large enough to amortise the call, small enough to yield often.
  const batch = Math.max(interval, 1 << 16)
  let nonce = start
  let attempts = 0
  for (;;) {
    checkAborted(options)
    // Reload every batch: another search may have used the shared memory
    // while this one was yielded.
    new Uint8Array(wasm.memory.buffer, 0, 32).set(hash)
    if (wasm.search(BigInt.asIntN(64, nonce), batch, BigInt.asIntN(64, difficulty))) {
      return new DataView(wasm.memory.buffer).getBigUint64(64, true)
    }
    nonce = (nonce + BigInt(batch)) & U64_MASK
    attempts += batch
    options.onProgress?.(attempts)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

async function solveJs(
  hash: Uint8Array,
  startLo: number,
  startHi: number,
  difficulty: bigint,
  interval: number,
  options: SolveOptions,
): Promise<bigint> {
  let lo = startLo
  let hi = startHi
  // Compare as two 32-bit halves so the hot loop never allocates a BigInt.
  const needHi = Number(difficulty >> 32n)
  const needLo = Number(difficulty & 0xffffffffn)
  const out = new Uint32Array(2)

  let attempts = 0
  for (;;) {
    checkAborted(options)
    // Reload every batch: the digest state is module-level and another search
    // may have run while this one was yielded.
    loadHash(hash)
    for (let i = 0; i < interval; i++) {
      digestBE(lo, hi, out)
      if (out[0]! > needHi || (out[0] === needHi && out[1]! >= needLo)) {
        return (BigInt(hi) << 32n) | BigInt(lo)
      }
      lo = (lo + 1) >>> 0
      if (lo === 0) hi = (hi + 1) >>> 0
    }
    attempts += interval
    options.onProgress?.(attempts)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

function checkAborted(options: SolveOptions): void {
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error ? options.signal.reason : new Error('solvePow: aborted')
  }
}

/** The WebAssembly digest for one nonce, for parity tests. Null without WebAssembly. */
export async function wasmPowHash(nonce: bigint, hash: Uint8Array): Promise<bigint | null> {
  const wasm = await loadWasm()
  if (!wasm) return null
  new Uint8Array(wasm.memory.buffer, 0, 32).set(hash)
  const digest = wasm.digest(BigInt.asIntN(64, nonce))
  return BigInt.asUintN(64, digest)
}
