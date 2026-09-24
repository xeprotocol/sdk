# Examples

Step-by-step tutorials for building on XE with the SDK. Each one explains an idea,
shows the calls, and ends with a complete program you can run against the public
testnet.

Pick your language — the tutorials are the same in both:

| # | Tutorial | You will | TypeScript | JavaScript |
|---|---|---|---|---|
| 1 | Your first wallet | install the SDK, create and keep a wallet, connect, read a balance | [TS](typescript/01-first-wallet.md) | [JS](javascript/01-first-wallet.md) |
| 2 | Getting testnet funds | use the faucet, claim pending transfers, wait for finality | [TS](typescript/02-getting-testnet-funds.md) | [JS](javascript/02-getting-testnet-funds.md) |
| 3 | Sending XE | send with a memo, claim it on the other side, look up a block | [TS](typescript/03-sending-xe.md) | [JS](javascript/03-sending-xe.md) |
| 4 | Errors and retries | tell temporary failures from final ones and retry safely | [TS](typescript/04-errors-and-retries.md) | [JS](javascript/04-errors-and-retries.md) |
| 5 | Renting a machine | find a provider, price a machine, rent it | [TS](typescript/05-renting-a-machine.md) | [JS](javascript/05-renting-a-machine.md) |
| 6 | Holding a lease open | keep a machine as long as you need it, paying a minute at a time | [TS](typescript/06-holding-a-lease-open.md) | [JS](javascript/06-holding-a-lease-open.md) |

**Jobs**: run your code on a rented machine and get the results back. Five
complete programs are in [`jobs/`](jobs/README.md) and will become tutorials 7–11.
How jobs and leases keep you from overpaying is on its own page:
[Budgets and prices](../docs/budgets.md).

Tutorials 1–4 need nothing but Node.js. Leasing (5–6) is paid in **XUSD**, which
the testnet faucet does not hand out yet — tutorial 5 explains.

## Complete programs

- [`javascript/hold-lease.mjs`](javascript/hold-lease.mjs) — rent a machine and
  hold it for ten minutes, renewing a minute at a time, checking every step and
  printing `PASS`/`FAIL` lines. Run it from a checkout of this repository after
  `npm install`:
  ```sh
  XE_SEED=<seed of a wallet holding XUSD> node examples/javascript/hold-lease.mjs
  ```

## Before you start

- **Node.js 20 or newer.** The SDK also runs in the browser, on the same code.
- **The testnet is a testnet.** It is reset from time to time, balances do not
  carry over, and nothing on it has value.
- **Keep seeds out of source control.** The tutorials store one in `wallet.seed`
  with owner-only permissions. Add it to `.gitignore`.

Every complete program in these tutorials is type-checked (TypeScript) and
syntax-checked (JavaScript) against the SDK in CI (`npm run examples:check`),
so they stay in step with the API.
