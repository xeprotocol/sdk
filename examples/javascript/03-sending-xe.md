# 3. Sending XE

**You will:** send XE with a memo, see how the recipient claims it, and check a
block on the ledger.

**Time:** 5 minutes · **Needs:** a funded wallet ([2. Getting testnet funds](02-getting-testnet-funds.md)) · **Costs:** nothing — there are no fees

## Send

```js
import { toAddress, toMicro } from '@xeprotocol/sdk'

const result = await xe.send({
  to: toAddress('4feede759012ae67f4d4636322485f04e7d995525c6ce171da2601fdbe2e2a76'),
  amount: toMicro('2.5'),
  memo: 'thanks for lunch', // optional, up to 64 bytes of UTF-8
})
console.log(result.hash)
```

`toAddress` checks the string is 64 lowercase hex characters, so a typo fails
here rather than at the node.

There are **no fees and no miners**. Instead each block carries a small proof of
work, which the SDK solves for you before submitting — typically well under a
second.

## What `send` does for you

1. reads your current balance and your chain's latest block (the *frontier*),
2. builds a `send` block committing to both: the new balance, and the previous
   block it extends,
3. signs it locally with your seed,
4. solves the proof of work,
5. submits it to the node.

Because every block commits to the one before it, **two writes from the same
wallet at once race each other**, and the node rejects the loser. Use one `Xe`
per wallet and `await` each write.

## The recipient receives

The money leaves your balance immediately, but it only lands in the recipient's
when *they* write a `receive` — exactly as you did with the faucet. If you are
the recipient in another program, `await xe.receiveAll()` claims everything
waiting.

## Look it up

Any node will show you the block:

```js
const block = await xe.client.block(result.hash)
console.log(block['type'], block['amount'], block['memo'])
```

## Not enough funds

The SDK checks before it signs anything:

```js
import { XeInsufficientFundsError } from '@xeprotocol/sdk'

try {
  await xe.send({ to: recipient, amount: toMicro('1000000') })
} catch (err) {
  if (err instanceof XeInsufficientFundsError) {
    console.log(`short: have ${err.available}, need ${err.required}`)
  } else {
    throw err
  }
}
```

## The complete program

Send 1 XE to a second wallet you own, and claim it there.

```js title="send-xe.mjs"
import { readFileSync } from 'node:fs'
import { Wallet, Xe, fromMicro, toMicro } from '@xeprotocol/sdk'

const NODE = process.env['XE_NODE'] ?? 'https://ldn.core.test.network'

const alice = new Xe({ client: NODE, wallet: Wallet.fromSeedHex(readFileSync('wallet.seed', 'utf8').trim()) })
const bob = new Xe({ client: NODE, wallet: Wallet.create() })

const sent = await alice.send({ to: bob.address, amount: toMicro('1'), memo: 'hello bob' })
console.log(`alice sent 1 XE in block ${sent.hash}`)

// Bob sees it as pending until he receives it.
while ((await bob.pending()).length === 0) await new Promise((r) => setTimeout(r, 500))
await bob.receiveAll()

console.log(`alice XE ${fromMicro(await alice.balance('XE'))}`)
console.log(`bob   XE ${fromMicro(await bob.balance('XE'))}`)
```

```sh
node send-xe.mjs
```

**Next:** [4. Errors and retries](04-errors-and-retries.md)
