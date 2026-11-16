import { describe, expect, it } from 'vitest'
import vectorsJson from '../fixtures/recovery-phrase-vectors.json?raw'
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { sha256 } from '@noble/hashes/sha256'
import { Wallet, PhraseError, RECOVERY_PHRASE_COIN_TYPE } from '../../src/index.js'
import { slip10Ed25519 } from '../../src/recovery-phrase.js'
import { bytesToHex, hexToBytes } from '../../src/hex.js'

// Byte-for-byte copy of core/core/testdata/recovery-phrase-vectors.json.
interface Vectors {
  version: number
  coin_type: number
  coin_type_provisional: boolean
  wordlist_sha256: string
  bip39: { entropy: string; mnemonic: string; passphrase: string; seed: string }[]
  slip10_ed25519: { seed: string; path: string; chain_code: string; private_key: string; public_key: string }[]
  xe: { phrase: string; passphrase: string; account: number; ed25519_seed: string; public_key: string; address: string }[]
  invalid: { phrase: string; error: string; position?: number }[]
}
const vectors: Vectors = JSON.parse(vectorsJson)

describe('recovery phrase v2', () => {
  it('pins the shared file and English wordlist', () => {
    expect(vectors.version).toBe(2)
    expect(vectors.coin_type).toBe(RECOVERY_PHRASE_COIN_TYPE)
    expect(vectors.coin_type_provisional).toBe(false)
    expect(vectors.bip39).toHaveLength(24)
    expect(vectors.slip10_ed25519).toHaveLength(12)
    expect(vectors.xe).toHaveLength(10)
    expect(vectors.invalid).toHaveLength(4)
    expect(bytesToHex(sha256(new TextEncoder().encode(wordlist.join('\n') + '\n')))).toBe(vectors.wordlist_sha256)
  })
  it.each(vectors.bip39)('official BIP39 entropy $entropy', v => {
    expect(entropyToMnemonic(hexToBytes(v.entropy), wordlist)).toBe(v.mnemonic)
    expect(Wallet.validatePhrase(v.mnemonic)).toBe(v.mnemonic)
    expect(bytesToHex(mnemonicToSeedSync(v.mnemonic, v.passphrase))).toBe(v.seed)
  })
  it.each(vectors.slip10_ed25519)('official SLIP-0010 $path', v => {
    const node = slip10Ed25519(hexToBytes(v.seed), v.path.split('/').slice(1).map(part => Number(part.slice(0, -1))))
    expect(bytesToHex(node.key)).toBe(v.private_key)
    expect(bytesToHex(node.chainCode)).toBe(v.chain_code)
    expect('00' + Wallet.fromSeed(node.key).publicKey).toBe(v.public_key)
  })
  it.each(vectors.xe)('XE account $account at $address', v => {
    const wallet = Wallet.fromPhrase(v.phrase, v)
    expect(wallet.seedHex()).toBe(v.ed25519_seed)
    expect(wallet.publicKey).toBe(v.public_key)
    expect(wallet.address).toBe(v.address)
    expect(JSON.stringify(wallet)).not.toContain(v.phrase)
    expect(Object.keys(wallet).sort()).toEqual(['address', 'publicKey'])
  })
  it.each(vectors.invalid)('typed $error error', v => {
    expect(() => Wallet.validatePhrase(v.phrase)).toThrow(PhraseError)
    try { Wallet.validatePhrase(v.phrase) } catch (error) {
      expect(error).toMatchObject({ code: v.error, position: v.position })
      expect(String(error)).not.toContain('notaword')
    }
  })
  it.each([-1, 0.5, 2147483648, Infinity, NaN])('rejects invalid account %s', account => {
    expect(() => Wallet.fromPhrase(vectors.xe[0]!.phrase, { account })).toThrow(PhraseError)
  })
  it('normalizes words and NFKD passphrases without trimming the passphrase', () => {
    const phrase = vectors.xe[0]!.phrase
    expect(Wallet.fromPhrase('\u0085' + phrase.toUpperCase().replaceAll(' ', '\u2003\t')).address).toBe(vectors.xe[0]!.address)
    expect(Wallet.fromPhrase(phrase, { passphrase: 'café' }).address).toBe(Wallet.fromPhrase(phrase, { passphrase: 'cafe\u0301' }).address)
    expect(Wallet.fromPhrase(phrase, { passphrase: 'café ' }).address).not.toBe(Wallet.fromPhrase(phrase, { passphrase: 'café' }).address)
  })
  it('generates distinct 24-word backups with deterministic restoration', () => {
    const phrases = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const phrase = Wallet.generatePhrase()
      expect(phrase.split(' ')).toHaveLength(24)
      expect(Wallet.validatePhrase(phrase)).toBe(phrase)
      expect(Wallet.fromPhrase(phrase).address).toBe(Wallet.fromPhrase(phrase).address)
      phrases.add(phrase)
    }
    expect(phrases.size).toBe(20)
  })
})
