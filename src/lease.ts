import { XeUsageError } from './errors.js'

/** micro-XUSD per unit per hour. Consensus constants: a lease priced differently is rejected. */
export const LEASE_VCPU_RATE = 20_000n
export const LEASE_MEM_GB_RATE = 10_000n
export const LEASE_DISK_GB_RATE = 1_000n

export interface LeaseDimensions {
  vcpus: bigint
  memoryMb: bigint
  diskGb: bigint
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b

/**
 * The exact cost the ledger will demand, in micro-XUSD.
 *
 * Mirrors `core.LeaseCost` step for step, including where it rounds up: whole
 * minutes, whole GiB of memory, then the multiplier. The block must carry this
 * number exactly — one micro-unit off and the node rejects the lease.
 */
export function leaseCost(dims: LeaseDimensions, durationSecs: bigint, multiplierMilli: bigint): bigint {
  if (multiplierMilli <= 0n) throw new XeUsageError('leaseCost: multiplier must be non-zero')
  if (durationSecs <= 0n) throw new XeUsageError('leaseCost: duration must be positive')
  const minutes = ceilDiv(durationSecs, 60n)
  const memGb = ceilDiv(dims.memoryMb, 1024n)
  const perHour = dims.vcpus * LEASE_VCPU_RATE + memGb * LEASE_MEM_GB_RATE + dims.diskGb * LEASE_DISK_GB_RATE
  if (perHour === 0n) throw new XeUsageError('leaseCost: a lease needs at least some resources')
  const costMicro = ceilDiv(perHour * minutes, 60n)
  const cost = ceilDiv(costMicro * multiplierMilli, 1000n)
  return cost === 0n ? 1n : cost
}
