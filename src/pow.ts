import { blake2b } from '@noble/hashes/blake2b'

import { concatBytes, hexToBytes, readU64be, u64le } from './hex.js'
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
  const start = new Uint8Array(8)
  crypto.getRandomValues(start)
  let nonce = readU64be(start)

  let attempts = 0
  for (;;) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error('solvePow: aborted')
    }
    if (powHash(nonce, bytes) >= difficulty) return nonce
    nonce = (nonce + 1n) & U64_MASK
    attempts++
    if (attempts % interval === 0) {
      options.onProgress?.(attempts)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }
}
