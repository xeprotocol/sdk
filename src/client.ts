import { XeApiError, XeTransportError, isRetryable } from './errors.js'
import { asBigInt, parseLossless, stringifyWithBigInts } from './json.js'
import type { Address, Asset, Hash, SignedBlock } from './types.js'

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

  /** Frontier hash for an account, or `"0"` when the chain is empty. */
  async frontier(address: Address): Promise<Hash | '0'> {
    const blocks = await this.chain(address)
    if (blocks.length === 0) return '0'
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

  async providers(): Promise<unknown[]> {
    return unwrapList(await this.request<unknown>('/providers'), 'providers')
  }

  async leases(state?: string): Promise<unknown[]> {
    const suffix = state ? `?state=${encodeURIComponent(state)}` : ''
    return unwrapList(await this.request<unknown>(`/leases${suffix}`), 'leases')
  }

  async lease(hash: Hash): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/leases/${hash}`)
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
  return wire
}
