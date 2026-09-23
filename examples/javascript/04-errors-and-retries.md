# 4. Errors and retries

**You will:** learn the SDK's four error types, which ones are worth retrying,
and a retry loop you can reuse.

**Time:** 5 minutes · **Needs:** [1. Your first wallet](01-first-wallet.md)

## The rule

Every failure answers one question: **would trying again help?**

| Error | Means | Retry? |
|---|---|---|
| `XeUsageError` | you asked for something the protocol cannot do — a bad address, a negative amount, renewing a lease you do not hold | never |
| `XeInsufficientFundsError` | a `XeUsageError`: the wallet does not hold enough | never (fund it first) |
| `XeApiError` | the node refused. `err.retryable` says whether it was temporary (`503`: e.g. it has not synced a block yet) or final (`400`: e.g. a bad signature) | only if `err.retryable` |
| `XeTransportError` | the request never got an answer: DNS, connection, timeout | always |

`isRetryable(err)` answers the question for you.

## What the SDK already does

The HTTP client **already retries retryable failures** — three attempts with
exponential backoff by default — and never retries a terminal one: a bad
signature is still bad on the third attempt. Tune it when you construct the
client:

```js
import { Xe, XeClient } from '@xeprotocol/sdk'

const client = new XeClient({
  url: 'https://ldn.core.test.network',
  retries: 5,       // attempts after the first, for retryable failures only
  backoffMs: 500,   // doubles each attempt
  timeoutMs: 15_000,
})
const xe = new Xe({ client, wallet })
```

## Failures are never silent

A request that fails **throws**. It never comes back as an empty list or a zero
balance, so an empty result from the SDK always means there genuinely is
nothing there — not that the node was down.

## Retrying a whole operation

The client's retries cover one HTTP request. A write is several requests (read
your balance, read your frontier, submit), so if a submit is refused retryably
it is worth redoing the **whole** operation — the balance or frontier may have
moved on:

```js
import { isRetryable } from '@xeprotocol/sdk'

async function withRetry(op, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      return await op()
    } catch (err) {
      if (!isRetryable(err) || i === attempts) throw err
      await new Promise((r) => setTimeout(r, 1_000 * i))
    }
  }
}

await withRetry(() => xe.send({ to: recipient, amount: toMicro('1') }))
```

## The complete program

```js title="errors.mjs"
import { Wallet, Xe, XeApiError, XeTransportError, XeUsageError, isRetryable, toMicro } from '@xeprotocol/sdk'

const xe = new Xe({ client: 'https://ldn.core.test.network', wallet: Wallet.create() })

function explain(err) {
  if (err instanceof XeUsageError) return `usage error (${err.name}), do not retry: ${err.message}`
  if (err instanceof XeApiError) return `node said ${err.status}, retryable=${err.retryable}: ${err.message}`
  if (err instanceof XeTransportError) return `no answer, retry: ${err.message}`
  return `unexpected: ${String(err)}`
}

// A brand-new wallet has nothing to send: refused before anything is signed.
try {
  await xe.send({ to: Wallet.create().address, amount: toMicro('1') })
} catch (err) {
  console.log(explain(err), '| isRetryable:', isRetryable(err))
}

// A node that does not exist: a transport failure.
const nowhere = new Xe({ client: { url: 'http://127.0.0.1:1', retries: 0 }, wallet: Wallet.create() })
try {
  await nowhere.balance()
} catch (err) {
  console.log(explain(err), '| isRetryable:', isRetryable(err))
}
```

```sh
node errors.mjs
```

**Next:** [5. Renting a machine](05-renting-a-machine.md)
