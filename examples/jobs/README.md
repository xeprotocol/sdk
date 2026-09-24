# Jobs

> **Status: working on the public testnet.** The API was designed usage-first:
> these five programs were written before it existed, and it was built until they
> ran. `examples:check` type-checks all five against the SDK; `examples:live` runs
> 01 and 03 (the others hold machines for many minutes and are run by hand). They
> become step-by-step tutorials 7–11 next.
>
> Run one from a checkout of this repository after `npm install && npm run build`,
> with a funded `wallet.seed` beside it:
> ```sh
> node examples/jobs/01-hello-world.ts
> ```

A **job** is: rent a machine, put your code on it, run it, stream its output,
bring the results home, and give the machine back — paying one minute at a time
while it runs.

| # | Program | Shows |
|---|---|---|
| 1 | [`01-hello-world.ts`](01-hello-world.ts) | the smallest job: one command, its output, what it cost |
| 2 | [`02-site-check.ts`](02-site-check.ts) | quote every provider's price, then run the same job on each at once; stdout as the result channel |
| 3 | [`03-data-processing.ts`](03-data-processing.ts) | upload a dataset, process it, download result files; a price ceiling and a budget |
| 4 | [`04-train-a-model.ts`](04-train-a-model.ts) | a long job: setup step, live progress, many renewals at a locked price, ended by its budget |
| 5 | [`05-failing-job.ts`](05-failing-job.ts) | every way a job can end badly (including running out of money or being priced out) and proof the machine is released each time |

## The API

Everything job-related lives in a Node-only entry point, `@xeprotocol/sdk/jobs`
(it speaks SSH, which browsers cannot), so the main `@xeprotocol/sdk` stays
browser-clean.

### `runJob(xe, options): Promise<JobResult>`

Rents, uploads, runs, collects, releases. The machine is **always** released —
on success, on failure, on abort, on timeout. While the job runs the lease is
held open with `holdLease`, one minute at a time.

A job must have a spending limit: `runJob` refuses to start without a `budget`
or a `timeoutSecs`. Prices, the price lock on renewals and budgets are covered in
full in [Budgets and prices](../../docs/budgets.md).

```ts
interface JobOptions {
  machine: { vcpus: number; memoryMb: number; diskGb: number }
  provider?: Address                            // default: cheapest leasable provider within the ceiling (interim — see below)
  maxPricePerMinute?: bigint                    // micro-XUSD; refuse dearer, and the renewal ceiling (default: the opening price)
  budget?: bigint                               // micro-XUSD; the most the whole job may cost
  files?: Record<string, string | Uint8Array>   // written into the job directory before anything runs
  setup?: string                                // shell, run first; its failure fails the job
  run: string                                   // shell, run in the job directory
  env?: Record<string, string>
  collect?: string                              // directory on the machine brought home (default 'out')
  saveTo?: string                               // local directory it lands in (default: nothing written, bytes in result)
  timeoutSecs?: number                          // wall-clock limit for setup + run (budget or timeoutSecs required)
  signal?: AbortSignal                          // abort = stop the job, collect what exists, release
  onEvent?: (event: JobEvent) => void
}

type JobEvent =
  | { type: 'leased'; lease: LeaseRecord; provider: Address }
  | { type: 'connected' }
  | { type: 'uploaded'; files: number; bytes: number }
  | { type: 'started'; step: 'setup' | 'run' }
  | { type: 'stdout' | 'stderr'; text: string; step: 'setup' | 'run' }
  | { type: 'renewed'; lease: LeaseRecord }
  | { type: 'collected'; files: CollectedFile[] }
  | { type: 'released'; lease: LeaseRecord }

interface JobResult {
  status: 'succeeded' | 'failed' | 'timed-out' | 'aborted' | 'budget-reached' | 'price-changed'
  exitCode: number | null        // null when the process never exited on its own
  stdout: string
  stderr: string
  files: CollectedFile[]         // { path, bytes: Uint8Array } — and written under saveTo if given
  lease: Hash
  provider: Address
  wallMs: number
  pricePerMinute: bigint         // micro-XUSD, the price the job opened at
  billedMinutes: number
  paid: bigint                   // micro-XUSD: first minute + every renewal
}
```

**Two kinds of bad ending, kept apart on purpose:**

- *Your code* failed, or a limit ended it (non-zero exit, timeout, abort,
  budget reached, provider raised its price): `runJob`
  **resolves** with `status` saying which. Output and any collected files are
  still there.
- *The platform* failed — no provider would take the lease, the machine could not
  be reached, the lease was lost mid-run: `runJob` **rejects** with a `JobError`
  whose `stage` (`'lease' | 'connect' | 'upload' | 'run' | 'collect'`) says where,
  and whose `lease` (if one was opened) says what to look up.

### `xe.quote(machine): Promise<Quote[]>`

Every leasable provider (valid certificate) and its price per minute for this
machine, cheapest first. Replaces the hand-written `leasableProvider()` in
tutorials 5–6. It lives on `Xe` in the main SDK because it needs no SSH.

### Choosing a provider — interim

With `provider` left out, the SDK picks the **cheapest** leasable provider
within your ceiling. That stops accidental overpaying, but it is a placeholder:
what "best" should mean (price per unit of work, reliability, location,
spreading load) still needs design. Pass `provider` if the choice matters.

### What the SDK does for you

- Generates a fresh SSH access key per job, signs it into the lease, and throws
  it away after — you never handle a key.
- Reaches the machine through the network's SSH gateway (username = lease hash,
  key = the lease's access key), then logs in to the machine's own SSH server
  through it, end to end. No node of your own needed. Pass `gateway: 'host:port'`
  to use another; the default is the public testnet's.
- Runs everything in a fresh job directory (`/root/job`); `collect` is relative
  to it. Each step runs in its own process session, so a timeout, abort or limit
  stops the whole process tree, not just the shell.
- Queues writes from one `Xe`, so several jobs can run at once from one wallet.
  Use one `Xe` per wallet: two instances for the same wallet are not coordinated.

## The machines

Testnet machines run Ubuntu 24.04 with Python 3.12, `curl` and `git`, as root,
with outbound internet. There is no `pip` or compiler: install what you need
with `apt-get` in `setup` (as program 4 does).

## Design positions

- **Arbitrary code** (you run any shell) rather than pinned workloads.
- **Results convention**: a directory (`out/` by default) the SDK brings home,
  plus stdout/stderr.
- **Separate entry point** (`@xeprotocol/sdk/jobs`) rather than a separate package
  or folding SSH into the main export.
- **SDK-generated access keys**, never shown.
- **A dead client releases the machine within one billing minute** — program 5
  proves it.
- **Renewals keep the opening price** unless `maxPricePerMinute` allows more;
  a job needs a `budget` or a `timeoutSecs`.
