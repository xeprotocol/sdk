#!/usr/bin/env node
// Run every tutorial's complete program against a live network, in order, in
// both languages — the proof that the tutorials work, not just that they
// type-check.
//
// Programs run from inside this repository, so `@xeprotocol/sdk` resolves to
// the package itself (its built dist/). Each language gets its own directory,
// and so its own wallet.seed, exactly as a reader following along would.
//
// Tutorials 1–4 need nothing: the faucet funds the wallet. Leasing (5–6) and
// the short job programs (examples/jobs 01, 03) are paid in XCU, which the faucet does not hand out, so those run only when
// XE_LEASE_SEED names a wallet that holds some; otherwise they are skipped.
// Pending XCU sent to that wallet is claimed first, so it can be refunded by
// address alone.
//
//   npm run build && npm run examples:live
//   XE_LEASE_SEED=<hex seed holding XCU> npm run examples:live
//
// XE_PROVIDERS=<account>[,<account>] limits the providers the programs see to
// those accounts (scripts/pin-providers.mjs), so leases go only to providers
// known to accept them.
//
// Needs Node 22.6+ (TypeScript runs through Node's own type stripping).

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, '.examples-run')
const FENCE = /^```(ts|js) title="([\w.-]+)"\n([\s\S]*?)^```$/gm
const LEASING = /^0[56]-/
const leaseSeed = process.env['XE_LEASE_SEED']?.trim()
const pin = process.env['XE_PROVIDERS']?.trim()
  ? ['--import', pathToFileURL(join(root, 'scripts', 'pin-providers.mjs')).href]
  : []
if (pin.length) console.log(`providers pinned to ${process.env['XE_PROVIDERS'].trim()}`)

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(`FAIL: Node ${process.versions.node} cannot run the TypeScript tutorials; use 22.6 or newer`)
  process.exit(2)
}

let passed = 0
let failed = 0
let skipped = 0
rmSync(out, { recursive: true, force: true })

// Enough for both languages' leasing tutorials (~0.003 XCU) and the two job
// programs (budgets 0.01 + 0.02 XCU, ~0.002 spent) with headroom.
const MIN_LEASE_XCU = 50_000n

/**
 * Claim anything sent to the leasing wallet and check it can pay. It is refunded
 * by address alone (the issuer cannot sign for it), so a top-up arrives as a
 * pending transfer that only this wallet's own key can receive.
 */
async function prepareLeaseWallet(seed) {
  const { Wallet, Xe, fromMicro } = await import('../dist/index.js')
  const xe = new Xe({ client: process.env['XE_NODE'] ?? 'https://ldn.core.test.network', wallet: Wallet.fromSeedHex(seed) })
  const claimed = await xe.receiveAll()
  const deadline = Date.now() + 60_000
  while ((await xe.spendable('XCU')) < (await xe.balance('XCU')) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000))
  }
  const xcu = await xe.spendable('XCU')
  console.log(`leasing wallet ${xe.address}: ${fromMicro(xcu)} XCU spendable (claimed ${claimed.length} pending)`)
  if (xcu < MIN_LEASE_XCU) {
    throw new Error(
      `leasing wallet ${xe.address} holds ${fromMicro(xcu)} XCU, needs ${fromMicro(MIN_LEASE_XCU)} — ` +
        'refund it with XCU (after a testnet reset it starts at zero)',
    )
  }
}

let leaseReady = false
if (leaseSeed) {
  try {
    await prepareLeaseWallet(leaseSeed)
    leaseReady = true
  } catch (err) {
    console.log(`FAIL: leasing wallet — ${err.message}`)
    failed++
  }
}

for (const lang of ['typescript', 'javascript']) {
  const cwd = join(out, lang)
  mkdirSync(cwd, { recursive: true })
  const dir = join(root, 'examples', lang)
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    for (const [, , file, body] of readFileSync(join(dir, name), 'utf8').matchAll(FENCE)) {
      const label = `${lang}/${name}`
      if (LEASING.test(name) && !leaseReady) {
        console.log(`SKIP: ${label} — leasing needs XCU; ${leaseSeed ? 'the leasing wallet is not ready (above)' : 'set XE_LEASE_SEED to run it'}`)
        skipped++
        continue
      }
      if (LEASING.test(name)) writeFileSync(join(cwd, 'wallet.seed'), leaseSeed, { mode: 0o600 })
      writeFileSync(join(cwd, file), body)

      const started = Date.now()
      const run = spawnSync(
        process.execPath,
        ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', ...pin, file],
        { cwd, encoding: 'utf8', timeout: 10 * 60_000, env: { ...process.env, MINUTES: '2' } },
      )
      const secs = ((Date.now() - started) / 1000).toFixed(1)
      const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim()
      if (run.status === 0) {
        console.log(`PASS: ${label} (${file}, ${secs}s)`)
        passed++
      } else {
        console.log(`FAIL: ${label} (${file}, exit ${run.status ?? run.signal}, ${secs}s)`)
        failed++
      }
      console.log(output.replace(/^/gm, '    '))
    }
  }
}

// Jobs: the two short, single-job programs. The others hold machines for many
// minutes (training, the failure cases) and are run by hand.
const JOBS = ['01-hello-world.ts', '03-data-processing.ts']
const jobsCwd = join(out, 'jobs')
mkdirSync(jobsCwd, { recursive: true })
for (const file of JOBS) {
  const label = `jobs/${file}`
  if (!leaseReady) {
    console.log(`SKIP: ${label} — jobs are paid in XCU; ${leaseSeed ? 'the leasing wallet is not ready (above)' : 'set XE_LEASE_SEED to run it'}`)
    skipped++
    continue
  }
  writeFileSync(join(jobsCwd, 'wallet.seed'), leaseSeed, { mode: 0o600 })
  writeFileSync(join(jobsCwd, file), readFileSync(join(root, 'examples', 'jobs', file), 'utf8'))
  const started = Date.now()
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', ...pin, file], {
    cwd: jobsCwd,
    encoding: 'utf8',
    timeout: 10 * 60_000,
  })
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim()
  if (run.status === 0) {
    console.log(`PASS: ${label} (${secs}s)`)
    passed++
  } else {
    console.log(`FAIL: ${label} (exit ${run.status ?? run.signal}, ${secs}s)`)
    failed++
  }
  console.log(output.replace(/^/gm, '    '))
}

rmSync(out, { recursive: true, force: true })
console.log(`\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped`)
process.exit(failed === 0 ? 0 : 1)
