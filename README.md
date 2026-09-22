<p align="center">
  <img src="logo.svg" width="96" height="103" alt="XE">
</p>

<h1 align="center">XE SDK</h1>

<p align="center">
  The client library for the XE network.<br>
  Hold your own keys, lease a real machine, keep it for as long as you need it, get your work back.
</p>

<p align="center">
  <a href="https://test.network">test.network</a> ·
  <a href="https://test.network/docs">docs</a> ·
  <a href="https://github.com/xeprotocol/xe">node source</a>
</p>

---

> ### ⚠️ Nothing is here yet
>
> This repository is a placeholder. The SDK is being designed and **no code has
> been published to it**. It exists now so the name is stable and the intent is
> public — not because there is something to install.
>
> - **There is no package to install**, in any language. The language itself is
>   not settled.
> - **Everything below describes intent, not behaviour.** Every part of it is
>   liable to change, including the shape of the API and the names in it.
> - XE is pre-1.0 and runs on a **public testnet only**. Protocol changes land
>   by wiping the testnet and re-bootstrapping; balances, accounts and history
>   are discarded when that happens, on purpose and without warning.
> - **There is no backward compatibility**, and there will be none before 1.0.
>   Assume anything published here breaks.
> - **XE has no monetary value.** Testnet coins are for testing.
> - The current network is **`testnet-0003`**.

## What this is for

XE lets you rent a real machine from a stranger and pay for it on a ledger with
no fees and no miners. The node software is the network; this SDK is how a
program uses it.

The shape it is being built to:

```
  import a wallet        keys stay on your side and never leave it
  find a machine         providers advertise what they have and what they charge
  take it                open a lease, and the machine is yours
  do the work            your code, your data, your results
  hold it open           keep it for as long as you need, pay for the time you hold it
  let it go              stop, and it stops costing you
```

Two things worth knowing up front, because they shape everything else:

**You do not need to run a node.** The SDK builds and signs blocks locally and
talks to any node's HTTP API. Running infrastructure is not a prerequisite for
using the network, and handing your keys to someone else's node is never
required.

**A machine is not a fixed-term rental.** You hold it for as long as you keep
holding it, and you stop paying when you stop. There is no term to commit to up
front and no refund to chase afterwards, because money you never spent stays
where it is.

This is meant to be usable by a program with nobody watching it. A person
opening a terminal is one way to use XE; software deciding on its own to go and
rent a machine is the one being designed for.

## Status

Honest, and it is all one answer today:

| Area | Status |
|---|---|
| Published package | 🚧 nothing published |
| Language and package name | 🚧 not decided |
| Wallets, addresses, signing | 🚧 design |
| Transfers and balances | 🚧 design |
| Leasing a machine | 🚧 design |
| Holding a lease open | 🚧 design |
| Getting results back | 🚧 design |
| Messaging | 🚧 design |
| Reference docs and examples | 🚧 none yet |

Separately, and worth saying plainly: **there are no providers online on the
testnet right now**, so leasing a machine is not something anyone can do today,
with this SDK or without it. That is a property of the network, not of this
repository. The node source tracks the live position honestly —
see [xeprotocol/xe](https://github.com/xeprotocol/xe).

## Using XE today

Until this exists, the node binary is the way in. It is one binary that is both
the daemon and a client, and it covers wallets, transfers, messaging and the
rest:

- **Source, build instructions and a walkthrough** —
  [github.com/xeprotocol/xe](https://github.com/xeprotocol/xe)
- **The HTTP API** this SDK will sit on top of —
  [`docs/api.md`](https://github.com/xeprotocol/xe/blob/master/docs/api.md)
- **Architecture, consensus, tokenomics** —
  [test.network/docs](https://test.network/docs)

## Issues

**Issues are turned off on this repository.** There is no code here to report a
bug in, and tracking work for it happens elsewhere.

If you have found a problem with XE itself, report it against the node source at
[xeprotocol/xe](https://github.com/xeprotocol/xe/issues), where there is also a
paid bug bounty — see [test.network/bounty](https://test.network/bounty).

**Critical or severe findings** — anything risking funds or the network — go
privately to `security@xe.network` first, never a public issue.

## License

**Not yet settled.** The node source is GPL-3.0, but a client library carries
different obligations for the people building on it, so the choice here is being
made deliberately rather than inherited. It will be set before any code is
published, and until then no licence is granted.
