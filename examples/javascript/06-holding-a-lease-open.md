# 6. Holding a lease open

**You will:** keep a machine for as long as you need it, paying one minute at a
time, and stop cleanly.

**Time:** 15 minutes (most of it the lease running) · **Needs:** [5. Renting a machine](05-renting-a-machine.md) · **Costs:** about 0.005 XUSD for 10 minutes

## Pay for the time you use

A lease's term is fixed when it is opened, and its cost is escrowed up front.
To rent for "as long as I need", rent **one minute** and keep **renewing** it:

- nothing beyond the current minute is ever escrowed,
- if you stop — or your program dies — the machine is released within a minute,
- the most you can overpay is one minute.

A renewal extends the lease *in place*: same lease, same machine, a later expiry.
It is priced at the provider's current rate and timed by the network's
timekeepers, and it must land **before** the current expiry — a lease that has
run out cannot be revived.

## Tell the SDK where the timekeepers are

Renewals are timed by a threshold of **timekeepers**. The network lists their
keys but not their addresses, so give the SDK nodes to try; it keeps the ones
that turn out to be timekeepers:

```js
const xe = new Xe({
  client: 'https://ldn.core.test.network',
  wallet,
  timekeepers: [
    'https://ldn.core.test.network',
    'https://ffm.core.test.network',
    'https://nyc.core.test.network',
  ],
})
```

## Renew once

```js
const renewal = await xe.renewLease(leaseHash, 60)
console.log(`+${renewal.durationSecs}s for ${fromMicro(renewal.cost)} XUSD`)
```

## Hold it open

`holdLease` does the renewing for you: it renews each minute 30 seconds before
it runs out, retries temporary failures up to the expiry, and confirms every
extension on the ledger before scheduling the next.

```js
import { holdLease } from '@xeprotocol/sdk'

const result = await holdLease(xe, lease.hash, {
  renewSecs: 60,   // one billing minute per renewal
  totalSecs: 600,  // stop once the term reaches ten minutes; omit to hold until aborted
  onEvent: (e) => {
    if (e.type === 'renewed') console.log(`term now ${e.lease.effectiveDuration}s`)
    if (e.type === 'retry') console.log(`retrying: ${e.error.message}`)
  },
})
console.log(result.reason, `${result.renewals.length} renewals`)
```

## Stop cleanly

Pass an `AbortSignal`. Aborting stops the renewing — it does not cut the machine
off: the lease runs to the end of the minute you have already paid for, and the
provider settles it.

```js
const stop = new AbortController()
process.once('SIGINT', () => stop.abort())

await holdLease(xe, lease.hash, { renewSecs: 60, signal: stop.signal })
```

## Check what you paid

After the lease expires the provider settles it, spending exactly the escrowed
minutes:

```js
const settled = await xe.waitForLease(lease.hash, ['settled'], { timeoutMs: 5 * 60_000, intervalMs: 5_000 })
const paid = settled.renewals.reduce((sum, r) => sum + r.cost, settled.cost)
console.log(`${settled.effectiveDuration}s for ${fromMicro(paid)} XUSD`)
```

## The complete program

Rent a small machine and keep it for `MINUTES` minutes (default 3). Ctrl-C stops
renewing early.

```js title="hold-a-lease.mjs"
import { readFileSync } from 'node:fs'
import { Wallet, Xe, fromMicro, holdLease } from '@xeprotocol/sdk'

const MINUTES = BigInt(process.env['MINUTES'] ?? 3)
const xe = new Xe({
  client: 'https://ldn.core.test.network',
  wallet: Wallet.fromSeedHex(readFileSync('wallet.seed', 'utf8').trim()),
  timekeepers: ['https://ldn.core.test.network', 'https://ffm.core.test.network', 'https://nyc.core.test.network'],
})

async function leasableProvider() {
  for (const p of await xe.client.providers()) {
    try {
      const cert = await xe.client.certificate(p.account)
      if (cert.expiresAt === 0n || cert.expiresAt > BigInt(Date.now()) * 1_000_000n) return p.account
    } catch {
      // no certificate
    }
  }
  throw new Error('no provider can be leased right now')
}

const { lease } = await xe.rentLease({
  provider: await leasableProvider(),
  vcpus: 1,
  memoryMb: 1024,
  diskGb: 1,
  durationSecs: 60,
  accessPubKey: Wallet.create().publicKey,
})
console.log(`lease ${lease.hash} accepted`)

const stop = new AbortController()
process.once('SIGINT', () => {
  console.log('stopping: the lease runs out at the end of the current minute')
  stop.abort()
})

const result = await holdLease(xe, lease.hash, {
  renewSecs: 60,
  totalSecs: MINUTES * 60n,
  signal: stop.signal,
  onEvent: (e) => {
    if (e.type === 'renewed') {
      console.log(`renewed: term ${e.lease.effectiveDuration}s, until ${new Date(Number(e.lease.effectiveExpiry / 1_000_000n)).toISOString()}`)
    }
  },
})
console.log(`${result.reason} after ${result.renewals.length} renewal(s); waiting for the provider to settle…`)

const settled = await xe.waitForLease(lease.hash, ['settled'], { timeoutMs: 5 * 60_000, intervalMs: 5_000 })
const paid = settled.renewals.reduce((sum, r) => sum + r.cost, settled.cost)
console.log(`held ${settled.effectiveDuration}s for ${fromMicro(paid)} XUSD`)
```

```sh
MINUTES=10 node hold-a-lease.mjs
```

For a fuller version that checks every step and prints `PASS`/`FAIL` lines, see
[`hold-lease.mjs`](hold-lease.mjs).

**Back to:** [all examples](../README.md)
