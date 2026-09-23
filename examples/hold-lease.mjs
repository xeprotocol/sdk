#!/usr/bin/env node
// Rent a machine and keep it for HOLD_MINUTES, paying one minute at a time.
//
// Opens a one-minute lease, then renews it a minute at a time until the term
// reaches HOLD_MINUTES. Nothing beyond the current minute is ever escrowed, so
// stopping (Ctrl-C, or this process dying) releases the machine within a
// minute. Exits non-zero on any failed check.
//
//   npm run build
//   XE_SEED=<consumer seed hex> node examples/hold-lease.mjs
//
// Environment:
//   XE_NODE         node API                       (default https://ldn.core.test.network)
//   XE_TIMEKEEPERS  comma-separated timekeeper APIs (default the three testnet bootstraps)
//   XE_SEED         consumer wallet seed, hex — must hold XUSD
//   XE_PROVIDER     provider address               (default: first with a valid certificate)
//   HOLD_MINUTES    total term                     (default 10)
//   RENEW_SECS      seconds per renewal            (default 60)

import { Wallet, Xe, fromMicro, holdLease, toAddress } from '../dist/index.js'

const NODE = process.env.XE_NODE ?? 'https://ldn.core.test.network'
const TIMEKEEPERS = (
  process.env.XE_TIMEKEEPERS ??
  'https://ldn.core.test.network,https://ffm.core.test.network,https://nyc.core.test.network'
).split(',')
const HOLD_MINUTES = BigInt(process.env.HOLD_MINUTES ?? 10)
const RENEW_SECS = BigInt(process.env.RENEW_SECS ?? 60)
const TOTAL_SECS = HOLD_MINUTES * 60n

let failures = 0
const t0 = Date.now()
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`
const log = (msg) => console.log(`${stamp()} ${msg}`)
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const nsToIso = (ns) => new Date(Number(ns / 1_000_000n)).toISOString()

if (!process.env.XE_SEED) {
  console.error('XE_SEED is required: the consumer wallet seed (hex), funded with XUSD')
  process.exit(2)
}
const xe = new Xe({ client: NODE, wallet: Wallet.fromSeedHex(process.env.XE_SEED), timekeepers: TIMEKEEPERS })

async function pickProvider() {
  if (process.env.XE_PROVIDER) return toAddress(process.env.XE_PROVIDER)
  for (const p of await xe.client.providers()) {
    try {
      const cert = await xe.client.certificate(p.account)
      if (cert.expiresAt === 0n || cert.expiresAt > BigInt(Date.now()) * 1_000_000n) return toAddress(p.account)
    } catch {
      // no certificate: not leasable
    }
  }
  throw new Error('no provider with a valid certificate')
}

async function main() {
  log(`node ${NODE} (${await xe.networkId()}), consumer ${xe.address}`)
  const startXusd = await xe.balance('XUSD')
  log(`XUSD balance ${fromMicro(startXusd)}`)

  const tk = await xe.timekeepers()
  check(tk.nodes.length >= tk.set.threshold, 'timekeepers reachable', `${tk.nodes.length} of ${tk.set.keys.length}, threshold ${tk.set.threshold}`)

  const provider = await pickProvider()
  const accessKey = Wallet.create() // the key the VM will accept for SSH
  const opened = await xe.openLease({
    provider,
    vcpus: 1,
    memoryMb: 1024,
    diskGb: 1,
    durationSecs: RENEW_SECS,
    accessPubKey: accessKey.publicKey,
  })
  log(`lease ${opened.hash} opened with ${provider.slice(0, 12)}…, first minute costs ${fromMicro(opened.cost)} XUSD`)

  const accepted = await xe.waitForLease(opened.hash, ['accepted'], { timeoutMs: 180_000 })
  check(true, 'provider accepted the lease', `started ${nsToIso(accepted.startTime)}, expires ${nsToIso(accepted.effectiveExpiry)}`)

  let stopping = false
  const ac = new AbortController()
  process.once('SIGINT', () => {
    stopping = true
    log('interrupted: no more renewals, the lease runs out at its current expiry')
    ac.abort()
  })

  let lateRenewals = 0
  const result = await holdLease(xe, opened.hash, {
    renewSecs: RENEW_SECS,
    totalSecs: TOTAL_SECS,
    signal: ac.signal,
    onEvent: (e) => {
      if (e.type === 'renewed') {
        const r = e.renewal
        const oldExpiry = e.lease.effectiveExpiry - r.durationSecs * 1_000_000_000n
        const marginS = Number(oldExpiry - r.renewTime) / 1e9
        if (r.renewTime >= oldExpiry) lateRenewals++
        log(
          `renewal ${e.lease.renewals.length}: +${r.durationSecs}s for ${fromMicro(r.cost)} XUSD, ` +
            `attested ${marginS.toFixed(1)}s before expiry, epoch ${r.epoch.epoch}; ` +
            `term now ${e.lease.effectiveDuration}s, expires ${nsToIso(e.lease.effectiveExpiry)}`,
        )
      } else if (e.type === 'retry') {
        log(`retrying renewal (attempt ${e.attempt}): ${e.error.message}`)
      }
    },
  })

  const lease = result.lease
  const wantRenewals = Number((TOTAL_SECS - RENEW_SECS) / RENEW_SECS)
  if (stopping) {
    check(false, 'held for the full term', `stopped by the user after ${lease.effectiveDuration}s`)
  } else {
    check(result.reason === 'target-reached', 'hold reached its target term', `${lease.effectiveDuration}s of ${TOTAL_SECS}s`)
    check(lease.renewals.length === wantRenewals, `lease renewed ${wantRenewals} times`, `${lease.renewals.length} renewals on the ledger`)
  }
  check(lateRenewals === 0, 'every renewal attested before the expiry it extended')
  check(lease.state === 'accepted', 'lease stayed accepted across every renewal boundary', lease.state)
  const gaps = lease.renewals.every((r, i) => {
    const expiry = lease.startTime + (lease.duration + lease.renewals.slice(0, i).reduce((s, x) => s + x.duration, 0n)) * 1_000_000_000n
    return r.startTime < expiry
  })
  check(gaps, 'no gap in coverage: each segment was bought while the last was live')

  const escrow = lease.renewals.reduce((s, r) => s + r.cost, lease.cost)
  log(`total escrowed ${fromMicro(escrow)} XUSD for ${lease.effectiveDuration}s; waiting for expiry and settlement…`)

  const settleDeadline = Number(lease.effectiveExpiry / 1_000_000n) + 5 * 60_000
  const settled = await xe.waitForLease(opened.hash, ['settled'], {
    timeoutMs: Math.max(settleDeadline - Date.now(), 60_000),
    intervalMs: 5_000,
  })
  check(settled.state === 'settled', 'provider settled the lease after the full term', `state ${settled.state}`)
  const spent = startXusd - (await xe.balance('XUSD'))
  check(spent === escrow, 'consumer paid exactly the escrowed minutes', `${fromMicro(spent)} XUSD`)
  const heldMin = ((Date.now() - t0) / 60_000).toFixed(1)
  log(`lease ${opened.hash} held ${lease.effectiveDuration}s in ${lease.renewals.length + 1} one-minute segments (${heldMin} min wall clock)`)
}

main()
  .catch((err) => {
    check(false, 'hold-lease run', err?.stack ?? String(err))
  })
  .finally(() => {
    console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures})`)
    process.exit(failures === 0 ? 0 : 1)
  })
