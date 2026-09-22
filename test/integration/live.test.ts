import { beforeAll, describe, expect, it } from 'vitest'

import { XeClient } from '../../src/client.js'
import { Xe } from '../../src/xe.js'
import { Wallet } from '../../src/wallet.js'
import { fromMicro, toAddress, type Address } from '../../src/types.js'

/**
 * Integration tests against a real node.
 *
 * These skip — loudly, with a reason — when no node is reachable, so a
 * contributor with no network still gets a green `npm test`. Set XE_NODE to
 * point them somewhere else.
 */
const NODE = process.env['XE_NODE'] ?? 'https://ldn.core.test.network'
const FAUCET = process.env['XE_FAUCET'] ?? 'https://faucet.test.network'

const client = new XeClient({ url: NODE, timeoutMs: 15_000, retries: 2 })

let reachable = false
let skipReason = ''
try {
  await client.nodeInfo()
  reachable = true
} catch (err) {
  skipReason = `no node at ${NODE}: ${(err as Error).message}`
}

if (!reachable) {
  console.warn(`\n  [integration] SKIPPED — ${skipReason}\n`)
}

/** Ask the faucet to fund an address. Returns false if it declined. */
async function fund(address: Address): Promise<boolean> {
  const res = await fetch(`${FAUCET}/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address }),
  })
  return res.ok
}

describe.skipIf(!reachable)('live node', () => {
  it('reports a network id', async () => {
    const id = await client.networkId()
    expect(id).toBeTruthy()
    console.log(`  network: ${id}`)
  })

  it('reports supply', async () => {
    expect(await client.supply()).toBeTypeOf('object')
  })

  it('lists providers (may legitimately be empty)', async () => {
    const providers = await client.providers()
    expect(Array.isArray(providers)).toBe(true)
    console.log(`  providers online: ${providers.length}`)
  })

  it('reads the statechain tip', async () => {
    expect(await client.statechainTip()).toBeTypeOf('object')
  })

  it('returns an empty chain and a "0" frontier for an unused account', async () => {
    const fresh = Wallet.create()
    expect(await client.chain(fresh.address)).toEqual([])
    expect(await client.frontier(fresh.address)).toBe('0')
  })

  it('throws, rather than returning empty, for a malformed address', async () => {
    await expect(client.balances(toAddress('f'.repeat(64)))).resolves.toBeTruthy()
    await expect(client.block('0'.repeat(64) as never)).rejects.toThrow()
  })
})

describe.skipIf(!reachable)('value moves end to end', () => {
  const alice = Wallet.create()
  const bob = Wallet.create()
  let funded = false

  beforeAll(async () => {
    funded = await fund(alice.address)
    if (!funded) {
      console.warn('  [integration] faucet declined — transfer tests will skip')
    }
  }, 60_000)

  it('funds a fresh wallet, which arrives as PENDING not as balance', async () => {
    if (!funded) return
    const pending = await client.pending(alice.address)
    expect(pending.length).toBeGreaterThan(0)
    // Nothing lands without a block signed by the owner: the balance is still
    // zero until the receive is submitted.
    const balances = await client.balances(alice.address)
    expect(balances.balances['XE'] ?? 0n).toBe(0n)
  })

  it('claims the grant, opens the chain, and credits the balance', async () => {
    if (!funded) return
    const xe = new Xe({ client, wallet: alice })
    const results = await xe.receiveAll()
    expect(results.length).toBeGreaterThan(0)

    const balance = await xe.balance('XE')
    expect(balance).toBeGreaterThan(0n)
    console.log(`  alice funded: ${fromMicro(balance)} XE`)

    // The opening block must declare the public key; nothing after it may.
    const chain = (await client.chain(alice.address)) as Array<Record<string, unknown>>
    expect(chain[0]?.['pub_key']).toBe(alice.publicKey)
  }, 120_000)

  it('sends to a second wallet, and the node agrees on the block hash', async () => {
    if (!funded) return
    const xe = new Xe({ client, wallet: alice })
    const before = await xe.balance('XE')
    const amount = 1_000_000n // 1 XE

    const result = await xe.send({ to: bob.address, amount, memo: 'sdk integration' })
    expect(result.accepted).toBe(true)

    // The hash we computed locally is the hash the node stored.
    const block = await client.block(result.hash)
    expect(block['hash']).toBe(result.hash)
    expect(block['memo']).toBe('sdk integration')

    expect(await xe.balance('XE')).toBe(before - amount)
  }, 120_000)

  it('is received by the second wallet', async () => {
    if (!funded) return
    const bobXe = new Xe({ client, wallet: bob })
    expect((await bobXe.pending()).length).toBeGreaterThan(0)
    await bobXe.receiveAll()
    expect(await bobXe.balance('XE')).toBe(1_000_000n)
  }, 120_000)

  it('burns XE and reduces the balance', async () => {
    if (!funded) return
    const bobXe = new Xe({ client, wallet: bob })
    const before = await bobXe.balance('XE')
    await bobXe.burn(100_000n, 'sdk burn')
    expect(await bobXe.balance('XE')).toBe(before - 100_000n)
  }, 120_000)

  it('refuses to overspend, before touching the network', async () => {
    const broke = new Xe({ client, wallet: Wallet.create() })
    await expect(broke.send({ to: bob.address, amount: 1n })).rejects.toThrow(/insufficient XE/)
  })
})
