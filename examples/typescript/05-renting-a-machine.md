# 5. Renting a machine

**You will:** find a provider, price a machine exactly as the network will, rent
it, and read the lease back.

**Time:** 10 minutes · **Needs:** a wallet holding **XUSD** · **Costs:** fractions of a cent of testnet XUSD

## How renting works

A **lease** rents a virtual machine from a **provider** for a fixed term:

1. You post a `lease` block. It escrows the full cost in XUSD and names the
   provider, the machine's size, the term, and the SSH key the machine should
   accept.
2. The provider's node decides whether to take it. Nothing is reserved until it
   **accepts** — a busy provider simply leaves the request alone.
3. On accept the provider boots the VM. The network's **timekeepers** attest the
   start time, so the clock is never the provider's or yours.
4. When the term ends the provider **settles**: your escrow is spent, and the
   provider earns newly minted XE.

Leases are priced in **XUSD**, never XE, so the price of compute does not move
with XE's market price.

> **Getting testnet XUSD.** XUSD is issued only by the network's authorised
> minter, and the testnet faucet hands out XE, not XUSD. There is no self-serve
> XUSD on the testnet yet — ask the network operators for some for your address.
> A few cents lasts a long time: a small machine costs about 0.0005 XUSD a minute.

## Find a provider

```ts
const providers = await xe.client.providers()
for (const p of providers) {
  console.log(p.account, `${p.vcpus} vCPU, ${p.memoryMb} MB, ${p.diskGb} GB, ${p.activeLeases} active`)
}
```

A provider can only be leased while it holds a current **performance
certificate** — a benchmark, attested by the timekeepers, that also carries its
price multiplier:

```ts
const cert = await xe.client.certificate(provider) // throws a 404 XeApiError if it has none
console.log(`${Number(cert.priceMultiplierMilli) / 1000}× base price, valid until`,
  new Date(Number(cert.expiresAt / 1_000_000n)))
```

## Price it

The price is fixed by the protocol: a per-hour rate for each vCPU, GiB of memory
and GB of disk, billed in **whole minutes**, times the provider's multiplier.
`leaseCost` computes it to the micro-unit, exactly as the ledger will:

```ts
import { fromMicro, leaseCost } from '@xeprotocol/sdk'

const perMinute = leaseCost({ vcpus: 1n, memoryMb: 1024n, diskGb: 1n }, 60n, cert.priceMultiplierMilli)
console.log(`${fromMicro(perMinute)} XUSD per minute`)
```

## Rent it

`rentLease` opens the lease and waits for the provider to accept:

```ts
const sshKey = Wallet.create() // the machine will accept this key for SSH

const { lease, opened } = await xe.rentLease({
  provider,
  vcpus: 1,
  memoryMb: 1024,
  diskGb: 1,
  durationSecs: 60,
  accessPubKey: sshKey.publicKey,
})
console.log(`lease ${opened.hash} accepted, runs until`, new Date(Number(lease.effectiveExpiry / 1_000_000n)))
```

If the provider does not answer within a minute — it is full, or busy — the
request is **cancelled, refunding the escrow**, and a fresh one is opened, up to
three times. Tune it with a second argument:
`xe.rentLease(options, { acceptTimeoutMs: 90_000, attempts: 5 })`.

The lower-level pieces are there if you want them: `openLease` posts the request,
`waitForLease` polls until it reaches a state, and `cancelLease` withdraws a
request the provider has not accepted.

## Read the lease

Any node serves the ledger's record of a lease:

```ts
const record = await xe.lease(opened.hash)
record.state             // 'created' → 'accepted' → 'settled' (or 'cancelled', 'unfulfilled', 'expired')
record.startTime         // attested start, unix nanoseconds
record.effectiveExpiry   // start + the whole term, including any renewals
record.renewals.length   // see the next tutorial
```

If a provider accepts and then never settles, you get your money back with
`forceSettleLease` once the settle window has passed.

## The complete program

```ts title="rent-a-machine.ts"
import { readFileSync } from 'node:fs'
import { Wallet, Xe, fromMicro, leaseCost, type Address } from '@xeprotocol/sdk'

const NODE = process.env['XE_NODE'] ?? 'https://ldn.core.test.network'
const xe = new Xe({ client: NODE, wallet: Wallet.fromSeedHex(readFileSync('wallet.seed', 'utf8').trim()) })

console.log(`XUSD ${fromMicro(await xe.balance('XUSD'))}`)

// The first provider with a current certificate.
const now = BigInt(Date.now()) * 1_000_000n
let provider: Address | undefined
let multiplier = 0n
for (const p of await xe.client.providers()) {
  try {
    const cert = await xe.client.certificate(p.account)
    if (cert.expiresAt === 0n || cert.expiresAt > now) {
      provider = p.account
      multiplier = cert.priceMultiplierMilli
      break
    }
  } catch {
    // no certificate: this provider cannot be leased right now
  }
}
if (!provider) throw new Error('no provider can be leased right now')

const size = { vcpus: 1n, memoryMb: 1024n, diskGb: 1n }
console.log(`provider ${provider}: ${fromMicro(leaseCost(size, 60n, multiplier))} XUSD per minute`)

const { lease, opened } = await xe.rentLease({
  provider,
  ...size,
  durationSecs: 60,
  accessPubKey: Wallet.create().publicKey,
})
console.log(`lease ${opened.hash}: ${lease.state}, cost ${fromMicro(opened.cost)} XUSD`)
console.log(`runs ${new Date(Number(lease.startTime / 1_000_000n)).toISOString()} → ${new Date(Number(lease.effectiveExpiry / 1_000_000n)).toISOString()}`)
```

```sh
node rent-a-machine.ts
```

The lease runs for one minute and the provider settles it. To keep it longer,
renew it — which is the next tutorial.

**Next:** [6. Holding a lease open](06-holding-a-lease-open.md)
