import { XeClient, type ClientOptions, type PendingSend, type SubmitResult } from './client.js'
import { XeInsufficientFundsError, XeUsageError } from './errors.js'
import { signBlock } from './hash.js'
import { DEFAULT_DIFFICULTY, solvePow } from './pow.js'
import { hexToBytes } from './hex.js'
import type { Address, Asset, Block, Hash, SignedBlock } from './types.js'
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
 * block commits to both — its `previous` and the balance AFTER it. That makes
 * concurrent writes from the same wallet a race the node will reject, so use
 * one instance per wallet and await each operation.
 */
export class Xe {
  readonly client: XeClient
  readonly wallet: Wallet
  readonly #networkIdOverride: string | undefined
  readonly #onProgress: ((attempts: number) => void) | undefined

  constructor(options: XeOptions) {
    this.client =
      options.client instanceof XeClient ? options.client : new XeClient(options.client)
    this.wallet = options.wallet
    this.#networkIdOverride = options.networkId
    this.#onProgress = options.onProgress
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
  }

  /** Sign, prove and submit. Exposed for callers building a block by hand. */
  async submit(block: Block): Promise<SubmitResult> {
    return this.#finish(block)
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

export type { Hash }
