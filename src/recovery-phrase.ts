import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { hmac } from '@noble/hashes/hmac'
import { sha512 } from '@noble/hashes/sha512'

/** SLIP-0044 type. Changing it changes all phrase-derived accounts. */
export const RECOVERY_PHRASE_COIN_TYPE = 22597

export type PhraseErrorCode = 'word_count' | 'unknown_word' | 'checksum' | 'account'

/** Validation errors never contain the user's words or passphrase. */
export class PhraseError extends Error {
  constructor(
    readonly code: PhraseErrorCode,
    message: string,
    readonly position?: number,
  ) {
    super(message)
    this.name = 'PhraseError'
  }
}

export interface PhraseOptions {
  passphrase?: string
  account?: number
}

export function normalizePhrase(phrase: string): string {
  return phrase.toLowerCase().split(/\p{White_Space}+/u).filter(Boolean).join(' ').normalize('NFKD')
}

const englishWords = new Set(wordlist)

export function validatePhrase(phrase: string): string {
  const normalized = normalizePhrase(phrase)
  const words = normalized ? normalized.split(' ') : []
  if (![12, 15, 18, 21, 24].includes(words.length)) {
    throw new PhraseError('word_count', 'recovery phrase must have 12, 15, 18, 21 or 24 words')
  }
  const unknown = words.findIndex(word => !englishWords.has(word))
  if (unknown !== -1) {
    throw new PhraseError('unknown_word', `unknown recovery phrase word at position ${unknown + 1}`, unknown + 1)
  }
  if (!validateMnemonic(normalized, wordlist)) {
    throw new PhraseError('checksum', 'recovery phrase checksum does not match')
  }
  return normalized
}

export function generatePhrase(): string {
  return generateMnemonic(wordlist, 256)
}

function validateAccount(account: number): void {
  if (!Number.isInteger(account) || account < 0 || account >= 0x80000000) {
    throw new PhraseError('account', 'recovery phrase account must be between 0 and 2147483647')
  }
}

// Internal module export for the shared official chain vectors. Paths contain
// unhardened index numbers; every child is hardened by this implementation.
export function slip10Ed25519(seed: Uint8Array, path: readonly number[]): { key: Uint8Array; chainCode: Uint8Array } {
  let node = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed)
  for (const index of path) {
    validateAccount(index)
    const data = new Uint8Array(37)
    data.set(node.subarray(0, 32), 1)
    new DataView(data.buffer).setUint32(33, index + 0x80000000, false)
    node = hmac(sha512, node.subarray(32), data)
  }
  return { key: node.slice(0, 32), chainCode: node.slice(32) }
}

export function seedFromPhrase(phrase: string, { passphrase = '', account = 0 }: PhraseOptions = {}): Uint8Array {
  validateAccount(account)
  const seed = mnemonicToSeedSync(validatePhrase(phrase), passphrase)
  return slip10Ed25519(seed, [44, RECOVERY_PHRASE_COIN_TYPE, account]).key
}
