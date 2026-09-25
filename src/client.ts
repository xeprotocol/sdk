import { XeApiError, XeTransportError, isRetryable } from './errors.js'
import { asBigInt, parseLossless, stringifyWithBigInts } from './json.js'
import type { Address, Asset, Attestation, Hash, PublicKey, SignedBlock } from './types.js'

export interface ClientOptions {
  /** Node API base URL, e.g. https://ldn.core.test.network */
  url: string
  /** Per-request timeout in milliseconds. Default 30s. */
  timeoutMs?: number
  /** Retry attempts for RETRYABLE failures only. Default 3. */
  retries?: number
  /** Base backoff in milliseconds; doubles each attempt. Default 250. */
  backoffMs?: number
  /** Injectable for tests and for runtimes with a non-global fetch. */
  fetch?: typeof globalThis.fetch
}

export interface Balances {
  address: Address
  /** Per-asset totals, micro-units. */
  balances: Record<string, bigint>
  /** Spendable counts only FINALIZED inflows, so it can trail `balances`. */
  spendable: Record<string, bigint>
  finalHeight: bigint
}

export interface PendingSend {
  hash: Hash
  source: Address
  destination: Address
  amount: bigint
  asset: Asset
}

export interface SubmitResult {
  hash: Hash
  accepted: true
}

/** A provider's advertised capacity, as gossiped across the network. */
export interface Provider {
  account: Address
  vcpus: bigint
  memoryMb: bigint
  diskGb: bigint
  maxConcurrentLeases: bigint
  usedVcpus: bigint
  usedMemoryMb: bigint
  usedDiskGb: bigint
  activeLeases: bigint
  raw: Record<string, unknown>
}

/** A provider's performance certificate: what a lease is priced against. */
export interface Certificate {
  hash: Hash
  provider: Address
  /** Price multiplier ×1000 (1000 = 1.0×). */
  priceMultiplierMilli: bigint
  /** Unix nanoseconds; 0 means no expiry. */
  expiresAt: bigint
  raw: Record<string, unknown>
}

export interface TimekeeperSet {
  keys: PublicKey[]
  threshold: number
}

/** The emission params a renewal must lock: one oracle epoch. */
export interface Epoch {
  epoch: bigint
  startNs: bigint
  endNs: bigint
  /** R_effective ×1000 — what the block calls locked_r. */
  rEffective: bigint
  payoutCap: bigint
  twapMilliUsd: bigint
}

export type LeaseState = 'created' | 'accepted' | 'settled' | 'cancelled' | 'unfulfilled' | 'expired'

export interface LeaseSegment {
  renewHash: Hash
  duration: bigint
  cost: bigint
  startTime: bigint
}

/** The ledger's record of a lease, as any node serves it. */
export interface LeaseRecord {
  hash: Hash
  state: LeaseState
  consumer: Address
  provider: Address
  vcpus: bigint
  memoryMb: bigint
  diskGb: bigint
  /** Base term, seconds. */
  duration: bigint
  cost: bigint
  /** Attested accept time, unix ns. 0 until accepted. */
  startTime: bigint
  settled: boolean
  certificateHash: string
  renewals: LeaseSegment[]
  /** Base + every renewal, seconds. */
  effectiveDuration: bigint
  /** startTime + effectiveDuration, unix ns. Meaningless until accepted. */
  effectiveExpiry: bigint
  raw: Record<string, unknown>
}

/**
 * A node's HTTP API.
 *
 * Two behaviours are deliberate and worth stating, because the Go client gets
 * them wrong and an SDK that copied it would inherit the bugs:
 *
 * 1. A non-2xx response THROWS. It never decodes into an empty success, so an
 *    empty list from this client always means the account genuinely has
 *    nothing — not that the request failed.
 * 2. uint64 fields are parsed losslessly into bigint. Going through Number
 *    would round a nanosecond timestamp and corrupt a balance.
 *
 * There is no global state: two clients pointed at two nodes do not interfere.
 */
export class XeClient {
  readonly url: string
  readonly #timeoutMs: number
  readonly #retries: number
  readonly #backoffMs: number
  readonly #fetch: typeof globalThis.fetch
  #networkId: string | undefined

  constructor(options: ClientOptions | string) {
    const opts = typeof options === 'string' ? { url: options } : options
    this.url = opts.url.replace(/\/+$/, '')
    this.#timeoutMs = opts.timeoutMs ?? 30_000
    this.#retries = opts.retries ?? 3
    this.#backoffMs = opts.backoffMs ?? 250
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async request<T = unknown>(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.#retries; attempt++) {
      try {
        return await this.#once<T>(path, init)
      } catch (err) {
        lastError = err
        // Retrying a terminal failure just burns time: a bad signature is
        // still bad on the third attempt.
        if (!isRetryable(err) || attempt === this.#retries) throw err
        await new Promise((r) => setTimeout(r, this.#backoffMs * 2 ** attempt))
      }
    }
    throw lastError
  }

  async #once<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${this.#timeoutMs}ms`)), this.#timeoutMs)
    let res: Response
    try {
      res = await this.#fetch(`${this.url}${path}`, {
        method: init?.method ?? 'GET',
        signal: controller.signal,
        ...(init?.body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: stringifyWithBigInts(init.body) }),
      })
    } catch (err) {
      throw new XeTransportError(`${init?.method ?? 'GET'} ${path}: ${(err as Error).message}`, { cause: err })
    } finally {
      clearTimeout(timer)
    }

    const text = await res.text()
    let body: unknown
    try {
      body = text ? parseLossless(text) : null
    } catch {
      // A body we cannot parse is still a failure worth surfacing verbatim
      // rather than swallowing into an empty result.
      if (!res.ok) throw new XeApiError(`HTTP ${res.status}: ${text.slice(0, 200)}`, res.status, res.status >= 500, text)
      throw new XeApiError(`HTTP ${res.status}: response was not JSON`, res.status, false, text)
    }

    if (!res.ok) {
      const rec = (body ?? {}) as Record<string, unknown>
      const message = typeof rec['error'] === 'string' ? rec['error'] : `HTTP ${res.status}`
      // The node classifies block-submission failures itself; trust that flag
      // when present and fall back to the status class when it is not.
      const retryable = typeof rec['retryable'] === 'boolean' ? rec['retryable'] : res.status >= 500
      throw new XeApiError(message, res.status, retryable, body)
    }
    return body as T
  }

  // --- reads ---

  async nodeInfo(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('/node')
  }

  /** The network id, cached: it is fixed for the life of a node. */
  async networkId(): Promise<string> {
    if (this.#networkId !== undefined) return this.#networkId
    const info = await this.nodeInfo()
    const id = info['network'] ?? info['network_id']
    if (typeof id !== 'string' || !id) throw new XeApiError('node did not report a network id', 200, false, info)
    this.#networkId = id
    return id
  }

  async balances(address: Address): Promise<Balances> {
    const raw = await this.request<Record<string, unknown>>(`/accounts/${address}/balance`)
    const toMap = (v: unknown): Record<string, bigint> => {
      const out: Record<string, bigint> = {}
      for (const [k, val] of Object.entries((v ?? {}) as Record<string, unknown>)) {
        out[k] = asBigInt(val, `balance.${k}`)
      }
      return out
    }
    return {
      address,
      balances: toMap(raw['balances']),
      spendable: toMap(raw['spendable']),
      finalHeight: raw['final_height'] === undefined ? 0n : asBigInt(raw['final_height'], 'final_height'),
    }
  }

  async chain(address: Address, params?: { limit?: number; offset?: number }): Promise<unknown[]> {
    const q = new URLSearchParams()
    if (params?.limit !== undefined) q.set('limit', String(params.limit))
    if (params?.offset !== undefined) q.set('offset', String(params.offset))
    const suffix = q.size ? `?${q.toString()}` : ''
    const raw = await this.request<unknown>(`/accounts/${address}/chain${suffix}`)
    return unwrapList(raw, 'blocks')
  }

  /**
   * Frontier hash for an account, or `"0"` when the chain is empty.
   *
   * The chain endpoint pages from the OLDEST block, 100 at a time, so the last
   * entry of an unparameterised read is the frontier only for short chains.
   * Read the total first, then fetch exactly the last block.
   */
  async frontier(address: Address): Promise<Hash | '0'> {
    const head = await this.request<Record<string, unknown>>(`/accounts/${address}/chain?limit=1`)
    const total = Number(head['total'] ?? 0)
    if (!Number.isSafeInteger(total) || total < 0) {
      throw new XeApiError('chain response had no usable total', 200, false, head)
    }
    if (total === 0) return '0'
    const blocks = await this.chain(address, { offset: total - 1, limit: 1 })
    if (blocks.length === 0) throw new XeApiError('chain shrank while reading the frontier', 503, true, head)
    const last = blocks[blocks.length - 1] as Record<string, unknown>
    const hash = last['hash']
    if (typeof hash !== 'string') throw new XeApiError('chain entry had no hash', 200, false, last)
    return hash as Hash
  }

  async pending(address: Address): Promise<PendingSend[]> {
    const raw = await this.request<unknown>(`/pending/${address}`)
    return unwrapList(raw, 'pending').map((entry) => {
      const p = entry as Record<string, unknown>
      // Pending entries are serialised from Go's struct field names
      // (`SendHash`, `Amount`), unlike block JSON which is snake_case. Accept
      // either rather than depending on which one a node happens to emit.
      const pick = (...keys: string[]): unknown => {
        for (const k of keys) if (p[k] !== undefined) return p[k]
        return undefined
      }
      return {
        hash: pick('SendHash', 'send_hash', 'hash') as Hash,
        source: pick('Source', 'source') as Address,
        destination: pick('Destination', 'destination') as Address,
        amount: asBigInt(pick('Amount', 'amount'), 'pending.amount'),
        asset: (pick('Asset', 'asset') ?? 'XE') as Asset,
      }
    })
  }

  async block(hash: Hash): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/blocks/${hash}`)
  }

  async supply(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('/supply')
  }

  /** Providers currently advertising capacity. Lease one with a current certificate. */
  async providers(): Promise<Provider[]> {
    return unwrapList(await this.request<unknown>('/providers'), 'providers').map((p) =>
      toProvider(p as Record<string, unknown>),
    )
  }

  async leases(state?: string): Promise<unknown[]> {
    const suffix = state ? `?state=${encodeURIComponent(state)}` : ''
    return unwrapList(await this.request<unknown>(`/leases${suffix}`), 'leases')
  }

  async lease(hash: Hash): Promise<LeaseRecord> {
    return toLeaseRecord(await this.request<Record<string, unknown>>(`/leases/${hash}`))
  }

  /** The provider's current certificate. 404 means the provider cannot be leased. */
  async certificate(provider: Address): Promise<Certificate> {
    return toCertificate(await this.request<Record<string, unknown>>(`/certificate/${provider}`))
  }

  /** A certificate by hash, including expired and superseded ones: what a lease was priced against. */
  async certificateByHash(hash: string): Promise<Certificate> {
    return toCertificate(await this.request<Record<string, unknown>>(`/certificate/hash/${hash}`))
  }

  async timekeepers(): Promise<TimekeeperSet> {
    const raw = (await this.statechainValue('sys.timekeepers')) as Record<string, unknown>
    const value = (raw['value'] ?? raw) as Record<string, unknown>
    const keys = value['keys']
    if (!Array.isArray(keys)) throw new XeApiError('sys.timekeepers has no keys', 200, false, raw)
    return { keys: keys as PublicKey[], threshold: Number(value['threshold']) }
  }

  async statechainBlock(index: bigint): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/statechain/blocks/${index}`)
  }

  /**
   * The most recently published oracle epoch.
   *
   * Epochs are state-chain `epoch.N` writes, and the oracle is almost always
   * the most recent writer, so walk back from the tip rather than list the KV
   * space (which pages lexicographically — epoch.1000 sorts before epoch.999).
   */
  async latestEpoch(maxWalk = 64): Promise<Epoch> {
    let block = await this.statechainTip()
    for (let i = 0; i < maxWalk; i++) {
      const ops = Array.isArray(block['ops']) ? (block['ops'] as Record<string, unknown>[]) : []
      for (let j = ops.length - 1; j >= 0; j--) {
        const op = ops[j]!
        if (op['action'] === 'set' && typeof op['key'] === 'string' && op['key'].startsWith('epoch.')) {
          return toEpoch(op['value'] as Record<string, unknown>)
        }
      }
      const index = asBigInt(block['index'], 'statechain.index')
      if (index === 0n) break
      block = await this.statechainBlock(index - 1n)
    }
    throw new XeApiError(`no epoch in the last ${maxWalk} state-chain blocks — is the oracle publishing?`, 503, true, null)
  }

  /**
   * Ask THIS node to attest the current time for a lease. Only useful when the
   * node is a timekeeper; any other node's signature will not count.
   */
  async requestAttestation(leaseHash: Hash): Promise<Attestation> {
    const raw = await this.request<Record<string, unknown>>('/attestation/request', {
      method: 'POST',
      body: { lease_hash: leaseHash },
    })
    return {
      publicKey: raw['public_key'] as PublicKey,
      timestamp: asBigInt(raw['timestamp'], 'attestation.timestamp'),
      signature: raw['signature'] as string,
    }
  }

  async statechainTip(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('/statechain/tip')
  }

  async statechainValue(key: string): Promise<unknown> {
    return this.request<unknown>(`/statechain/kv/${key}`)
  }

  // --- writes ---

  async submitBlock(block: SignedBlock): Promise<SubmitResult> {
    await this.request(`/blocks/${block.type}`, { method: 'POST', body: toWire(block) })
    return { hash: block.hash, accepted: true }
  }
}

/** Endpoints return either a bare array or `{ <key>: [...] }`; accept both. */
function unwrapList(raw: unknown, key: string): unknown[] {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') {
    const inner = (raw as Record<string, unknown>)[key]
    if (Array.isArray(inner)) return inner
  }
  if (raw === null) return []
  throw new XeApiError(`expected a list of ${key}`, 200, false, raw)
}

/** Map the SDK's camelCase block onto the node's snake_case wire form. */
export function toWire(block: SignedBlock): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    type: block.type,
    account: block.account,
    previous: block.previous,
    balance: block.balance,
    timestamp: block.timestamp,
    asset: block.asset,
    hash: block.hash,
    signature: block.signature,
    pow_nonce: block.powNonce,
  }
  if (block.representative) wire['representative'] = block.representative
  if (block.destination) wire['destination'] = block.destination
  if (block.amount !== undefined) wire['amount'] = block.amount
  if (block.source) wire['source'] = block.source
  if (block.memo) wire['memo'] = block.memo
  if (block.pubKey) wire['pub_key'] = block.pubKey
  // The node's JSON omits zero values, and a zero decodes the same as a
  // missing field, so only non-zero lease fields are written.
  const u64s = [
    ['vcpus', block.vcpus],
    ['memory_mb', block.memoryMb],
    ['disk_gb', block.diskGb],
    ['duration', block.duration],
    ['locked_r', block.lockedR],
    ['locked_payout_cap', block.lockedPayoutCap],
    ['locked_twap_milli', block.lockedTwap],
  ] as const
  for (const [key, value] of u64s) if (value) wire[key] = value
  if (block.accessPubKey) wire['access_pub_key'] = block.accessPubKey
  if (block.certificateHash) wire['certificate_hash'] = block.certificateHash
  if (block.attestations?.length) {
    wire['attestations'] = block.attestations.map((a) => ({
      public_key: a.publicKey,
      timestamp: a.timestamp,
      signature: a.signature,
    }))
  }
  return wire
}

const big = (rec: Record<string, unknown>, key: string): bigint =>
  rec[key] === undefined || rec[key] === null ? 0n : asBigInt(rec[key], key)

export function toProvider(raw: Record<string, unknown>): Provider {
  return {
    account: raw['account'] as Address,
    vcpus: big(raw, 'vcpus'),
    memoryMb: big(raw, 'memory_mb'),
    diskGb: big(raw, 'disk_gb'),
    maxConcurrentLeases: big(raw, 'max_concurrent_leases'),
    usedVcpus: big(raw, 'used_vcpus'),
    usedMemoryMb: big(raw, 'used_memory_mb'),
    usedDiskGb: big(raw, 'used_disk_gb'),
    activeLeases: big(raw, 'active_leases'),
    raw,
  }
}

export function toCertificate(raw: Record<string, unknown>): Certificate {
  return {
    hash: raw['hash'] as Hash,
    provider: raw['provider'] as Address,
    priceMultiplierMilli: big(raw, 'price_multiplier_milli'),
    expiresAt: big(raw, 'expires_at'),
    raw,
  }
}

export function toEpoch(raw: Record<string, unknown>): Epoch {
  return {
    epoch: big(raw, 'epoch'),
    startNs: big(raw, 'start_ns'),
    endNs: big(raw, 'end_ns'),
    rEffective: big(raw, 'r_effective'),
    payoutCap: big(raw, 'payout_cap'),
    twapMilliUsd: big(raw, 'twap_milli_usd'),
  }
}

export function toLeaseRecord(raw: Record<string, unknown>): LeaseRecord {
  const renewals = (Array.isArray(raw['renewals']) ? (raw['renewals'] as Record<string, unknown>[]) : []).map(
    (r) => ({
      renewHash: r['renew_hash'] as Hash,
      duration: big(r, 'duration'),
      cost: big(r, 'cost'),
      startTime: big(r, 'start_time'),
    }),
  )
  const duration = big(raw, 'duration')
  const effectiveDuration = renewals.reduce((sum, r) => sum + r.duration, duration)
  const startTime = big(raw, 'start_time')
  return {
    hash: (raw['lease_hash'] ?? raw['hash']) as Hash,
    state: raw['state'] as LeaseState,
    consumer: raw['consumer'] as Address,
    provider: raw['provider'] as Address,
    vcpus: big(raw, 'vcpus'),
    memoryMb: big(raw, 'memory_mb'),
    diskGb: big(raw, 'disk_gb'),
    duration,
    cost: big(raw, 'cost'),
    startTime,
    settled: raw['settled'] === true,
    certificateHash: (raw['certificate_hash'] as string | undefined) ?? '',
    renewals,
    effectiveDuration,
    effectiveExpiry: startTime + effectiveDuration * 1_000_000_000n,
    raw,
  }
}
