declare const brand: unique symbol

/**
 * An account address: sha256("xe/account/v1" || pubkey_32), hex.
 *
 * Identity, not credential. This is what goes in a block's `account` and
 * `destination`, what a balance lookup takes, and what a user pastes to receive
 * funds. It is NOT the public key and has not been since the two were split.
 */
export type Address = string & { readonly [brand]: 'Address' }

/**
 * A raw ed25519 public key, hex.
 *
 * Credential, not identity. This is what a block's `pub_key` declares, what a
 * chat envelope and a directory registration carry, and what a multisig keyset
 * holds. Never put it in an `account` field.
 */
export type PublicKey = string & { readonly [brand]: 'PublicKey' }

/** A 32-byte hash, hex. */
export type Hash = string & { readonly [brand]: 'Hash' }

const HEX64 = /^[0-9a-f]{64}$/

function assertHex64(value: string, what: string): void {
  if (!HEX64.test(value)) {
    throw new Error(`${what}: expected 64 lowercase hex characters, got ${JSON.stringify(value)}`)
  }
}

export function toAddress(value: string): Address {
  assertHex64(value, 'toAddress')
  return value as Address
}

export function toPublicKey(value: string): PublicKey {
  assertHex64(value, 'toPublicKey')
  return value as PublicKey
}

export function toHash(value: string): Hash {
  assertHex64(value, 'toHash')
  return value as Hash
}

export type Asset = 'XE' | 'XUSD'

export type BlockType =
  | 'send'
  | 'receive'
  | 'burn'
  | 'mint'
  | 'genesis'
  | 'lease'
  | 'lease_accept'
  | 'lease_settle'
  | 'lease_cancel'
  | 'lease_force_settle'
  | 'lease_renew'
  | 'multisig_open'
  | 'multisig_update'

/**
 * A timekeeper's signed statement of the time, bound to one lease.
 *
 * Lease time never comes from the consumer's or the provider's clock: every
 * attestation-gated block (renew, force-settle, and the provider's accept and
 * settle) carries a threshold of these, and the ledger takes their lower
 * median as the authoritative time of the transition.
 */
export interface Attestation {
  publicKey: PublicKey
  /** Unix nanoseconds, as the timekeeper saw them. */
  timestamp: bigint
  signature: string
}

/**
 * A block, in the shape the canonical encoder consumes.
 *
 * Every uint64 field is a bigint: `timestamp` is unix NANOSECONDS (~1.8e18) and
 * balances are micro-units, both far beyond Number.MAX_SAFE_INTEGER. Using
 * `number` here would silently round real values.
 */
export interface Block {
  type: BlockType
  account: Address
  previous: Hash | '0'
  balance: bigint
  /** Unix nanoseconds. */
  timestamp: bigint
  asset: Asset
  representative?: Address | ''
  destination?: Address
  amount?: bigint
  source?: Hash
  memo?: string
  /** Lease dimensions. `duration` is seconds. */
  vcpus?: bigint
  memoryMb?: bigint
  diskGb?: bigint
  duration?: bigint
  /** The ed25519 key the consumer will reach the VM with. Raw 32 bytes, hex. */
  accessPubKey?: string
  /** The provider performance certificate the lease is priced against. */
  certificateHash?: Hash
  attestations?: Attestation[]
  /** Emission params locked from the epoch at the attested time (accept, renew). */
  lockedR?: bigint
  lockedPayoutCap?: bigint
  lockedTwap?: bigint
  /** Declared by the FIRST block on a chain, and by no other. */
  pubKey?: PublicKey
  hash?: Hash
  signature?: string
  powNonce?: bigint
}

/** A signed, proof-of-worked block, ready to submit. */
export interface SignedBlock extends Block {
  hash: Hash
  signature: string
  powNonce: bigint
}

/** One micro-unit. Both assets carry 6 decimal places. */
export const MICRO = 1_000_000n

/** Convert a decimal coin string ("1.5") to micro-units. Rounds up, as the protocol does. */
export function toMicro(coins: string): bigint {
  const trimmed = coins.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`toMicro: not a positive decimal: ${coins}`)
  const [whole = '0', frac = ''] = trimmed.split('.')
  const padded = frac.padEnd(6, '0')
  const keep = padded.slice(0, 6)
  const rest = padded.slice(6)
  let micro = BigInt(whole) * MICRO + BigInt(keep || '0')
  if (/[1-9]/.test(rest)) micro += 1n
  return micro
}

/** Format micro-units as a decimal coin string with 6 decimal places. */
export function fromMicro(micro: bigint): string {
  const whole = micro / MICRO
  const frac = (micro % MICRO).toString().padStart(6, '0')
  return `${whole}.${frac}`
}
