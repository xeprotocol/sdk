# 2. Getting testnet funds

**You will:** ask the testnet faucet for XE, see it arrive as *pending*, claim it,
and learn why a fresh balance is not immediately spendable.

**Time:** 5 minutes · **Needs:** [1. Your first wallet](01-first-wallet.md) · **Costs:** nothing

## Ask the faucet

The testnet faucet sends **1,000 XE** to any address, once per rolling 24 hours.
It is a plain HTTP service, separate from the SDK:

```js
const res = await fetch('https://faucet.test.network/request', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ address: xe.address }),
})
if (!res.ok) throw new Error(`faucet declined: ${res.status} ${await res.text()}`)
```

## Funds arrive as pending

XE's ledger is a lattice: every account owns its own chain of blocks, and a
transfer is **two** blocks — a `send` on the sender's chain, then a `receive` on
yours. Until you write the receive, the transfer sits as *pending*:

```js
const pending = await xe.pending()
for (const p of pending) console.log(p.asset, fromMicro(p.amount), 'from', p.source)
```

Nothing lands in an account without a block signed by its owner — so a wallet
that shows zero after someone "sent it money" has almost always just not
received yet.

## Claim it

```js
await xe.receiveAll() // one receive block per pending send, oldest first
```

The very first receive **opens** your account: it is the block that declares
your public key on the ledger. The SDK handles that for you.

## Balance vs spendable

```js
await xe.balance('XE')   // everything you hold
await xe.spendable('XE') // only what has FINALIZED
```

A block is final once the network's representatives have voted on it — usually
within a second or two. Spending money that is not final yet is refused, so if
you are about to spend, check `spendable`.

## The complete program

```js title="get-funds.mjs"
import { readFileSync } from 'node:fs'
import { Wallet, Xe, fromMicro } from '@xeprotocol/sdk'

const NODE = process.env['XE_NODE'] ?? 'https://ldn.core.test.network'
const FAUCET = process.env['XE_FAUCET'] ?? 'https://faucet.test.network'

const wallet = Wallet.fromSeedHex(readFileSync('wallet.seed', 'utf8').trim())
const xe = new Xe({ client: NODE, wallet })

const res = await fetch(`${FAUCET}/request`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ address: xe.address }),
})
console.log(`faucet: HTTP ${res.status}`)

// Wait for the faucet's send to reach our node.
const deadline = Date.now() + 60_000
while ((await xe.pending()).length === 0) {
  if (Date.now() > deadline) throw new Error('nothing arrived — did the faucet decline?')
  await new Promise((r) => setTimeout(r, 1_000))
}

const received = await xe.receiveAll()
console.log(`claimed ${received.length} pending transfer(s)`)

// Wait until the funds are final, and therefore spendable.
while ((await xe.spendable('XE')) < (await xe.balance('XE'))) {
  await new Promise((r) => setTimeout(r, 1_000))
}
console.log(`XE balance ${fromMicro(await xe.balance('XE'))}, all spendable`)
```

```sh
node get-funds.mjs
```

## What about XUSD?

XE is the network's native coin. **Compute is paid in XUSD**, a USD-pegged
stablecoin issued only by the network's authorised minter. The testnet faucet
does not hand it out; see [5. Renting a machine](05-renting-a-machine.md).

**Next:** [3. Sending XE](03-sending-xe.md)
