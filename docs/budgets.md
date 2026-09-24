# Budgets and prices — never pay more than you meant to

> **Status: design draft.** This page describes price protection the SDK is
> about to gain. Nothing on it is implemented yet. The job examples in
> [`examples/jobs/`](../examples/jobs/README.md) are written against it.

Renting a machine on XE is paid in **XUSD**, a minute at a time. This page covers
what you pay, which controls stop you paying more, and what happens when one of
them kicks in.

## In one minute

```ts
import { toMicro } from '@xeprotocol/sdk'

const { lease } = await xe.rentLease({
  vcpus: 1,
  memoryMb: 1024,
  diskGb: 1,
  durationSecs: 60,
  maxPricePerMinute: toMicro('0.001'), // refuse any provider dearer than this
})

await holdLease(xe, lease.hash, {
  budget: toMicro('0.05'),             // stop renewing before total spend passes this
})
```

- **You always sign the exact amount.** Every lease and renewal carries its price.
  The network rejects the block if the price is off by even one micro-XUSD. Nobody
  can charge you more than you signed for.
- **The SDK refuses to sign a price you did not agree to.** There are three limits:
  a **price ceiling**, a **price lock** on renewals (on by default), and a total
  **budget**.
- **Stopping never loses what you paid for.** When a limit is hit, the SDK
  stops renewing. The machine keeps running until the end of the minute you have
  already paid for, and then it is released.

## What a machine costs

A provider's price for a machine is a price **per minute**, for that exact
machine (vCPUs, memory, disk), set by that provider. Billing is in **whole
minutes**: a lease or renewal must be a multiple of 60 seconds, and the SDK
rejects any other duration rather than silently rounding it up.

Ask before you rent:

```ts
const quotes = await xe.quote({ vcpus: 1, memoryMb: 1024, diskGb: 1 })
for (const q of quotes) {
  console.log(`${q.provider.slice(0, 12)}…  ${fromMicro(q.pricePerMinute)} XUSD/min`)
}
```

`quote` returns every provider that can be leased right now (valid certificate),
**cheapest first**. On the testnet today, the same small machine costs about
0.000517 XUSD/min from one provider and 0.001293 XUSD/min from another. For
identical hardware, the choice of provider can make a 2.5× difference.

## The three limits

### 1. Price ceiling — `maxPricePerMinute`

The most you will pay per minute for this machine. The SDK checks it **before
signing**, both on opening and on every renewal. If the price is above it, the
call throws `XePriceError` and nothing is spent.

```ts
try {
  await xe.rentLease({ provider, vcpus: 1, memoryMb: 1024, diskGb: 1, durationSecs: 60, maxPricePerMinute: toMicro('0.001') })
} catch (err) {
  if (err instanceof XePriceError) {
    console.log(`${err.provider} wants ${fromMicro(err.price)}/min, ceiling ${fromMicro(err.ceiling)}`)
  }
}
```

Accepted by `openLease`, `rentLease`, `renewLease`, `holdLease` and `runJob`.

### 2. Price lock on renewals — on by default

A renewal is priced at the provider's **current** price, and providers can
change their price while you hold a lease. So by default **a lease keeps the
price it was opened at**:

| When a renewal is due and the provider's price… | The SDK… |
|---|---|
| is the same or lower | renews (you pay the lower price) |
| has risen, and you set **no** `maxPricePerMinute` | **stops renewing** — reason `price-changed` |
| has risen, but is still within your `maxPricePerMinute` | renews at the new price |
| has risen above your `maxPricePerMinute` | **stops renewing** — reason `price-changed` |

**The rule:** the renewal ceiling is your `maxPricePerMinute` if you set one,
otherwise the price you opened at. To accept price rises, set
`maxPricePerMinute` to the highest price you will pay.

### 3. Total budget — `budget`

The most the lease may cost in total: the first minute plus every renewal. Before
each renewal the SDK checks `paid + next renewal ≤ budget`, and stops renewing
(reason `budget-reached`) if it would go over.

```ts
const held = await holdLease(xe, lease.hash, { budget: toMicro('0.05') })
if (held.reason === 'budget-reached') console.log(`spent ${fromMicro(held.paid)} of the budget`)
```

Accepted by `holdLease` and `runJob`. A single `openLease`/`renewLease` has no
budget, because its price *is* its whole cost: use `maxPricePerMinute`.

## Jobs must have a limit

`runJob` holds a lease open for as long as the job runs. A job that hangs would
otherwise keep paying for itself. So `runJob` **refuses to start** (throws
`XeUsageError`, nothing signed) unless it has at least one of:

- `budget`: the most the job may spend, or
- `timeoutSecs`: the longest it may run.

With both set, whichever comes first ends the job.

## When a limit is hit

| Limit hit | When | You find out by | You pay |
|---|---|---|---|
| Ceiling, on opening | before signing | `XePriceError` thrown | nothing |
| Ceiling or lock, on a renewal | before signing the renewal | `holdLease` resolves `reason: 'price-changed'`; `runJob` resolves `status: 'price-changed'` | only the minutes already paid |
| Budget | before signing the renewal that would go over | `reason: 'budget-reached'` / `status: 'budget-reached'` | at most `budget` |
| Job without `budget` or `timeoutSecs` | before anything | `XeUsageError` thrown | nothing |

When a limit stops a **job**, `runJob` uses the rest of the paid minute to stop
your code and bring home whatever it has written to `out/`, then resolves. Your
results up to that point are not lost.

Every result says what it cost:

```ts
const job = await runJob(xe, { machine, run: 'make test', budget: toMicro('0.02') })
console.log(`${fromMicro(job.pricePerMinute)} XUSD/min × ${job.billedMinutes} min = ${fromMicro(job.paid)} XUSD`)
```

## The worst case, exactly

| You set | The most you can pay |
|---|---|
| `budget` | `budget` |
| `timeoutSecs` only | (whole minutes in `timeoutSecs` + 1) × the renewal ceiling |
| neither, on `holdLease` | unlimited until you abort, one ceiling-priced minute at a time |
| any, and your process dies | nothing more: renewals stop with it, and the machine is released at the end of the minute already paid |

`holdLease` without a budget is allowed, because it is how you hold a machine
"until I say stop". If you use it that way, make sure something will call
`abort()`.

## How a provider is chosen

`provider` becomes optional on `rentLease`. When you do not pass it, `rentLease`
and `runJob` pick one for you.
**For now** they pick the **cheapest** leasable provider within your ceiling.
Good selection criteria are still being designed: speed, reliability, where the
provider is, and spreading load. Expect this to change. If the choice matters to
you, call `quote` and pass `provider` yourself.

## Reference

| Name | Where | What |
|---|---|---|
| `maxPricePerMinute` | `openLease`, `rentLease`, `renewLease`, `holdLease`, `runJob` | micro-XUSD ceiling per minute; also lifts the price lock up to that value |
| `budget` | `holdLease`, `runJob` | micro-XUSD cap on the lease's total cost |
| `xe.quote(machine)` | `Xe` | `{ provider, pricePerMinute, certificateExpiresAt }[]`, cheapest first |
| `XePriceError` | thrown | `{ provider, price, ceiling }` — refused before signing |
| `HoldResult.reason` | `holdLease` | `'target-reached' \| 'aborted' \| 'price-changed' \| 'budget-reached'` |
| `HoldResult.paid` | `holdLease` | micro-XUSD, first minute + every renewal |
| `JobResult.status` | `runJob` | adds `'price-changed' \| 'budget-reached'` |
| `JobResult.pricePerMinute`, `billedMinutes`, `paid` | `runJob` | what the job cost, and how |

All amounts are **micro-XUSD** as `bigint`. Use `toMicro('0.05')` and
`fromMicro(n)` to convert.
