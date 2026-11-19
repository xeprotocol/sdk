import { sha256 } from '@noble/hashes/sha256'

import { XeClient, type TimekeeperSet } from './client.js'
import { XeApiError, XeUsageError, isRetryable } from './errors.js'
import { concatBytes, hexToBytes, u64be } from './hex.js'
import type { Attestation, Hash, PublicKey } from './types.js'
import { verifySignature } from './wallet.js'

const MAX_INT64 = (1n << 63n) - 1n
export const MAX_ATTESTATIONS_PER_BLOCK = 20

/** sha256(lease_hash_bytes || timestamp_be8) — what a timekeeper signs. */
export function attestationPayload(leaseHash: Hash, timestamp: bigint): Uint8Array {
  if (timestamp < 0n || timestamp > MAX_INT64) {
    throw new XeUsageError('attestation timestamp out of int64 range')
  }
  return sha256(concatBytes(hexToBytes(leaseHash, 32), u64be(timestamp)))
}

export function verifyAttestation(att: Attestation, leaseHash: Hash): boolean {
  if (att.timestamp < 0n || att.timestamp > MAX_INT64) {
    return false
  }
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
  for (const a of atts) {
    if (a.timestamp < 0n || a.timestamp > MAX_INT64) {
      throw new XeUsageError('attestedTime: timestamp out of int64 range')
    }
  }
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
  const wanted = new Set<string>(set.keys.map((k) => k.toLowerCase()))
  const found = await Promise.all(
    candidates.map(async (c) => {
      const client = c instanceof XeClient ? c : new XeClient({ url: c, retries: 1, timeoutMs: 10_000 })
      try {
        const info = await client.nodeInfo()
        const key = info['public_key']
        if (typeof key !== 'string') return null
        const norm = key.toLowerCase()
        return wanted.has(norm) ? { publicKey: norm as PublicKey, client } : null
      } catch {
        return null
      }
    }),
  )
  const seen = new Set<string>()
  return found.filter((t): t is Timekeeper => {
    if (!t) return false
    const id = `${t.publicKey}@${t.client.url}`
    if (seen.has(id)) return false
    seen.add(id)
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
  if (
    !Number.isInteger(set.threshold) ||
    set.threshold <= 0 ||
    set.threshold > MAX_ATTESTATIONS_PER_BLOCK
  ) {
    throw new XeUsageError(`invalid timekeeper threshold ${set.threshold}`)
  }
  const wanted = new Set<string>(set.keys.map((k) => k.toLowerCase()))
  const trusted = timekeepers.filter((tk) => wanted.has(tk.publicKey.toLowerCase()))
  const distinctKeys = new Set(trusted.map((tk) => tk.publicKey.toLowerCase()))
  if (distinctKeys.size < set.threshold) {
    throw new XeUsageError(
      `only ${distinctKeys.size} reachable timekeeper(s), need ${set.threshold}` +
        ' — pass more timekeeper URLs',
    )
  }
  const errors: string[] = []
  const results = await Promise.all(
    trusted.map(async (tk) => {
      try {
        const att = await tk.client.requestAttestation(leaseHash)
        if (typeof att.publicKey !== 'string') {
          errors.push(`${tk.client.url}: attestation missing public key`)
          return null
        }
        const pub = att.publicKey.toLowerCase() as PublicKey
        if (pub !== tk.publicKey.toLowerCase() || !wanted.has(pub)) {
          errors.push(`${tk.client.url}: attestation public key mismatch`)
          return null
        }
        const normAtt: Attestation = { ...att, publicKey: pub }
        if (!verifyAttestation(normAtt, leaseHash)) {
          errors.push(`${tk.client.url}: attestation did not verify`)
          return null
        }
        return normAtt
      } catch (err) {
        errors.push(`${tk.client.url}: ${(err as Error).message}`)
        return { failed: err }
      }
    }),
  )
  const seenKeys = new Set<string>()
  const uniqueAtts: Attestation[] = []
  for (const r of results) {
    if (r !== null && !('failed' in r)) {
      if (!seenKeys.has(r.publicKey)) {
        seenKeys.add(r.publicKey)
        uniqueAtts.push(r)
      }
    }
  }
  const atts = uniqueAtts.slice(0, MAX_ATTESTATIONS_PER_BLOCK)
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
