<p align="center">
  <img src="logo.svg" width="96" height="103" alt="XE">
</p>

<h1 align="center">XE SDK</h1>

<p align="center">
  The TypeScript client for the XE network.<br>
  Hold your own keys, move value, and never run a node to do it.
</p>

<p align="center">
  <a href="https://test.network">test.network</a> ·
  <a href="https://test.network/docs">docs</a> ·
  <a href="https://github.com/xeprotocol/xe">node source</a>
</p>

---

> ### ⚠️ Pre-release
>
> - **Not published to a registry yet.** Build it from this repository or wait.
> - XE is pre-1.0 and runs on a **public testnet only**. Protocol changes land by
>   wiping the testnet and re-bootstrapping; balances, accounts and history are
>   discarded when that happens, on purpose and without warning.
> - **There is no backward compatibility**, and there will be none before 1.0.
>   The API in here will change.
> - **XE has no monetary value.** Testnet coins are for testing.
> - The current network is **`testnet-0003`**.

## What it does

XE's ledger is a lattice: every account owns its own signed chain, and a transfer
is two blocks — a `send` on the sender's chain and a `receive` on the
recipient's. There are no fees and no miners.

This SDK builds, signs and proves those blocks **locally** and submits them to
any node's HTTP API. That means:

- **You do not run a node.** Point it at a public one.
- **Your keys never leave your process.** Nothing is ever handed to a node.
- **It works in Node and in a browser**, on the same code path.

## Tutorials

**[`examples/`](examples/README.md)** has step-by-step tutorials in TypeScript and
JavaScript: your first wallet, getting testnet funds, sending, errors and
retries, renting a machine, and holding a lease open.

## Quick start

```ts
import { Wallet, Xe, fromMicro, toMicro } from '@xeprotocol/sdk'

const wallet = Wallet.create()          // or Wallet.fromSeedHex(process.env.SEED)
console.log(wallet.address)             // hand this out to receive funds

const xe = new Xe({ client: 'https://ldn.core.test.network', wallet })

// Anything sent to you arrives as PENDING and is yours only once you claim it.
await xe.receiveAll()

console.log(fromMicro(await xe.balance('XE')), 'XE')

await xe.send({
  to: someAddress,
  amount: toMicro('1.5'),
  memo: 'thanks',
})
```

### Address is not public key

An address is derived from a public key, and the two are different values:

```
address = sha256("xe/account/v1" || pubkey)
```

The **address** is identity — it goes in a block's `account` and `destination`,
and it is what you paste to receive funds. The **public key** is a credential.
Keeping them apart is what lets a key be rotated without the account changing,
so the SDK types them distinctly and will not let you pass one where the other
belongs.

### Amounts are integers

Both assets carry six decimal places and every amount on the wire is an integer
count of micro-units. Timestamps are unix **nanoseconds**. Both exceed what a
JavaScript `number` can hold exactly, so the SDK uses `bigint` throughout and
parses responses losslessly — a rounded timestamp produces a block the network
rejects, and a rounded balance is just wrong.

```ts
toMicro('1.5')        // 1500000n
fromMicro(1500000n)   // '1.500000'
```

### Errors tell you whether to retry

The node distinguishes a failure worth retrying (a block that arrived before its
dependency) from a terminal one (a bad signature). That distinction is carried
through, so you never have to guess from a message:

```ts
import { isRetryable } from '@xeprotocol/sdk'

try {
  await xe.send({ to, amount })
} catch (err) {
  if (isRetryable(err)) { /* back off and try again */ }
}
```

A non-2xx response always throws. An empty list from this SDK means the account
genuinely has nothing — never that the request failed.

## Renting a machine

A lease escrows XUSD with a provider for a fixed term. To pay only for the time
you use, keep the term short and **renew it a minute at a time** — nothing beyond
the current minute is ever escrowed, so if you stop (or your process dies) the
machine is released within a minute.

```ts
import { Wallet, Xe, holdLease } from '@xeprotocol/sdk'

const xe = new Xe({
  client: 'https://ldn.core.test.network',
  wallet: Wallet.fromSeedHex(process.env.SEED),
  // Renewals are timed by the network's timekeepers, so the SDK needs to
  // reach a threshold of them. The state chain names their keys, not their
  // addresses, so tell it where to look.
  timekeepers: [
    'https://ldn.core.test.network',
    'https://ffm.core.test.network',
    'https://nyc.core.test.network',
  ],
})

const sshKey = Wallet.create() // the key the machine will accept
const lease = await xe.openLease({
  provider,                      // an address from xe.client.providers()
  vcpus: 1, memoryMb: 1024, diskGb: 10,
  durationSecs: 60,
  accessPubKey: sshKey.publicKey,
})

// Renew a minute at a time until the term reaches ten minutes.
await holdLease(xe, lease.hash, { renewSecs: 60, totalSecs: 600 })
```

`openLease` prices the lease from the provider's current performance
certificate, exactly as the ledger will. `renewLease` gathers timekeeper
attestations, checks them locally, and locks the current oracle epoch's emission
parameters. `holdLease` renews ahead of each expiry and confirms every extension
on the ledger before scheduling the next. `cancelLease` withdraws a lease the
provider has not accepted; `forceSettleLease` reclaims the escrow of one the
provider never settled.

`examples/javascript/hold-lease.mjs` is a complete, runnable version that checks every
step and prints `PASS:`/`FAIL:` lines.

**Prices.** You sign the exact amount of every lease and renewal, so nobody can
charge you more than you signed for. On top of that the SDK refuses to sign a
price you did not agree to: a price ceiling, renewals held at the price the lease
opened at, and a total budget. See **[Budgets and prices](docs/budgets.md)**.

## Running a job

`@xeprotocol/sdk/jobs` (Node only) runs your code on a rented machine and brings
the results home, holding the lease a minute at a time while it runs:

```ts
import { runJob } from '@xeprotocol/sdk/jobs'

const job = await runJob(xe, {
  machine: { vcpus: 1, memoryMb: 1024, diskGb: 1 },
  files: { 'main.py': 'print("hello")' },
  run: 'python3 main.py',
  budget: toMicro('0.01'),
})
console.log(job.status, job.stdout, fromMicro(job.paid))
```

Five complete programs, including every way a job can fail, are in
[`examples/jobs/`](examples/jobs/README.md).

## What works today

| Area | Status |
|---|---|
| Wallets, addresses, signing | ✅ |
| Canonical block encoding, hashing, proof of work | ✅ verified byte-for-byte against the node |
| Send, receive, burn | ✅ |
| Balances, pending, chains, blocks, supply | ✅ |
| Providers, leases, state chain (read) | ✅ |
| Leasing a machine: open, renew, cancel, force-settle, hold a lease open | ✅ |
| Price ceiling, renewal price lock, budgets, quotes | ✅ |
| Jobs: run code on a leased machine and collect results (Node) | ✅ through the testnet SSH gateway |
| Published package | 🚧 not yet |
| Messaging and the account directory | 🚧 not yet |
| Other languages | 🚧 later — TypeScript first |

Separately: **there are no guarantees about provider availability on the
testnet**, so anything lease-shaped may have nobody to talk to. The node source
tracks the live position — see [xeprotocol/xe](https://github.com/xeprotocol/xe).

## Development

```sh
npm install
npm run typecheck
npm run lint
npm test              # unit tests, no network needed
npm run build
```

Integration tests run against a real node and **skip with a reason** when none
is reachable, so `npm test` works offline:

```sh
npm run test:integration                       # defaults to a public node
XE_NODE=http://127.0.0.1:8080 npm run test:integration
```

Every tutorial's complete program can also be run for real, in order, in both
languages:

```sh
npm run examples:check                         # type-check them, no network
npm run examples:live                          # run tutorials 1–4 on the testnet
XE_LEASE_SEED=<seed> npm run examples:live     # …and leasing (5–6), paid in XUSD
```

CI runs `examples:live` with a dedicated leasing wallet held in the
`XE_LEASE_SEED` repository secret. **After every testnet reset that wallet
starts at zero and must be refunded with XUSD** (by address; CI claims the
pending transfer itself). Until it is, the leasing tutorials fail in the
`integration` job with the wallet's address and balance.

### Why the vector fixture matters

`test/vectors.json` is generated by the node's own Go implementation. The tests
assert that this SDK produces **byte-identical** canonical encodings, hashes and
signatures for every one of them, across two different network ids.

That is not a formality. A block hash commits to the network id, the field
order, the position of the representative, the memo length byte and the way a
declared public key is framed. One byte wrong and the network rejects the block
— so the node, not our reading of it, is the authority.

## Issues

**Issues are turned off here.** Report anything about XE itself against the node
source at [xeprotocol/xe](https://github.com/xeprotocol/xe/issues), where there
is also a paid bug bounty — see [test.network/bounty](https://test.network/bounty).

**Critical or severe findings** — anything risking funds or the network — go
privately to `security@xe.network` first, never a public issue.

## License

GPL-3.0, the same as the node. See [LICENSE](LICENSE).
