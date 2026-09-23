import { sha256 } from '@noble/hashes/sha256'

import { XeClient, type TimekeeperSet } from './client.js'
import { XeApiError, XeUsageError, isRetryable } from './errors.js'
import { concatBytes, hexToBytes, u64be } from './hex.js'
import type { Attestation, Hash, PublicKey } from './types.js'
import { verifySignature } from './wallet.js'

/** sha256(lease_hash_bytes || timestamp_be8) — what a timekeeper signs. */
export function attestationPayload(leaseHash: Hash, timestamp: bigint): Uint8Array {
  return sha256(concatBytes(hexToBytes(leaseHash, 32), u64be(BigInt.asUintN(64, timestamp))))
}

export function verifyAttestation(att: Attestation, leaseHash: Hash): boolean {
  try {
    return verifySignature(att.publicKey, attestationPayload(leaseHash, att.timestamp), att.signature)
  } catch {
    return false
  }
}

/**
 * The time the ledger will take from a set of attestations: the LOWER median
 * of their timestamps, exactly as the node computes it.
 */
export function attestedTime(atts: Attestation[]): bigint {
  if (atts.length === 0) throw new XeUsageError('attestedTime: no attestations')
  const sorted = atts.map((a) => a.timestamp).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return sorted[Math.floor((sorted.length - 1) / 2)]!
}

/** A node whose signing key is in `sys.timekeepers`. */
export interface Timekeeper {
  publicKey: PublicKey
  client: XeClient
}

/**
 * Match candidate node URLs to the timekeeper set.
 *
 * `sys.timekeepers` names keys, not endpoints — there is no in-protocol way to
 * find a timekeeper's API from its key. So the caller supplies candidate URLs
 * and each is asked who it is. Unreachable candidates are skipped, not fatal:
 * only a threshold is needed.
 */
export async function discoverTimekeepers(
  set: TimekeeperSet,
  candidates: (XeClient | string)[],
): Promise<Timekeeper[]> {
  const wanted = new Set<string>(set.keys)
  const found = await Promise.all(
    candidates.map(async (c) => {
      const client = c instanceof XeClient ? c : new XeClient({ url: c, retries: 1, timeoutMs: 10_000 })
      try {
        const info = await client.nodeInfo()
        const key = info['public_key']
        return typeof key === 'string' && wanted.has(key) ? { publicKey: key as PublicKey, client } : null
      } catch {
        return null
      }
    }),
  )
  const seen = new Set<string>()
  return found.filter((t): t is Timekeeper => {
    if (!t || seen.has(t.publicKey)) return false
    seen.add(t.publicKey)
    return true
  })
}

/**
 * Collect a threshold of verified attestations for a lease, asking every
 * timekeeper in parallel.
 *
 * Each attestation is checked locally before it is used — signature, key
 * membership, one per key — because a block carrying a bad one is rejected as
 * a whole, and it is cheaper to find out here.
 */
export async function gatherAttestations(
  leaseHash: Hash,
  set: TimekeeperSet,
  timekeepers: Timekeeper[],
): Promise<Attestation[]> {
  if (timekeepers.length < set.threshold) {
    throw new XeUsageError(
      `only ${timekeepers.length} reachable timekeeper(s), need ${set.threshold} — pass more timekeeper URLs`,
    )
  }
  const errors: string[] = []
  const results = await Promise.all(
    timekeepers.map(async (tk) => {
      try {
        const att = await tk.client.requestAttestation(leaseHash)
        if (att.publicKey !== tk.publicKey || !verifyAttestation(att, leaseHash)) {
          errors.push(`${tk.client.url}: attestation did not verify`)
          return null
        }
        return att
      } catch (err) {
        errors.push(`${tk.client.url}: ${(err as Error).message}`)
        return { failed: err }
      }
    }),
  )
  const atts = results.filter((r): r is Attestation => r !== null && !('failed' in r))
  if (atts.length >= set.threshold) return atts
  // Retryable if any refusal was: a timekeeper rate-limits each lease for a
  // short window, and a lease it has not yet seen is refused until it syncs.
  const retryable = results.some((r) => r !== null && 'failed' in r && isRetryableAttestation(r.failed))
  throw new XeApiError(
    `gathered ${atts.length} of ${set.threshold} attestations: ${errors.join('; ')}`,
    503,
    retryable,
    null,
  )
}

function isRetryableAttestation(err: unknown): boolean {
  if (isRetryable(err)) return true
  const msg = err instanceof Error ? err.message : ''
  return /rate limit|too many|unknown attestation identifier|not a live lease/i.test(msg)
}
