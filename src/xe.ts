import { attestedTime, discoverTimekeepers, gatherAttestations, type Timekeeper } from './attestation.js'
import {
  XeClient,
  type Certificate,
  type ClientOptions,
  type Epoch,
  type LeaseRecord,
  type LeaseState,
  type PendingSend,
  type SubmitResult,
  type TimekeeperSet,
  toEpoch,
} from './client.js'
import { XeApiError, XeBudgetError, XeInsufficientFundsError, XePriceError, XeUsageError } from './errors.js'
import { leaseCost, pricePerMinute, requireWholeMinutes } from './lease.js'
import { signBlock } from './hash.js'
import { DEFAULT_DIFFICULTY, solvePow } from './pow.js'
import { hexToBytes } from './hex.js'
import type { Address, Asset, Attestation, Block, Hash, SignedBlock } from './types.js'
import type { Wallet } from './wallet.js'

/** Unix nanoseconds. Millisecond resolution is all the platform offers. */
export function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n
}

export interface XeOptions {
  client: XeClient | ClientOptions | string
  wallet: Wallet
  /** Overrides the network id read from the node. Rarely needed. */
  networkId?: string
  onProgress?: (attempts: number) => void
  /**
   * Node API URLs to try as timekeepers. `sys.timekeepers` names keys, not
   * endpoints, so renewals and force-settles need somewhere to ask. Defaults
   * to the client's own node, which is enough only if it is a timekeeper and
   * the threshold is 1.
   */
  timekeepers?: (XeClient | string)[]
}

/** The machine a lease asks for. */
export interface Machine {
  vcpus: bigint | number
  memoryMb: bigint | number
  diskGb: bigint | number
}

/** What one provider charges, right now, for one minute of a machine. */
export interface Quote {
  provider: Address
  /** micro-XUSD per billing minute. */
  pricePerMinute: bigint
  certificate: Certificate
  /** Unix nanoseconds; 0 means no expiry. */
  certificateExpiresAt: bigint
}

/** Checked before a renewal is signed; a renewal that fails one is never sent. */
export interface RenewGuards {
  /** micro-XUSD per minute. Above it, `XePriceError`. */
  maxPricePerMinute?: bigint
  /** micro-XUSD for the lease's whole cost, first term plus every renewal. Over it, `XeBudgetError`. */
  budget?: bigint
}

export interface OpenLeaseOptions {
  /** Omit to take the cheapest provider that can fit the machine within `maxPricePerMinute`. */
  provider?: Address
  /** micro-XUSD per minute; a dearer provider is refused with `XePriceError` before signing. */
  maxPricePerMinute?: bigint
  vcpus: bigint | number
  memoryMb: bigint | number
  diskGb: bigint | number
  durationSecs: bigint | number
  /** The ed25519 public key (hex, 32 bytes) the VM will accept for SSH. */
  accessPubKey?: string
}

export interface OpenedLease extends SubmitResult {
  cost: bigint
  certificate: Certificate
}

export interface RenewedLease extends SubmitResult {
  lease: Hash
  cost: bigint
  durationSecs: bigint
  /** The attested renewal time the ledger will record, unix ns. */
  renewTime: bigint
  epoch: Epoch
}

export interface SendOptions {
  to: Address
  amount: bigint
  asset?: Asset
  memo?: string
  representative?: Address
}

/**
 * The account-level API: build, sign, prove and submit blocks for one wallet.
 *
 * Every write reads the account's current frontier and balance first, because a
 * block commits to both — its `previous` and the balance AFTER it. Writes from
 * one instance are queued so they cannot race each other; two separate `Xe`
 * instances for the same wallet are not coordinated, so use one per wallet.
 */
export class Xe {
  readonly client: XeClient
  readonly wallet: Wallet
  readonly #networkIdOverride: string | undefined
  readonly #onProgress: ((attempts: number) => void) | undefined
  readonly #timekeeperCandidates: (XeClient | string)[]
  #timekeepers: { set: TimekeeperSet; nodes: Timekeeper[] } | undefined
  /**
   * Writes run one at a time, from the frontier read to the node's answer. Two
   * built at once name the same `previous` and fork the wallet's own chain: the
   * node keeps one and drops the other, though both were "accepted".
   */
  #writes: Promise<unknown> = Promise.resolve()

  constructor(options: XeOptions) {
    this.client =
      options.client instanceof XeClient ? options.client : new XeClient(options.client)
    this.wallet = options.wallet
    this.#networkIdOverride = options.networkId
    this.#onProgress = options.onProgress
    this.#timekeeperCandidates = options.timekeepers ?? [this.client]
  }

  get address(): Address {
    return this.wallet.address
  }

  async networkId(): Promise<string> {
    return this.#networkIdOverride ?? (await this.client.networkId())
  }

  async balance(asset: Asset = 'XE'): Promise<bigint> {
    const b = await this.client.balances(this.address)
    return b.balances[asset] ?? 0n
  }

  /**
   * Spendable counts only finalized inflows, so it trails the raw balance
   * briefly after a receive. Spend against this, not `balance`, if you want to
   * avoid a rejection you would otherwise have to retry.
   */
  async spendable(asset: Asset = 'XE'): Promise<bigint> {
    const b = await this.client.balances(this.address)
    return b.spendable[asset] ?? 0n
  }

  async pending(): Promise<PendingSend[]> {
    return this.client.pending(this.address)
  }

  async send(options: SendOptions): Promise<SubmitResult> {
    const asset = options.asset ?? 'XE'
    if (options.amount <= 0n) throw new XeUsageError('send: amount must be positive')
    if (options.to === this.address) throw new XeUsageError('send: cannot send to your own address')

    return this.#serial(async () => {
      const [balances, previous] = await Promise.all([
        this.client.balances(this.address),
        this.client.frontier(this.address),
      ])
      const current = balances.balances[asset] ?? 0n
      if (current < options.amount) {
        throw new XeInsufficientFundsError(asset, current, options.amount)
      }

      const block: Block = {
        type: 'send',
        account: this.address,
        previous,
        balance: current - options.amount,
        timestamp: nowNs(),
        asset,
        destination: options.to,
        amount: options.amount,
        ...(options.memo === undefined ? {} : { memo: options.memo }),
        ...(options.representative === undefined ? {} : { representative: options.representative }),
      }
      return this.#finish(block)
    })
  }

  /**
   * Claim one pending send.
   *
   * Nothing lands in an account without a block signed by its owner — an
   * incoming transfer sits as pending until this is called. A wallet showing a
   * zero balance after someone "sent it money" has almost always just not
   * received yet.
   */
  async receive(pending: PendingSend): Promise<SubmitResult> {
    return this.#serial(async () => {
      const [balances, previous] = await Promise.all([
        this.client.balances(this.address),
        this.client.frontier(this.address),
      ])
      const current = balances.balances[pending.asset] ?? 0n

      const block: Block = {
        type: 'receive',
        account: this.address,
        previous,
        balance: current + pending.amount,
        timestamp: nowNs(),
        asset: pending.asset,
        source: pending.hash,
      }
      return this.#finish(block)
    })
  }

  /** Claim every pending send, oldest first. Sequential: each commits to the previous frontier. */
  async receiveAll(): Promise<SubmitResult[]> {
    const results: SubmitResult[] = []
    for (const p of await this.pending()) {
      results.push(await this.receive(p))
    }
    return results
  }

  /** Permanently destroy XE. Irreversible, and XE-only — there is no re-mint. */
  async burn(amount: bigint, memo?: string): Promise<SubmitResult> {
    if (amount <= 0n) throw new XeUsageError('burn: amount must be positive')
    return this.#serial(async () => {
      const [balances, previous] = await Promise.all([
        this.client.balances(this.address),
        this.client.frontier(this.address),
      ])
      const current = balances.balances['XE'] ?? 0n
      if (current < amount) throw new XeInsufficientFundsError('XE', current, amount)

      const block: Block = {
        type: 'burn',
        account: this.address,
        previous,
        balance: current - amount,
        timestamp: nowNs(),
        asset: 'XE',
        amount,
        ...(memo === undefined ? {} : { memo }),
      }
      return this.#finish(block)
    })
  }

  // --- leases ---

  /**
   * Rent a machine: escrow XUSD for a lease against a provider's current
   * certificate. The provider's node decides whether to accept; nothing is
   * reserved until it does. Use `waitForLease` to see which way it went.
   */
  async openLease(options: OpenLeaseOptions): Promise<OpenedLease> {
    const dims = {
      vcpus: BigInt(options.vcpus),
      memoryMb: BigInt(options.memoryMb),
      diskGb: BigInt(options.diskGb),
    }
    const duration = BigInt(options.durationSecs)
    requireWholeMinutes(duration, 'openLease')
    const provider = options.provider ?? (await this.#cheapest(dims, options.maxPricePerMinute))
    if (provider === this.address) throw new XeUsageError('openLease: cannot lease from yourself')
    const certificate = await this.client.certificate(provider)
    if (certificate.expiresAt !== 0n && certificate.expiresAt <= nowNs()) {
      throw new XeUsageError(`openLease: provider certificate expired at ${certificate.expiresAt}`)
    }
    const price = pricePerMinute(dims, certificate.priceMultiplierMilli)
    if (options.maxPricePerMinute !== undefined && price > options.maxPricePerMinute) {
      throw new XePriceError(provider, price, options.maxPricePerMinute)
    }
    const cost = leaseCost(dims, duration, certificate.priceMultiplierMilli)
    const result = await this.#serial(async () => {
      const { current, previous } = await this.#position('XUSD', cost)

      const block: Block = {
        type: 'lease',
        account: this.address,
        previous,
        balance: current - cost,
        timestamp: nowNs(),
        asset: 'XUSD',
        destination: provider,
        amount: cost,
        vcpus: dims.vcpus,
        memoryMb: dims.memoryMb,
        diskGb: dims.diskGb,
        duration,
        certificateHash: certificate.hash,
        ...(options.accessPubKey ? { accessPubKey: options.accessPubKey } : {}),
      }
      return this.#finish(block)
    })
    return { ...result, cost, certificate }
  }

  /**
   * Open a lease and wait for the provider to accept it, retrying with a fresh
   * lease if it does not.
   *
   * A provider can leave a request unaccepted for good — it is full, or its own
   * accept attempt failed — and an unaccepted request holds your escrow until
   * you cancel it. So an unanswered request is cancelled (refunding the escrow)
   * and re-opened. If the provider accepts just as the cancel goes in, that
   * lease is used instead.
   */
  async rentLease(
    options: OpenLeaseOptions,
    retry: { acceptTimeoutMs?: number; attempts?: number } = {},
  ): Promise<{ lease: LeaseRecord; opened: OpenedLease; attempts: number }> {
    const attempts = retry.attempts ?? 3
    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const opened = await this.openLease(options)
      try {
        const lease = await this.waitForLease(opened.hash, ['accepted'], { timeoutMs: retry.acceptTimeoutMs ?? 60_000 })
        return { lease, opened, attempts: attempt }
      } catch (err) {
        lastError = err
        if (!(err instanceof XeApiError && err.retryable)) throw err
      }
      try {
        await this.cancelLease(opened.hash)
        await this.waitForLease(opened.hash, ['cancelled'], { timeoutMs: 30_000 })
      } catch (err) {
        const lease = await this.client.lease(opened.hash)
        if (lease.state === 'accepted') return { lease, opened, attempts: attempt }
        throw err
      }
    }
    throw lastError
  }

  async lease(hash: Hash): Promise<LeaseRecord> {
    return this.client.lease(hash)
  }

  /**
   * Every provider that can take this machine right now — a valid certificate
   * and the free capacity for it — with its price per minute, cheapest first.
   */
  async quote(machine: Machine): Promise<Quote[]> {
    const dims = { vcpus: BigInt(machine.vcpus), memoryMb: BigInt(machine.memoryMb), diskGb: BigInt(machine.diskGb) }
    const fits = (await this.client.providers()).filter(
      (p) =>
        p.account !== this.address &&
        p.vcpus - p.usedVcpus >= dims.vcpus &&
        p.memoryMb - p.usedMemoryMb >= dims.memoryMb &&
        p.diskGb - p.usedDiskGb >= dims.diskGb &&
        (p.maxConcurrentLeases === 0n || p.activeLeases < p.maxConcurrentLeases),
    )
    const quotes: Quote[] = []
    await Promise.all(
      fits.map(async (p) => {
        let certificate: Certificate
        try {
          certificate = await this.client.certificate(p.account)
        } catch {
          return // no current certificate: not leasable
        }
        if (certificate.expiresAt !== 0n && certificate.expiresAt <= nowNs()) return
        quotes.push({
          provider: p.account,
          pricePerMinute: pricePerMinute(dims, certificate.priceMultiplierMilli),
          certificate,
          certificateExpiresAt: certificate.expiresAt,
        })
      }),
    )
    return quotes.sort((a, b) => (a.pricePerMinute < b.pricePerMinute ? -1 : a.pricePerMinute > b.pricePerMinute ? 1 : 0))
  }

  /** The price per minute a lease was opened at — the ceiling its renewals keep by default. */
  async openingPricePerMinute(lease: LeaseRecord): Promise<bigint> {
    const certificate = await this.client.certificateByHash(lease.certificateHash)
    return pricePerMinute(lease, certificate.priceMultiplierMilli)
  }

  async #cheapest(dims: { vcpus: bigint; memoryMb: bigint; diskGb: bigint }, ceiling?: bigint): Promise<Address> {
    const quotes = await this.quote(dims)
    const [best] = quotes
    if (!best) throw new XeUsageError('no provider can take this machine right now (none has a valid certificate and the free capacity)')
    if (ceiling !== undefined && best.pricePerMinute > ceiling) throw new XePriceError(best.provider, best.pricePerMinute, ceiling)
    return best.provider
  }

  /**
   * Poll a lease until it reaches one of `states`. A lease that lands in a
   * terminal state you did not ask for fails fast rather than timing out.
   */
  async waitForLease(
    hash: Hash,
    states: LeaseState[],
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<LeaseRecord> {
    const deadline = Date.now() + (options.timeoutMs ?? 120_000)
    const terminal: LeaseState[] = ['settled', 'cancelled', 'unfulfilled', 'expired']
    let last: LeaseRecord | undefined
    for (;;) {
      try {
        last = await this.client.lease(hash)
        if (states.includes(last.state)) return last
        if (terminal.includes(last.state)) {
          throw new XeUsageError(`lease ${hash.slice(0, 12)} ended ${last.state} while waiting for ${states.join('|')}`)
        }
      } catch (err) {
        // Not yet known to this node — it has not synced the lease block.
        if (!(err instanceof XeApiError && err.status === 404)) throw err
      }
      if (Date.now() >= deadline) {
        throw new XeApiError(
          `lease ${hash.slice(0, 12)} still ${last?.state ?? 'unknown'} after timeout waiting for ${states.join('|')}`,
          503,
          true,
          last?.raw ?? null,
        )
      }
      await sleep(options.intervalMs ?? 1_000)
    }
  }

  /**
   * Extend an accepted lease in place by `durationSecs`.
   *
   * The extension is priced at the provider's CURRENT certificate, timed by a
   * threshold of timekeeper attestations, and locks the emission params of the
   * epoch in force at that attested time. The VM is not touched: its expiry
   * simply moves. Must land before the current expiry — a lease that has run
   * out cannot be revived.
   */
  async renewLease(leaseHash: Hash, durationSecs: bigint | number, guards: RenewGuards = {}): Promise<RenewedLease> {
    const duration = BigInt(durationSecs)
    requireWholeMinutes(duration, 'renewLease')
    const lease = await this.client.lease(leaseHash)
    if (lease.consumer !== this.address) throw new XeUsageError('renewLease: only the consumer can renew a lease')
    if (lease.state !== 'accepted' || lease.settled) {
      throw new XeUsageError(`renewLease: lease is ${lease.state}, only an accepted lease can be renewed`)
    }
    const certificate = await this.client.certificate(lease.provider)
    const cost = leaseCost(lease, duration, certificate.priceMultiplierMilli)
    const price = pricePerMinute(lease, certificate.priceMultiplierMilli)
    if (guards.maxPricePerMinute !== undefined && price > guards.maxPricePerMinute) {
      throw new XePriceError(lease.provider, price, guards.maxPricePerMinute)
    }
    if (guards.budget !== undefined) {
      const paid = leasePaid(lease)
      if (paid + cost > guards.budget) throw new XeBudgetError(paid, cost, guards.budget)
    }

    const attestations = await this.#attest(leaseHash)
    const renewTime = attestedTime(attestations)
    if (renewTime >= lease.effectiveExpiry) {
      throw new XeUsageError(`renewLease: lease expired at ${lease.effectiveExpiry} before the renewal was attested`)
    }
    if (certificate.expiresAt !== 0n && renewTime > certificate.expiresAt) {
      throw new XeUsageError('renewLease: the provider certificate has expired — the provider is not accepting renewals')
    }
    const epoch = await this.#epochAt(renewTime)
    const result = await this.#serial(async () => {
      const { current, previous } = await this.#position('XUSD', cost)

      const block: Block = {
        type: 'lease_renew',
        account: this.address,
        previous,
        balance: current - cost,
        timestamp: nowNs(),
        asset: 'XUSD',
        source: leaseHash,
        amount: cost,
        duration,
        certificateHash: certificate.hash,
        lockedR: epoch.rEffective,
        lockedPayoutCap: epoch.payoutCap,
        lockedTwap: epoch.twapMilliUsd,
        attestations,
      }
      return this.#finish(block)
    })
    return { ...result, lease: leaseHash, cost, durationSecs: duration, renewTime, epoch }
  }

  /** Withdraw a lease the provider has not accepted yet. Refunds the escrow. */
  async cancelLease(leaseHash: Hash): Promise<SubmitResult> {
    const lease = await this.client.lease(leaseHash)
    if (lease.consumer !== this.address) throw new XeUsageError('cancelLease: not your lease')
    if (lease.state !== 'created') {
      throw new XeUsageError(`cancelLease: lease is ${lease.state}; only an unaccepted lease can be cancelled`)
    }
    return this.#serial(async () => {
      const { current, previous } = await this.#position('XUSD', 0n)
      return this.#finish({
        type: 'lease_cancel',
        account: this.address,
        previous,
        balance: current + lease.cost,
        timestamp: nowNs(),
        asset: 'XUSD',
        source: leaseHash,
      })
    })
  }

  /**
   * Reclaim the whole escrow of an accepted lease the provider never settled.
   * Valid only once the attested time is past expiry + settle grace + the
   * force-settle gap; before that the node rejects it.
   */
  async forceSettleLease(leaseHash: Hash): Promise<SubmitResult> {
    const lease = await this.client.lease(leaseHash)
    if (lease.consumer !== this.address) throw new XeUsageError('forceSettleLease: not your lease')
    const escrow = lease.renewals.reduce((sum, r) => sum + r.cost, lease.cost)
    const attestations = await this.#attest(leaseHash)
    return this.#serial(async () => {
      const { current, previous } = await this.#position('XUSD', 0n)
      return this.#finish({
        type: 'lease_force_settle',
        account: this.address,
        previous,
        balance: current + escrow,
        timestamp: nowNs(),
        asset: 'XUSD',
        source: leaseHash,
        attestations,
      })
    })
  }

  async timekeepers(): Promise<{ set: TimekeeperSet; nodes: Timekeeper[] }> {
    if (!this.#timekeepers) {
      const set = await this.client.timekeepers()
      this.#timekeepers = { set, nodes: await discoverTimekeepers(set, this.#timekeeperCandidates) }
    }
    return this.#timekeepers
  }

  async #attest(leaseHash: Hash): Promise<Attestation[]> {
    const tk = await this.timekeepers()
    return gatherAttestations(leaseHash, tk.set, tk.nodes)
  }

  /**
   * The epoch the ledger will check a renewal's locked params against: the
   * newest one that had started by the attested time. Usually the latest; if
   * the oracle has just published one that starts later, step back.
   */
  async #epochAt(at: bigint): Promise<Epoch> {
    let epoch = await this.client.latestEpoch()
    for (let i = 0; i < 4 && epoch.startNs > at && epoch.epoch > 0n; i++) {
      const raw = (await this.client.statechainValue(`epoch.${epoch.epoch - 1n}`)) as Record<string, unknown>
      epoch = toEpoch((raw['value'] ?? raw) as Record<string, unknown>)
    }
    if (epoch.startNs > at) throw new XeApiError('no oracle epoch covers the attested time yet', 503, true, null)
    return epoch
  }

  /** The account's frontier and balance in one asset, checked against a spend. */
  async #position(asset: Asset, spend: bigint): Promise<{ current: bigint; previous: Hash | '0' }> {
    const [balances, previous] = await Promise.all([
      this.client.balances(this.address),
      this.client.frontier(this.address),
    ])
    if (previous === '0') throw new XeUsageError('account is not open yet — receive funds first')
    const current = balances.balances[asset] ?? 0n
    if (current < spend) throw new XeInsufficientFundsError(asset, current, spend)
    return { current, previous }
  }

  /**
   * Sign, prove and submit. Exposed for callers building a block by hand.
   * Queued behind this instance's other writes; another `Xe` for the same
   * wallet is not coordinated with it.
   */
  async submit(block: Block): Promise<SubmitResult> {
    return this.#serial(() => this.#finish(block))
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#writes.then(fn)
    this.#writes = run.catch(() => undefined)
    return run
  }

  async #finish(block: Block): Promise<SubmitResult> {
    const networkId = await this.networkId()
    const signed = signBlock(block, this.wallet, networkId)
    const nonce = await solvePow(hexToBytes(signed.hash, 32), {
      difficulty: DEFAULT_DIFFICULTY,
      ...(this.#onProgress ? { onProgress: this.#onProgress } : {}),
    })
    const complete: SignedBlock = { ...signed, powNonce: nonce }
    return this.client.submitBlock(complete)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export type { Hash }

/** micro-XUSD a lease has escrowed so far: its first term plus every renewal. */
export function leasePaid(lease: LeaseRecord): bigint {
  return lease.renewals.reduce((sum, r) => sum + r.cost, lease.cost)
}
