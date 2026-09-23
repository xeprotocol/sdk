# 1. Your first wallet

**You will:** install the SDK, create a wallet, keep its seed safe, connect to a
node and read a balance.

**Time:** 5 minutes · **Needs:** Node.js 20 or newer · **Costs:** nothing

## Install

The SDK is not on npm yet. Install it straight from GitHub; npm builds it on
install.

```sh
mkdir xe-hello && cd xe-hello
npm init -y
npm pkg set type=module
npm install github:xeprotocol/sdk
```

Save programs as `.mjs` files (or keep `"type": "module"`, set above, and use `.js`) so top-level `await` works.

## Create a wallet

A wallet is a single 32-byte **seed**. Everything else — the public key, the
address — is derived from it.

```js
import { Wallet } from '@xeprotocol/sdk'

const wallet = Wallet.create()
console.log(wallet.address)   // your account: hand this out to receive funds
console.log(wallet.publicKey) // the key that signs for it
```

> **The seed is the money.** Anyone holding it controls the account, and there
> is no recovery if you lose it. The SDK keeps it in a private field, never puts
> it in an error message or a log line (`String(wallet)` is `Wallet(<address>)`,
> and `JSON.stringify(wallet)` holds only the address and public key), and never
> sends it anywhere. Your keys stay in your process; nodes only ever see signed
> blocks.

To keep a wallet between runs, write the seed out once and load it back:

```js
import { readFileSync, writeFileSync } from 'node:fs'
import { Wallet } from '@xeprotocol/sdk'

writeFileSync('wallet.seed', Wallet.create().seedHex(), { mode: 0o600 })
const wallet = Wallet.fromSeedHex(readFileSync('wallet.seed', 'utf8').trim())
```

## Address is not public key

They are both 64 hex characters, and they are **not** interchangeable:

| | What it is | Where it goes |
|---|---|---|
| `wallet.address` | `sha256("xe/account/v1" ‖ public key)` — the account's identity | sending funds, balance lookups, anything you share |
| `wallet.publicKey` | the ed25519 key — the credential | verifying signatures |

In JavaScript nothing stops you mixing them up, so name your variables carefully.
`toAddress(str)` checks a string is well-formed hex before you use it as one.

## Connect to a node

You do not run a node. Point the SDK at any public one:

```js
import { Wallet, Xe, fromMicro } from '@xeprotocol/sdk'

const xe = new Xe({ client: 'https://ldn.core.test.network', wallet: Wallet.create() })
console.log(await xe.networkId()) // e.g. testnet-0004
console.log(fromMicro(await xe.balance('XE')))
```

`Xe` binds one wallet to one node. It reads your balance and chain position
before every write, signs locally, solves the proof of work and submits.

## Amounts are integers

XE and XUSD both have six decimal places, and every amount in the SDK is an
integer number of **micro-units** held in a `bigint`:

```js
import { fromMicro, toMicro } from '@xeprotocol/sdk'

toMicro('1.5')        // 1_500_000n
fromMicro(1_500_000n) // '1.500000'
```

Never use `number` for amounts or timestamps. Timestamps are nanoseconds
(~1.8 × 10¹⁸) and balances can exceed 2⁵³; a `number` silently rounds them.

## The complete program

```js title="first-wallet.mjs"
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Wallet, Xe, fromMicro } from '@xeprotocol/sdk'

const SEED_FILE = 'wallet.seed'
const NODE = process.env['XE_NODE'] ?? 'https://ldn.core.test.network'

// Reuse the wallet from last time, or make one and keep its seed.
if (!existsSync(SEED_FILE)) {
  writeFileSync(SEED_FILE, Wallet.create().seedHex(), { mode: 0o600 })
  console.log(`created a new wallet; its seed is in ${SEED_FILE} — keep it safe`)
}
const wallet = Wallet.fromSeedHex(readFileSync(SEED_FILE, 'utf8').trim())

const xe = new Xe({ client: NODE, wallet })
console.log(`network  ${await xe.networkId()}`)
console.log(`address  ${xe.address}`)
console.log(`XE       ${fromMicro(await xe.balance('XE'))}`)
console.log(`XUSD     ${fromMicro(await xe.balance('XUSD'))}`)
```

```sh
node first-wallet.mjs
```

A new wallet shows a zero balance — it does not exist on the ledger yet. The
next tutorial fixes that.

**Next:** [2. Getting testnet funds](02-getting-testnet-funds.md)
