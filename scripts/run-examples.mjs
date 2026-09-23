#!/usr/bin/env node
// Run every tutorial's complete program against a live network, in order, in
// both languages — the proof that the tutorials work, not just that they
// type-check.
//
// Programs run from inside this repository, so `@xeprotocol/sdk` resolves to
// the package itself (its built dist/). Each language gets its own directory,
// and so its own wallet.seed, exactly as a reader following along would.
//
// Tutorials 1–4 need nothing: the faucet funds the wallet. Leasing (5–6) is
// paid in XUSD, which the faucet does not hand out, so those run only when
// XE_LEASE_SEED names a wallet that holds some; otherwise they are skipped.
//
//   npm run build && npm run examples:live
//   XE_LEASE_SEED=<hex seed holding XUSD> npm run examples:live
//
// Needs Node 22.6+ (TypeScript runs through Node's own type stripping).

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, '.examples-run')
const FENCE = /^```(ts|js) title="([\w.-]+)"\n([\s\S]*?)^```$/gm
const LEASING = /^0[56]-/
const leaseSeed = process.env['XE_LEASE_SEED']?.trim()

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(`FAIL: Node ${process.versions.node} cannot run the TypeScript tutorials; use 22.6 or newer`)
  process.exit(2)
}

let passed = 0
let failed = 0
let skipped = 0
rmSync(out, { recursive: true, force: true })

for (const lang of ['typescript', 'javascript']) {
  const cwd = join(out, lang)
  mkdirSync(cwd, { recursive: true })
  const dir = join(root, 'examples', lang)
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    for (const [, , file, body] of readFileSync(join(dir, name), 'utf8').matchAll(FENCE)) {
      const label = `${lang}/${name}`
      if (LEASING.test(name) && !leaseSeed) {
        console.log(`SKIP: ${label} — leasing needs XUSD; set XE_LEASE_SEED to run it`)
        skipped++
        continue
      }
      if (LEASING.test(name)) writeFileSync(join(cwd, 'wallet.seed'), leaseSeed, { mode: 0o600 })
      writeFileSync(join(cwd, file), body)

      const started = Date.now()
      const run = spawnSync(
        process.execPath,
        ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', file],
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

rmSync(out, { recursive: true, force: true })
console.log(`\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped`)
process.exit(failed === 0 ? 0 : 1)
