import { concatBytes, hexToBytes, u64be } from './hex.js'
import { XeUsageError } from './errors.js'
import type { Block, BlockType } from './types.js'

const VERSION_BYTE = 0x02

/**
 * Canonical type bytes. These are consensus: a value here is part of the block
 * hash, so it can never be reassigned.
 */
const TYPE_BYTES: Record<BlockType, number> = {
  send: 0x01,
  receive: 0x02,
  lease: 0x04,
  lease_accept: 0x05,
  lease_settle: 0x06,
  genesis: 0x07,
  multisig_open: 0x08,
  multisig_update: 0x09,
  lease_cancel: 0x0a,
  burn: 0x0b,
  lease_force_settle: 0x0c,
  mint: 0x0d,
  lease_renew: 0x0e,
}

const ASSET_FIELD_SIZE = 8
const MAX_MEMO_BYTES = 64

/** Memo rides only on send and burn. Every other type rejects it outright. */
const MEMO_TYPES = new Set<BlockType>(['send', 'burn'])

/** Types this SDK can encode. Genesis, mint and multisig are not client operations. */
const SUPPORTED = new Set<BlockType>([
  'send',
  'receive',
  'burn',
  'lease',
  'lease_accept',
  'lease_settle',
  'lease_cancel',
  'lease_force_settle',
  'lease_renew',
])

/**
 * Types whose hash also binds the certificate hash and the attestation set.
 * Note lease_cancel is NOT one of them: it carries neither.
 */
const LEASE_AUX_TYPES = new Set<BlockType>([
  'lease',
  'lease_accept',
  'lease_settle',
  'lease_force_settle',
  'lease_renew',
])

function assetField(asset: string): Uint8Array {
  const bytes = new TextEncoder().encode(asset)
  if (bytes.length > ASSET_FIELD_SIZE) throw new XeUsageError(`asset too long: ${asset}`)
  const out = new Uint8Array(ASSET_FIELD_SIZE)
  out.set(bytes, 0) // left-aligned, zero-padded
  return out
}

/** `previous: "0"` is the literal open-block marker, not a 64-zero hash. */
function previousField(previous: string): Uint8Array {
  if (previous === '0' || previous === '') return new Uint8Array(32)
  return hexToBytes(previous, 32)
}

function addressField(value: string | undefined, what: string): Uint8Array {
  if (!value) return new Uint8Array(32)
  try {
    return hexToBytes(value, 32)
  } catch (err) {
    throw new XeUsageError(`${what}: ${(err as Error).message}`)
  }
}

function memoBytes(memo: string | undefined): Uint8Array {
  if (!memo) return new Uint8Array(0)
  // A lone surrogate is not valid text. TextEncoder would quietly substitute
  // U+FFFD, so the bytes signed would not be the memo the caller passed.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(memo)) {
    throw new XeUsageError('memo is not valid UTF-8: it contains an unpaired surrogate')
  }
  const bytes = new TextEncoder().encode(memo)
  if (bytes.length > MAX_MEMO_BYTES) {
    throw new XeUsageError(`memo too long: ${bytes.length} bytes (max ${MAX_MEMO_BYTES})`)
  }
  return bytes
}

function required<T>(value: T | undefined, field: string, type: BlockType): T {
  if (value === undefined) throw new XeUsageError(`${type} block requires ${field}`)
  return value
}

/**
 * The canonical binary encoding — what gets hashed and signed. Excludes the
 * proof-of-work nonce and the signature.
 *
 * Layout:
 *   version(1) type(1) asset(8) account(32) previous(32) balance(8) timestamp(8)
 *   <type tail> representative(32) [memo_len(1) memo]
 *
 * Note the representative comes AFTER the type tail, not in the header, and the
 * memo length byte is always present on send and burn so a missing memo and an
 * empty memo encode identically.
 */
export function marshalCanonical(block: Block): Uint8Array {
  const typeByte = TYPE_BYTES[block.type]
  if (typeByte === undefined) throw new XeUsageError(`unknown block type: ${block.type}`)
  if (!SUPPORTED.has(block.type)) {
    throw new XeUsageError(
      `${block.type} blocks are not encodable by this SDK — it builds transfers and the lease family`,
    )
  }
  if (block.memo && !MEMO_TYPES.has(block.type)) {
    throw new XeUsageError(`memo not allowed on ${block.type} blocks`)
  }

  const header = concatBytes(
    Uint8Array.from([VERSION_BYTE, typeByte]),
    assetField(block.asset),
    addressField(block.account, 'account'),
    previousField(block.previous),
    u64be(block.balance),
    u64be(block.timestamp),
  )

  const source = (): Uint8Array =>
    addressField(required(block.source, 'source', block.type), 'source')
  const u64 = (value: bigint | undefined): Uint8Array => u64be(value ?? 0n)

  let tail: Uint8Array
  switch (block.type) {
    case 'send':
      tail = concatBytes(
        addressField(required(block.destination, 'destination', block.type), 'destination'),
        u64be(required(block.amount, 'amount', block.type)),
      )
      break
    case 'receive':
      tail = addressField(required(block.source, 'source', block.type), 'source')
      break
    case 'burn':
      tail = u64be(required(block.amount, 'amount', block.type))
      break
    case 'lease':
      tail = concatBytes(
        addressField(required(block.destination, 'destination', block.type), 'destination'),
        u64(block.amount),
        u64(block.vcpus),
        u64(block.memoryMb),
        u64(block.diskGb),
        u64(block.duration),
        addressField(block.accessPubKey, 'accessPubKey'),
      )
      break
    case 'lease_accept':
      tail = concatBytes(
        source(),
        u64(block.amount),
        u64(block.lockedR),
        u64(block.lockedPayoutCap),
        u64(block.lockedTwap),
      )
      break
    case 'lease_settle':
      tail = concatBytes(source(), u64(block.amount))
      break
    case 'lease_cancel':
    case 'lease_force_settle':
      tail = source()
      break
    case 'lease_renew':
      tail = concatBytes(
        source(),
        u64(block.amount),
        u64(block.duration),
        u64(block.lockedR),
        u64(block.lockedPayoutCap),
        u64(block.lockedTwap),
      )
      break
    default:
      throw new XeUsageError(`unreachable: unsupported type ${block.type}`)
  }

  const rep = addressField(block.representative || '', 'representative')

  if (MEMO_TYPES.has(block.type)) {
    const memo = memoBytes(block.memo)
    return concatBytes(header, tail, rep, Uint8Array.from([memo.length]), memo)
  }
  return concatBytes(header, tail, rep)
}

const AUX_TAG_ACCOUNT_PUBKEY = 'xe/block/pubkey/v1'

function lenPrefixed(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value)
  return concatBytes(u64be(BigInt(bytes.length)), bytes)
}

/**
 * The auxiliary hash input: fields that ride in the JSON wire form but must
 * still be bound to the hash, so a relay cannot rewrite them while the
 * signature still verifies.
 *
 * That is the account public-key declaration and, on a lease-family block,
 * the certificate hash and the timekeeper attestations. Note the key is framed
 * as its ASCII hex CHARACTERS, not the decoded bytes — and the section is
 * absent entirely on a non-opening block, so those hash exactly as they did
 * before key declaration existed.
 */
export function marshalAux(block: Block): Uint8Array {
  const parts: Uint8Array[] = []
  if (block.pubKey) parts.push(lenPrefixed(AUX_TAG_ACCOUNT_PUBKEY), lenPrefixed(block.pubKey))
  if (LEASE_AUX_TYPES.has(block.type)) {
    // The attestation SET is bound, not its order: sorting by key means a relay
    // reordering them changes nothing, while adding, dropping or swapping one
    // changes the hash.
    const atts = [...(block.attestations ?? [])].sort((a, b) =>
      a.publicKey < b.publicKey ? -1 : a.publicKey > b.publicKey ? 1 : 0,
    )
    parts.push(lenPrefixed(block.certificateHash ?? ''), u64be(BigInt(atts.length)))
    for (const a of atts) {
      parts.push(lenPrefixed(a.publicKey), u64be(BigInt.asUintN(64, a.timestamp)), lenPrefixed(a.signature))
    }
  }
  return concatBytes(...parts)
}

export const CANONICAL_SIZES = {
  /** 163 + memo bytes */
  send: 163,
  receive: 154,
  /** 131 + memo bytes */
  burn: 131,
  lease: 226,
  lease_accept: 186,
  lease_settle: 162,
  lease_cancel: 154,
  lease_force_settle: 154,
  lease_renew: 194,
} as const
