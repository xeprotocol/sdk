export { XeClient } from './client.js'
export type {
  Balances,
  Certificate,
  ClientOptions,
  Epoch,
  LeaseRecord,
  LeaseSegment,
  LeaseState,
  PendingSend,
  Provider,
  SubmitResult,
  TimekeeperSet,
} from './client.js'

export { Xe, leasePaid, nowNs } from './xe.js'
export type { Machine, OpenLeaseOptions, OpenedLease, Quote, RenewGuards, RenewedLease, SendOptions, XeOptions } from './xe.js'

export { holdLease } from './hold.js'
export type { HoldEvent, HoldOptions, HoldReason, HoldResult } from './hold.js'
export { leaseCost, pricePerMinute, LEASE_DISK_GB_RATE, LEASE_MEM_GB_RATE, LEASE_VCPU_RATE } from './lease.js'
export type { LeaseDimensions } from './lease.js'
export {
  attestationPayload,
  attestedTime,
  discoverTimekeepers,
  gatherAttestations,
  verifyAttestation,
} from './attestation.js'
export type { Timekeeper } from './attestation.js'

export { Wallet, deriveAddress, verifySignature } from './wallet.js'

export { hashBlock, signBlock } from './hash.js'
export { marshalAux, marshalCanonical, CANONICAL_SIZES } from './encoding.js'
export { CHAT_DIFFICULTY, DEFAULT_DIFFICULTY, powHash, solvePow, validatePow } from './pow.js'
export type { SolveOptions } from './pow.js'

export {
  XeApiError,
  XeBudgetError,
  XeError,
  XeInsufficientFundsError,
  XePriceError,
  XeTransportError,
  XeUsageError,
  isRetryable,
} from './errors.js'

export { fromMicro, toAddress, toHash, toMicro, toPublicKey, MICRO } from './types.js'
export type { Address, Asset, Attestation, Block, BlockType, Hash, PublicKey, SignedBlock } from './types.js'

export { bytesToHex, hexToBytes } from './hex.js'
export { parseLossless, stringifyWithBigInts } from './json.js'
