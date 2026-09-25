import { describe, expect, it, vi } from 'vitest'

import type { SignedBlock } from '../../src/types.js'
import { toAddress, toHash } from '../../src/types.js'
import { Wallet } from '../../src/wallet.js'
import { Xe } from '../../src/xe.js'

/**
 * Every block on an account chain names the one before it. Two writes from one
 * wallet that run at once both read the same frontier, both name it, and fork
 * the wallet's own chain: the network keeps one and drops the other, though
 * each was answered "accepted". Seen live: two jobs started together, and one
 * lease "was not found".
 */
describe('one wallet, concurrent writes', () => {
  function fakeNode() {
    const xe = new Xe({ client: 'http://node.test', wallet: Wallet.create() })
    let head = toHash('f'.repeat(64))
    const submitted: SignedBlock[] = []
    vi.spyOn(xe, 'networkId').mockResolvedValue('test-net')
    vi.spyOn(xe.client, 'balances').mockImplementation(async () => ({ balances: { XE: 1_000n, XUSD: 1_000n } }) as never)
    vi.spyOn(xe.client, 'frontier').mockImplementation(async () => head)
    vi.spyOn(xe.client, 'submitBlock').mockImplementation(async (block: SignedBlock) => {
      await new Promise((r) => setTimeout(r, 20))
      submitted.push(block)
      head = block.hash // the node applies a block as it accepts it
      return { hash: block.hash, accepted: true }
    })
    return { xe, submitted }
  }

  it('chains them: each block builds on the one submitted before it', async () => {
    const { xe, submitted } = fakeNode()
    const to = toAddress('b'.repeat(64))
    await Promise.all([xe.send({ to, amount: 1n }), xe.send({ to, amount: 2n }), xe.burn(3n)])
    expect(submitted).toHaveLength(3)
    const previous = submitted.map((b) => b.previous)
    expect(new Set(previous).size).toBe(3) // no two blocks claim the same predecessor
    expect(previous[1]).toBe(submitted[0]!.hash)
    expect(previous[2]).toBe(submitted[1]!.hash)
  }, 60_000)

  it('keeps going after a write fails', async () => {
    const { xe, submitted } = fakeNode()
    const to = toAddress('b'.repeat(64))
    const results = await Promise.allSettled([xe.send({ to, amount: 1n }), xe.send({ to, amount: 10_000n }), xe.send({ to, amount: 2n })])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect(submitted[1]!.previous).toBe(submitted[0]!.hash)
  }, 60_000)
})
