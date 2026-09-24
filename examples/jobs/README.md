# Jobs — proposed API, written usage-first

> **Status: design draft. Nothing here runs yet.** These five programs are written
> against an API that does not exist so that the API can be built backwards from
> how it reads. Once it is built they become tutorials 7–11 (TypeScript and
> JavaScript), type-checked by `examples:check` and run by `examples:live` like the
> others. Until then they are deliberately outside the tutorial `.md` files, so CI
> ignores them.

A **job** is: rent a machine, put your code on it, run it, stream its output,
bring the results home, and give the machine back — paying one minute at a time
while it runs.

| # | Program | Shows |
|---|---|---|
| 1 | [`01-hello-world.ts`](01-hello-world.ts) | the smallest job: one command, its output, what it cost |
| 2 | [`02-site-check.ts`](02-site-check.ts) | the same job on every provider at once; stdout as the result channel |
| 3 | [`03-data-processing.ts`](03-data-processing.ts) | upload a dataset, process it, download result files |
| 4 | [`04-train-a-model.ts`](04-train-a-model.ts) | a long job: setup step, live progress, held open across many renewals |
| 5 | [`05-failing-job.ts`](05-failing-job.ts) | every way a job can end badly, and proof the machine is released each time |

## The API these programs assume

Everything job-related lives in a Node-only entry point, `@xeprotocol/sdk/jobs`
(it speaks SSH, which browsers cannot), so the main `@xeprotocol/sdk` stays
browser-clean.

### `runJob(xe, options): Promise<JobResult>`

Rents, uploads, runs, collects, releases. The machine is **always** released —
on success, on failure, on abort, on timeout. While the job runs the lease is
held open with `holdLease`, one minute at a time.

```ts
interface JobOptions {
  machine: { vcpus: number; memoryMb: number; diskGb: number }
  provider?: Address                            // default: first leasable provider that fits
  files?: Record<string, string | Uint8Array>   // written into the job directory before anything runs
  setup?: string                                // shell, run first; its failure fails the job
  run: string                                   // shell, run in the job directory
  env?: Record<string, string>
  collect?: string                              // directory on the machine brought home (default 'out')
  saveTo?: string                               // local directory it lands in (default: nothing written, bytes in result)
  timeoutSecs?: number                          // wall-clock limit for setup + run
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
  status: 'succeeded' | 'failed' | 'timed-out' | 'aborted'
  exitCode: number | null        // null when the process never exited on its own
  stdout: string
  stderr: string
  files: CollectedFile[]         // { path, bytes: Uint8Array } — and written under saveTo if given
  lease: Hash
  provider: Address
  wallMs: number
  paid: bigint                   // micro-XUSD: first minute + every renewal
}
```

**Two kinds of bad ending, kept apart on purpose:**

- *Your code* failed — non-zero exit, timeout, you aborted it: `runJob`
  **resolves** with `status` saying which. Output and any collected files are
  still there.
- *The platform* failed — no provider would take the lease, the machine could not
  be reached, the lease was lost mid-run: `runJob` **rejects** with a `JobError`
  whose `stage` (`'lease' | 'connect' | 'upload' | 'run' | 'collect'`) says where,
  and whose `lease` (if one was opened) says what to look up.

### `leasableProviders(xe, machine?): Promise<Address[]>`

Providers with a valid certificate (and, given a machine, the capacity for it).
Replaces the hand-written `leasableProvider()` in tutorials 5–6.

### What the SDK does for you

- Generates a fresh SSH access key per job, signs it into the lease, and throws
  it away after — you never handle a key.
- Reaches the machine through the network's SSH gateway (username = lease hash,
  key = the lease's access key). No node of your own needed.
- Runs everything in a fresh job directory; `collect` is relative to it.

## Open questions this draft takes a position on

- **Arbitrary code** (you run any shell) rather than pinned workloads.
- **Results convention**: a directory (`out/` by default) the SDK brings home,
  plus stdout/stderr.
- **Separate entry point** (`@xeprotocol/sdk/jobs`) rather than a separate package
  or folding SSH into the main export.
- **SDK-generated access keys**, never shown.
- **A dead client releases the machine within one billing minute** — program 5
  proves it.

Unverified until the first spike: whether the machines have outbound internet
(programs 2 and 4 need it; 1, 3 and 5 do not), and what is installed on the
image (the programs assume `python3` and `curl`).
