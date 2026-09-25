// 5. A job that goes wrong — on purpose, eight ways.
//
// Each case checks two things: that the SDK reports the failure honestly, and
// that the machine is released (the lease stops being renewed, so it runs out
// within one billing minute plus the renewal lead time).
//
//   exit      the code exits non-zero        → resolves, status 'failed', exit code and stderr kept
//   timeout   the code runs past timeoutSecs → resolves, status 'timed-out', output so far kept
//   abort     we cancel it mid-run           → resolves, status 'aborted', files written so far collected
//   platform  no provider can take the job   → rejects with JobError, stage 'lease', nothing paid
//   kill      this process is killed -9      → nobody left to release it: the lease must run out by itself
//   budget    the money runs out mid-run     → resolves, status 'budget-reached', paid ≤ budget, files so far collected
//   ceiling   every provider is too dear     → rejects with XePriceError before signing, nothing paid
//   unbounded no budget and no timeout       → rejects with XeUsageError before signing, nothing paid
//
// A provider raising its price mid-lease ('price-changed') cannot be staged from
// here: it needs the provider's cooperation, so the SDK's own tests cover it.
//
// Prints PASS/FAIL lines; exits non-zero if any check fails.
//
//   node 05-failing-job.ts            # all eight
//   CASES=exit,kill node 05-failing-job.ts

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { Wallet, Xe, XePriceError, XeUsageError, fromMicro, toHash, toMicro, type Hash } from '@xeprotocol/sdk'
import { JobError, runJob } from '@xeprotocol/sdk/jobs'

const xe = new Xe({
  client: 'https://ldn.core.test.network',
  wallet: Wallet.fromSeedHex(readFileSync('wallet.seed', 'utf8').trim()),
  timekeepers: ['https://ldn.core.test.network', 'https://ffm.core.test.network', 'https://nyc.core.test.network'],
})
const machine = { vcpus: 1, memoryMb: 1024, diskGb: 1 }
const budget = toMicro('0.01') // every job needs a limit; this one is never the one that trips

// One billing minute, plus the 30s before expiry at which the next is bought.
const RELEASE_BOUND_MS = 90_000

let failures = 0
const check = (ok: boolean, what: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const nowMs = () => Date.now()
const expiryMs = async (hash: Hash) => Number((await xe.lease(hash)).effectiveExpiry / 1_000_000n)

/** The lease runs out within the bound of `since`, and nothing extends it afterwards. */
async function checkReleased(hash: Hash, since: number, label: string) {
  const expiry = await expiryMs(hash)
  check(expiry - since <= RELEASE_BOUND_MS, `${label}: lease stops within one minute`, `runs out ${((expiry - since) / 1000).toFixed(0)}s after`)
  await new Promise((r) => setTimeout(r, Math.max(0, expiry - nowMs()) + 10_000))
  check((await expiryMs(hash)) === expiry, `${label}: nothing renewed it afterwards`)
}

const cases: Record<string, () => Promise<void>> = {
  async exit() {
    const job = await runJob(xe, { machine, budget, run: 'echo "reading input…"; echo "input.csv: no such file" >&2; exit 3' })
    check(job.status === 'failed', 'exit: status is failed', job.status)
    check(job.exitCode === 3, 'exit: exit code kept', String(job.exitCode))
    check(job.stderr.includes('no such file'), 'exit: stderr kept')
    check(job.stdout.includes('reading input'), 'exit: stdout up to the failure kept')
    await checkReleased(job.lease, nowMs(), 'exit')
  },

  async timeout() {
    const job = await runJob(xe, { machine, run: 'for i in $(seq 600); do echo "tick $i"; sleep 1; done', timeoutSecs: 20 })
    check(job.status === 'timed-out', 'timeout: status is timed-out', job.status)
    check(job.exitCode === null, 'timeout: no exit code — it never finished', String(job.exitCode))
    check(job.stdout.includes('tick 10'), 'timeout: output so far kept')
    check(job.wallMs < 90_000, 'timeout: stopped promptly', `${(job.wallMs / 1000).toFixed(0)}s`)
    await checkReleased(job.lease, nowMs(), 'timeout')
  },

  async abort() {
    const stop = new AbortController()
    const job = await runJob(xe, {
      machine,
      budget,
      run: 'mkdir -p out; for i in $(seq 600); do echo "row $i" >> out/partial.txt; sleep 1; done',
      signal: stop.signal,
      onEvent: (e) => {
        if (e.type === 'started' && e.step === 'run') setTimeout(() => stop.abort(), 15_000)
      },
    })
    check(job.status === 'aborted', 'abort: status is aborted', job.status)
    check(job.files.some((f) => f.path === 'partial.txt'), 'abort: files written so far collected')
    await checkReleased(job.lease, nowMs(), 'abort')
  },

  async platform() {
    const before = await xe.balance('XUSD')
    try {
      await runJob(xe, { machine: { vcpus: 512, memoryMb: 1_048_576, diskGb: 1 }, budget, run: 'true' })
      check(false, 'platform: an impossible machine is refused')
    } catch (err) {
      check(err instanceof JobError, 'platform: rejects with JobError', String(err))
      if (err instanceof JobError) {
        check(err.stage === 'lease', 'platform: stage is lease', err.stage)
        check(err.message.length > 0, 'platform: says why', err.message)
      }
    }
    check((await xe.balance('XUSD')) === before, 'platform: nothing paid', fromMicro(before))
  },

  async kill() {
    // A second copy of this program starts a long job; we kill it -9 once the job runs.
    const child = spawn(process.execPath, [process.argv[1] ?? '05-failing-job.ts'], {
      env: { ...process.env, CASES: 'child' },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let lease: Hash | undefined
    for await (const line of createInterface({ input: child.stdout })) {
      if (line.startsWith('LEASE ')) lease = toHash(line.slice(6))
      if (line === 'RUNNING') break
    }
    if (!lease) return check(false, 'kill: child started a job')
    child.kill('SIGKILL')
    const killedAt = nowMs()
    console.log(`killed the client of lease ${lease.slice(0, 12)}…`)
    await checkReleased(lease, killedAt, 'kill')
    const settled = await xe.waitForLease(lease, ['settled'], { timeoutMs: 5 * 60_000, intervalMs: 5_000 })
    check(settled.state === 'settled', 'kill: provider settled the orphaned lease')
  },

  async budget() {
    // Enough for exactly two minutes at the cheapest price; the job wants an hour.
    const [cheapest] = await xe.quote(machine)
    if (!cheapest) return check(false, 'budget: some provider is leasable')
    const twoMinutes = cheapest.pricePerMinute * 2n
    const job = await runJob(xe, {
      machine,
      provider: cheapest.provider,
      budget: twoMinutes,
      run: 'mkdir -p out; for i in $(seq 3600); do echo "row $i" >> out/partial.txt; sleep 1; done',
    })
    check(job.status === 'budget-reached', 'budget: status is budget-reached', job.status)
    check(job.paid <= twoMinutes, 'budget: paid no more than the budget', `${fromMicro(job.paid)} of ${fromMicro(twoMinutes)}`)
    check(job.billedMinutes === 2, 'budget: billed exactly the two minutes it could afford', String(job.billedMinutes))
    check(job.files.some((f) => f.path === 'partial.txt'), 'budget: files written so far collected')
    await checkReleased(job.lease, nowMs(), 'budget')
  },

  async ceiling() {
    const before = await xe.balance('XUSD')
    try {
      await runJob(xe, { machine, budget, maxPricePerMinute: 1n, run: 'true' })
      check(false, 'ceiling: a 1 micro-XUSD/min ceiling is refused')
    } catch (err) {
      check(err instanceof XePriceError, 'ceiling: rejects with XePriceError', String(err))
      if (err instanceof XePriceError) check(err.price > err.ceiling, 'ceiling: says the price and the ceiling', `${err.price} > ${err.ceiling}`)
    }
    check((await xe.balance('XUSD')) === before, 'ceiling: nothing paid')
  },

  async unbounded() {
    const before = await xe.balance('XUSD')
    try {
      await runJob(xe, { machine, run: 'sleep 3600' })
      check(false, 'unbounded: a job with no budget and no timeout is refused')
    } catch (err) {
      check(err instanceof XeUsageError, 'unbounded: rejects with XeUsageError', String(err))
    }
    check((await xe.balance('XUSD')) === before, 'unbounded: nothing paid')
  },

  async child() {
    await runJob(xe, {
      machine,
      budget,
      run: 'sleep 3600',
      onEvent: (e) => {
        if (e.type === 'leased') console.log(`LEASE ${e.lease.hash}`)
        if (e.type === 'started' && e.step === 'run') console.log('RUNNING')
      },
    })
  },
}

const selected = (process.env['CASES'] ?? 'exit,timeout,abort,platform,kill,budget,ceiling,unbounded').split(',')
for (const name of selected) {
  const run = cases[name]
  if (!run) throw new Error(`unknown case ${name}; choose from ${Object.keys(cases).join(', ')}`)
  if (name !== 'child') console.log(`\n== ${name} ==`)
  await run()
}
if (selected[0] !== 'child') {
  console.log(failures === 0 ? '\nPASS: every failure was reported honestly and released' : `\nFAIL: ${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}
