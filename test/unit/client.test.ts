import { describe, expect, it, vi } from 'vitest'

import { XeClient, toWire } from '../../src/client.js'
import { XeApiError, XeTransportError, isRetryable } from '../../src/errors.js'
import { toAddress, toHash, type SignedBlock } from '../../src/types.js'

const ADDR = toAddress('2ca26366310210ce3b26d472f37060826091ddd2259fecbea86b7e0d4e5c5496')

function stub(responses: Array<{ status: number; body: string }>): {
  fetch: typeof globalThis.fetch
  calls: string[]
} {
  const calls: string[] = []
  let i = 0
  const fetch = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url))
    const r = responses[Math.min(i++, responses.length - 1)]!
    return new Response(r.body, { status: r.status })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const client = (responses: Array<{ status: number; body: string }>, retries = 0) => {
  const { fetch, calls } = stub(responses)
  return { c: new XeClient({ url: 'http://node.test', fetch, retries, backoffMs: 1 }), calls }
}

describe('XeClient', () => {
  it('strips a trailing slash from the base url', () => {
    expect(new XeClient({ url: 'http://node.test/' }).url).toBe('http://node.test')
  })

  describe('failures are never silent', () => {
    it('THROWS on a non-2xx instead of returning an empty result', async () => {
      // The Go client decodes an error body into an empty struct and returns
      // success. An SDK that copied it would report "no pending sends" for a
      // node that was actually down.
      const { c } = client([{ status: 500, body: '{"error":"boom"}' }])
      await expect(c.pending(ADDR)).rejects.toThrow(XeApiError)
    })

    it('surfaces the node error message', async () => {
      const { c } = client([{ status: 400, body: '{"error":"invalid signature"}' }])
      await expect(c.nodeInfo()).rejects.toThrow('invalid signature')
    })

    it('surfaces an unparseable body rather than swallowing it', async () => {
      const { c } = client([{ status: 502, body: '<html>bad gateway</html>' }])
      await expect(c.nodeInfo()).rejects.toThrow(/bad gateway/)
    })

    it('wraps a transport failure', async () => {
      const fetch = vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof globalThis.fetch
      const c = new XeClient({ url: 'http://node.test', fetch, retries: 0 })
      await expect(c.nodeInfo()).rejects.toThrow(XeTransportError)
    })
  })

  describe('retry policy', () => {
    it('retries a retryable failure and then succeeds', async () => {
      const { c, calls } = client(
        [
          { status: 503, body: '{"error":"not ready","retryable":true}' },
          { status: 200, body: '{"network":"testnet-0003"}' },
        ],
        3,
      )
      await expect(c.networkId()).resolves.toBe('testnet-0003')
      expect(calls.length).toBe(2)
    })

    it('does NOT retry a terminal failure', async () => {
      // A bad signature is still bad on the third attempt; retrying only
      // delays the error the caller needs to see.
      const { c, calls } = client([{ status: 400, body: '{"error":"bad block","retryable":false}' }], 3)
      await expect(c.nodeInfo()).rejects.toThrow('bad block')
      expect(calls.length).toBe(1)
    })

    it('gives up after the configured attempts', async () => {
      const { c, calls } = client([{ status: 503, body: '{"error":"busy","retryable":true}' }], 2)
      await expect(c.nodeInfo()).rejects.toThrow('busy')
      expect(calls.length).toBe(3) // initial + 2 retries
    })

    it('classifies a 5xx without a retryable flag as retryable', async () => {
      const { c } = client([{ status: 503, body: '{"error":"busy"}' }], 0)
      await expect(c.nodeInfo()).rejects.toSatisfy((e: unknown) => isRetryable(e))
    })
  })

  describe('integer precision', () => {
    it('preserves a uint64 balance beyond Number precision', async () => {
      const { c } = client([
        { status: 200, body: '{"balances":{"XE":18446744073709551615},"spendable":{"XE":1},"final_height":9007199254740993}' },
      ])
      const b = await c.balances(ADDR)
      expect(b.balances['XE']).toBe(18446744073709551615n)
      expect(b.finalHeight).toBe(9007199254740993n)
    })

    it('preserves a pending amount', async () => {
      const { c } = client([
        { status: 200, body: '[{"hash":"' + 'a'.repeat(64) + '","source":"' + 'b'.repeat(64) + '","destination":"' + 'c'.repeat(64) + '","amount":18446744073709551615,"asset":"XE"}]' },
      ])
      expect((await c.pending(ADDR))[0]!.amount).toBe(18446744073709551615n)
    })
  })

  describe('list unwrapping', () => {
    it('accepts a bare array', async () => {
      const { c } = client([{ status: 200, body: '[]' }])
      await expect(c.providers()).resolves.toEqual([])
    })

    it('accepts a wrapped array', async () => {
      const { c } = client([{ status: 200, body: '{"providers":[{"account":"a"}]}' }])
      const [p] = await c.providers()
      expect(p?.account).toBe('a')
    })

    it('types a provider advertisement, uint64s as bigint', async () => {
      const body =
        '[{"account":"' + 'f'.repeat(64) + '","vcpus":4,"memory_mb":8192,"disk_gb":50,' +
        '"max_concurrent_leases":5,"used_vcpus":1,"used_memory_mb":1024,"used_disk_gb":1,"active_leases":1}]'
      const { c } = client([{ status: 200, body }])
      const [p] = await c.providers()
      expect(p).toMatchObject({ vcpus: 4n, memoryMb: 8192n, diskGb: 50n, usedVcpus: 1n, activeLeases: 1n })
    })

    it('treats a null body as empty', async () => {
      const { c } = client([{ status: 200, body: 'null' }])
      await expect(c.providers()).resolves.toEqual([])
    })
  })

  describe('frontier', () => {
    it('is "0" for an account with no blocks', async () => {
      const { c } = client([{ status: 200, body: '{"address":"x","total":0,"blocks":[]}' }])
      await expect(c.frontier(ADDR)).resolves.toBe('0')
    })

    it('is the LAST block of a chain longer than one page', async () => {
      // The chain endpoint pages from the oldest block, 100 at a time. Taking
      // the last entry of an unparameterised read returned block 100 of a
      // 250-block chain — a stale previous every write would be rejected for.
      const h = 'd'.repeat(64)
      const { c, calls } = client([
        { status: 200, body: `{"address":"x","total":250,"blocks":[{"hash":"${'e'.repeat(64)}"}]}` },
        { status: 200, body: `{"address":"x","total":250,"blocks":[{"hash":"${h}"}]}` },
      ])
      await expect(c.frontier(ADDR)).resolves.toBe(h)
      expect(calls[1]).toContain('offset=249')
      expect(calls[1]).toContain('limit=1')
    })
  })

  it('caches the network id — it cannot change for a running node', async () => {
    const { c, calls } = client([{ status: 200, body: '{"network":"testnet-0003"}' }])
    await c.networkId()
    await c.networkId()
    expect(calls.length).toBe(1)
  })

  it('keeps two clients independent', async () => {
    const a = client([{ status: 200, body: '{"network":"net-a"}' }])
    const b = client([{ status: 200, body: '{"network":"net-b"}' }])
    await expect(a.c.networkId()).resolves.toBe('net-a')
    await expect(b.c.networkId()).resolves.toBe('net-b')
  })

  it('times out a hanging request', async () => {
    const fetch = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    ) as unknown as typeof globalThis.fetch
    const c = new XeClient({ url: 'http://node.test', fetch, retries: 0, timeoutMs: 10 })
    await expect(c.nodeInfo()).rejects.toThrow(XeTransportError)
  })
})

describe('toWire', () => {
  const base: SignedBlock = {
    type: 'send', account: ADDR, previous: '0', balance: 1n, timestamp: 2n, asset: 'XE',
    destination: ADDR, amount: 3n, hash: toHash('f'.repeat(64)), signature: 'ab', powNonce: 7n,
  }

  it('maps camelCase onto the node snake_case form', () => {
    const wire = toWire(base)
    expect(wire['pow_nonce']).toBe(7n)
    expect(wire).not.toHaveProperty('powNonce')
  })

  it('omits absent optional fields rather than sending nulls', () => {
    const wire = toWire(base)
    expect(wire).not.toHaveProperty('memo')
    expect(wire).not.toHaveProperty('source')
    expect(wire).not.toHaveProperty('representative')
  })

  it('includes pub_key when the block declares one', () => {
    expect(toWire({ ...base, pubKey: 'a'.repeat(64) as never })['pub_key']).toBe('a'.repeat(64))
  })
})

describe('remaining read endpoints', () => {
  const cases: Array<[string, (c: XeClient) => Promise<unknown>, string, unknown]> = [
    ['/node', (c) => c.nodeInfo(), '{"id":"n1"}', { id: 'n1' }],
    ['/supply', (c) => c.supply(), '{"XE":{"total":42}}', { XE: { total: 42n } }],
    ['/blocks/{hash}', (c) => c.block(toHash('a'.repeat(64))), '{"hash":"x"}', { hash: 'x' }],
    ['/leases', (c) => c.leases(), '{"leases":[{"h":1}]}', [{ h: 1 }]],
    ['/leases/{hash}', async (c) => (await c.lease(toHash('b'.repeat(64)))).state, '{"state":"settled"}', 'settled'],
    ['/statechain/tip', (c) => c.statechainTip(), '{"index":9}', { index: 9 }],
    ['/statechain/kv/{key}', (c) => c.statechainValue('sys.timekeepers'), '{"keys":[]}', { keys: [] }],
    ['/accounts/{a}/chain', (c) => c.chain(ADDR), '{"blocks":[{"i":1}]}', [{ i: 1 }]],
  ]

  for (const [name, call, body, expected] of cases) {
    it(`binds ${name}`, async () => {
      const { c } = client([{ status: 200, body }])
      await expect(call(c)).resolves.toEqual(expected)
    })

    it(`throws rather than returning empty when ${name} fails`, async () => {
      const { c } = client([{ status: 500, body: '{"error":"down"}' }])
      await expect(call(c)).rejects.toThrow(XeApiError)
    })
  }

  it('passes pagination through to the chain endpoint', async () => {
    const { c, calls } = client([{ status: 200, body: '{"blocks":[]}' }])
    await c.chain(ADDR, { limit: 5, offset: 10 })
    expect(calls[0]).toContain('limit=5')
    expect(calls[0]).toContain('offset=10')
  })

  it('filters leases by state', async () => {
    const { c, calls } = client([{ status: 200, body: '[]' }])
    await c.leases('accepted')
    expect(calls[0]).toContain('state=accepted')
  })
})
