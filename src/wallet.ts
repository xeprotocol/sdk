import { ed25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha256'

import { bytesToHex, concatBytes, hexToBytes } from './hex.js'
import { toAddress, toPublicKey, type Address, type PublicKey } from './types.js'

/**
 * Domain tag for account addresses. An address commits to a key rather than
 * being one, which is what lets a key be rotated without the account changing.
 */
const ACCOUNT_ADDRESS_DOMAIN = 'xe/account/v1'

/** address = sha256(utf8("xe/account/v1") || pubkey_32), hex. */
export function deriveAddress(publicKey: Uint8Array | PublicKey): Address {
  const bytes = typeof publicKey === 'string' ? hexToBytes(publicKey, 32) : publicKey
  if (bytes.length !== 32) throw new Error(`deriveAddress: public key must be 32 bytes, got ${bytes.length}`)
  const tag = new TextEncoder().encode(ACCOUNT_ADDRESS_DOMAIN)
  return toAddress(bytesToHex(sha256(concatBytes(tag, bytes))))
}

/**
 * An account's keys.
 *
 * The seed is the account: anyone holding it holds the funds. It is kept
 * private to this object, excluded from JSON and from inspection output, and
 * never appears in an error message. `seedHex()` exists for the one legitimate
 * case — writing a backup — and is deliberately a method call rather than a
 * property, so it cannot be reached by accident.
 */
export class Wallet {
  readonly publicKey: PublicKey
  readonly address: Address

  readonly #seed: Uint8Array

  private constructor(seed: Uint8Array) {
    if (seed.length !== 32) throw new Error(`Wallet: seed must be 32 bytes, got ${seed.length}`)
    this.#seed = seed
    const pub = ed25519.getPublicKey(seed)
    this.publicKey = toPublicKey(bytesToHex(pub))
    this.address = deriveAddress(pub)
  }

  static create(): Wallet {
    return new Wallet(ed25519.utils.randomPrivateKey())
  }

  static fromSeed(seed: Uint8Array): Wallet {
    return new Wallet(Uint8Array.from(seed))
  }

  static fromSeedHex(hex: string): Wallet {
    return new Wallet(hexToBytes(hex.trim(), 32))
  }

  /** Sign arbitrary bytes. Block signing goes through `signBlock`. */
  sign(message: Uint8Array): Uint8Array {
    return ed25519.sign(message, this.#seed)
  }

  /** The 32-byte seed, hex. For writing a backup — treat it as the funds. */
  seedHex(): string {
    return bytesToHex(this.#seed)
  }

  /** Redacted: a wallet must not leak its seed through a log line. */
  toJSON(): { address: Address; publicKey: PublicKey } {
    return { address: this.address, publicKey: this.publicKey }
  }

  toString(): string {
    return `Wallet(${this.address})`
  }
}

export function verifySignature(
  publicKey: PublicKey | Uint8Array,
  message: Uint8Array,
  signature: Uint8Array | string,
): boolean {
  const pub = typeof publicKey === 'string' ? hexToBytes(publicKey, 32) : publicKey
  const sig = typeof signature === 'string' ? hexToBytes(signature, 64) : signature
  return ed25519.verify(sig, message, pub)
}
