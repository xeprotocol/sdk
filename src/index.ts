export { XeClient } from './client.js'
export type { Balances, ClientOptions, PendingSend, SubmitResult } from './client.js'

export { Xe, nowNs } from './xe.js'
export type { SendOptions, XeOptions } from './xe.js'

export { Wallet, deriveAddress, verifySignature } from './wallet.js'

export { hashBlock, signBlock } from './hash.js'
export { marshalAux, marshalCanonical, CANONICAL_SIZES } from './encoding.js'
export { CHAT_DIFFICULTY, DEFAULT_DIFFICULTY, powHash, solvePow, validatePow } from './pow.js'
export type { SolveOptions } from './pow.js'

export {
  XeApiError,
  XeError,
  XeInsufficientFundsError,
  XeTransportError,
  XeUsageError,
  isRetryable,
} from './errors.js'

export { fromMicro, toAddress, toHash, toMicro, toPublicKey, MICRO } from './types.js'
export type { Address, Asset, Block, BlockType, Hash, PublicKey, SignedBlock } from './types.js'

export { bytesToHex, hexToBytes } from './hex.js'
export { parseLossless, stringifyWithBigInts } from './json.js'
