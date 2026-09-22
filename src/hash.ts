import { sha256 } from '@noble/hashes/sha256'

import { marshalAux, marshalCanonical } from './encoding.js'
import { bytesToHex, concatBytes, hexToBytes } from './hex.js'
import { toHash, type Block, type Hash, type SignedBlock } from './types.js'
import type { Wallet } from './wallet.js'

/**
 * hash = sha256(network_id || canonical || aux)
 *
 * The network id is folded in, so a block signed for one network cannot be
 * replayed onto another — the hash, and therefore the signature, simply does
 * not verify there. This is why every signing call needs to know which network
 * it is signing for, and why getting it wrong fails loudly rather than
 * producing a block that lands somewhere unintended.
 */
export function hashBlock(block: Block, networkId: string): Hash {
  if (!networkId) throw new Error('hashBlock: networkId is required — a block hash is network-scoped')
  const net = new TextEncoder().encode(networkId)
  const digest = sha256(concatBytes(net, marshalCanonical(block), marshalAux(block)))
  return toHash(bytesToHex(digest))
}

/**
 * Sign a block: fold in the declared key if this opens the chain, hash, then
 * sign the 32 hash bytes.
 *
 * The opening block on a chain must declare its public key and no later block
 * may — the ledger stores the key from the opening block and verifies
 * everything after against the stored one. Getting this backwards produces a
 * block every node rejects, so it is decided here from `previous` rather than
 * left to the caller.
 */
export function signBlock(block: Block, wallet: Wallet, networkId: string): SignedBlock {
  const isOpening = block.previous === '0' || block.previous === ''
  const prepared: Block = isOpening ? { ...block, pubKey: wallet.publicKey } : { ...block }
  if (!isOpening) delete prepared.pubKey

  const hash = hashBlock(prepared, networkId)
  const signature = wallet.sign(hexToBytes(hash, 32))

  return { ...prepared, hash, signature: bytesToHex(signature), powNonce: 0n }
}
