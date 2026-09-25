/**
 * Jobs: run your code on a rented machine and get the results back.
 *
 * Node-only — it speaks SSH, which browsers cannot — so it lives at
 * `@xeprotocol/sdk/jobs`, apart from the browser-clean main entry point.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { LeaseRecord } from '../client.js'
import { XeBudgetError, XeError, XePriceError, XeUsageError } from '../errors.js'
import { holdLease, type HoldResult } from '../hold.js'
import { pricePerMinute } from '../lease.js'
import type { Address, Hash } from '../types.js'
import { Wallet } from '../wallet.js'
import { leasePaid, type Xe } from '../xe.js'
import { exec, listRemote, openMachineSession, opensshPrivateKey, readRemote, sftp, writeRemote, type MachineSession } from './ssh.js'

/** The public testnet's SSH gateway. */
export const TESTNET_GATEWAY = 'ldn.test.network:2222'

const JOB_DIR = '/root/job'
/** Stop the job this long before the paid time runs out, leaving time to bring its files home. */
const STOP_MARGIN_MS = 20_000
/** How long to keep trying to reach a machine that is still booting. */
const CONNECT_PATIENCE_MS = 120_000

export interface JobMachine {
  vcpus: number
  memoryMb: number
  diskGb: number
}

export interface JobOptions {
  machine: JobMachine
  /** Default: the cheapest provider that can take the machine within `maxPricePerMinute`. */
  provider?: Address
  /** micro-XUSD per minute. Refuse dearer providers; also the renewal ceiling (default: the opening price). */
  maxPricePerMinute?: bigint
  /** micro-XUSD the whole job may cost. A job needs this or `timeoutSecs`. */
  budget?: bigint
  /** Written into the job directory before anything runs. Paths are relative to it. */
  files?: Record<string, string | Uint8Array>
  /** Shell, run first in the job directory; its failure fails the job. */
  setup?: string
  /** Shell, run in the job directory. */
  run: string
  env?: Record<string, string>
  /** Directory (relative to the job directory) brought home. Default `out`. */
  collect?: string
  /** Local directory the collected files are written to. Default: kept in memory only. */
  saveTo?: string
  /** Wall-clock limit for setup + run, in seconds. A job needs this or `budget`. */
  timeoutSecs?: number
  /** Abort to stop the job; what it has written is still collected, and the machine released. */
  signal?: AbortSignal
  /** The network's SSH gateway, `host:port`. Default: the public testnet's. */
  gateway?: string
  onEvent?: (event: JobEvent) => void
}

export interface CollectedFile {
  path: string
  bytes: Uint8Array
}

export type JobStep = 'setup' | 'run'

export type JobEvent =
  | { type: 'leased'; lease: LeaseRecord; provider: Address }
  | { type: 'connected' }
  | { type: 'uploaded'; files: number; bytes: number }
  | { type: 'started'; step: JobStep }
  | { type: 'stdout' | 'stderr'; text: string; step: JobStep }
  | { type: 'renewed'; lease: LeaseRecord }
  | { type: 'collected'; files: CollectedFile[] }
  | { type: 'released'; lease: LeaseRecord }

export type JobStatus = 'succeeded' | 'failed' | 'timed-out' | 'aborted' | 'budget-reached' | 'price-changed'

export interface JobResult {
  status: JobStatus
  /** null when the process never exited on its own. */
  exitCode: number | null
  stdout: string
  stderr: string
  files: CollectedFile[]
  lease: Hash
  provider: Address
  wallMs: number
  /** micro-XUSD per minute the job opened at. */
  pricePerMinute: bigint
  billedMinutes: number
  /** micro-XUSD: first minute + every renewal. */
  paid: bigint
}

export type JobStage = 'lease' | 'connect' | 'upload' | 'run' | 'collect'

/** The platform failed the job — not your code. `stage` says where; `lease`, if one was opened, what to look up. */
export class JobError extends XeError {
  override readonly name = 'JobError'
  readonly stage: JobStage
  readonly lease: Hash | undefined

  constructor(stage: JobStage, message: string, lease?: Hash, cause?: unknown) {
    super(`job failed at ${stage}: ${message}`, cause === undefined ? undefined : { cause })
    this.stage = stage
    this.lease = lease
  }
}

type StopReason = Exclude<JobStatus, 'succeeded' | 'failed'> | 'lease-lost'

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Rent a machine, upload files, run a command, collect results, and release
 * the machine — always, on success or failure. The lease is held open a
 * minute at a time while the job runs, within `maxPricePerMinute` and `budget`.
 *
 * Resolves with a `status` for anything your code did or a limit ended.
 * Rejects with `JobError` when the platform failed, `XePriceError` when every
 * provider is dearer than the ceiling, and `XeUsageError` for a job with no
 * limit, all before anything is spent where possible.
 */
export async function runJob(xe: Xe, options: JobOptions): Promise<JobResult> {
  if (options.budget === undefined && options.timeoutSecs === undefined) {
    throw new XeUsageError('runJob: a job needs a budget or a timeoutSecs, so it cannot run up an unlimited bill')
  }
  const t0 = Date.now()
  const emit = options.onEvent ?? (() => {})
  const [host = '', port = '22'] = (options.gateway ?? TESTNET_GATEWAY).split(':')
  const gateway = { host, port: Number(port) }
  const dims = { vcpus: BigInt(options.machine.vcpus), memoryMb: BigInt(options.machine.memoryMb), diskGb: BigInt(options.machine.diskGb) }

  // Price the first minute before anything is signed.
  let provider: Address
  let price: bigint
  if (options.provider) {
    provider = options.provider
    const cert = await xe.client.certificate(provider).catch((err: unknown) => {
      throw new JobError('lease', `provider has no current certificate: ${message(err)}`, undefined, err)
    })
    price = pricePerMinute(dims, cert.priceMultiplierMilli)
  } else {
    const [best] = await xe.quote(dims)
    if (!best) throw new JobError('lease', 'no provider can take this machine right now (none has a valid certificate and the free capacity)')
    provider = best.provider
    price = best.pricePerMinute
  }
  if (options.maxPricePerMinute !== undefined && price > options.maxPricePerMinute) {
    throw new XePriceError(provider, price, options.maxPricePerMinute)
  }
  if (options.budget !== undefined && price > options.budget) throw new XeBudgetError(0n, price, options.budget)

  const access = Wallet.create()
  const key = opensshPrivateKey(access)
  let lease: LeaseRecord
  try {
    ;({ lease } = await xe.rentLease({
      provider,
      ...dims,
      durationSecs: 60,
      accessPubKey: access.publicKey,
      ...(options.maxPricePerMinute === undefined ? {} : { maxPricePerMinute: options.maxPricePerMinute }),
    }))
  } catch (err) {
    if (err instanceof XePriceError) throw err
    throw new JobError('lease', message(err), undefined, err)
  }
  emit({ type: 'leased', lease, provider })

  // From here on the machine is ours, a minute at a time, until `release`.
  let stopReason: StopReason | undefined
  let session: MachineSession | undefined
  let killRemote: (() => Promise<void>) | undefined
  const stop = (reason: StopReason) => {
    if (stopReason) return
    stopReason = reason
    void killRemote?.().catch(() => {})
  }
  const stopBeforeExpiry = (l: LeaseRecord, reason: StopReason) => {
    const at = Number(l.effectiveExpiry / 1_000_000n) - STOP_MARGIN_MS
    setTimeout(() => stop(reason), Math.max(0, at - Date.now())).unref()
  }

  const holdStop = new AbortController()
  const hold: Promise<HoldResult | Error> = holdLease(xe, lease.hash, {
    renewSecs: 60,
    signal: holdStop.signal,
    ...(options.maxPricePerMinute === undefined ? {} : { maxPricePerMinute: options.maxPricePerMinute }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    onEvent: (e) => {
      if (e.type === 'renewed') {
        lease = e.lease
        emit({ type: 'renewed', lease: e.lease })
      }
    },
  }).then(
    (r) => {
      if (r.reason === 'price-changed' || r.reason === 'budget-reached') stopBeforeExpiry(r.lease, r.reason)
      return r
    },
    (err: unknown) => {
      stopBeforeExpiry(lease, 'lease-lost')
      return err instanceof Error ? err : new Error(String(err))
    },
  )

  const onAbort = () => stop('aborted')
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) stop('aborted')

  let stdout = ''
  let stderr = ''
  let exitCode: number | null = null
  let status: JobStatus = 'succeeded'
  const files: CollectedFile[] = []
  let failure: JobError | undefined
  let timer: NodeJS.Timeout | undefined

  try {
    // Connect: the machine may still be booting.
    const connectBy = Date.now() + CONNECT_PATIENCE_MS
    for (;;) {
      if (stopReason) break
      try {
        session = await openMachineSession(gateway, lease.hash, key)
        break
      } catch (err) {
        if (Date.now() >= connectBy) throw new JobError('connect', `could not reach the machine: ${message(err)}`, lease.hash, err)
        await sleep(5_000)
      }
    }
    if (session) emit({ type: 'connected' })
    const vm = session?.vm
    const remote = vm && !stopReason ? await sftp(vm) : undefined

    if (vm && remote && !stopReason) {
      try {
        const upload = Object.entries(options.files ?? {})
        const dirs = new Set([JOB_DIR, ...upload.map(([p]) => dirname(join(JOB_DIR, p)))])
        await exec(vm, `mkdir -p ${[...dirs].map(quote).join(' ')}`, () => {}, () => {})
        let bytes = 0
        for (const [path, data] of upload) {
          await writeRemote(remote, join(JOB_DIR, path), data)
          bytes += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
        }
        const env = Object.entries({ DEBIAN_FRONTEND: 'noninteractive', ...options.env })
          .map(([k, v]) => `export ${k}=${quote(v)}`)
          .join('\n')
        for (const step of ['setup', 'run'] as const) {
          const command = step === 'setup' ? options.setup : options.run
          if (command !== undefined) await writeRemote(remote, `${JOB_DIR}/.xe-${step}.sh`, `cd ${JOB_DIR}\n${env}\n${command}\n`, 0o700)
        }
        emit({ type: 'uploaded', files: upload.length, bytes })
      } catch (err) {
        throw new JobError('upload', message(err), lease.hash, err)
      }

      // Each step runs in its own session so the whole process tree can be stopped.
      killRemote = async () => {
        await exec(vm, `p=$(cat ${JOB_DIR}/.xe-pid 2>/dev/null) && { kill -TERM -- -$p; sleep 3; kill -KILL -- -$p; } 2>/dev/null; true`, () => {}, () => {})
      }
      if (options.timeoutSecs !== undefined) timer = setTimeout(() => stop('timed-out'), options.timeoutSecs * 1000)
      if (stopReason) void killRemote()

      for (const step of ['setup', 'run'] as const) {
        if (stopReason || (step === 'setup' ? options.setup : options.run) === undefined) continue
        emit({ type: 'started', step })
        let result
        try {
          result = await exec(
            vm,
            `cd ${JOB_DIR} && { setsid bash .xe-${step}.sh < /dev/null & echo $! > .xe-pid; wait $!; }`,
            (text) => {
              stdout += text
              emit({ type: 'stdout', text, step })
            },
            (text) => {
              stderr += text
              emit({ type: 'stderr', text, step })
            },
          )
        } catch (err) {
          if (stopReason === 'lease-lost') break
          throw new JobError('run', message(err), lease.hash, err)
        }
        if (stopReason) break
        exitCode = result.code
        if (result.code !== 0) {
          status = 'failed'
          break
        }
      }

      if (stopReason && stopReason !== 'lease-lost') {
        status = stopReason
        exitCode = null
      }

      try {
        const dir = `${JOB_DIR}/${options.collect ?? 'out'}`
        for (const path of await listRemote(remote, dir)) {
          files.push({ path, bytes: await readRemote(remote, `${dir}/${path}`) })
        }
        if (options.saveTo) {
          for (const f of files) {
            const target = join(options.saveTo, f.path)
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, f.bytes)
          }
        }
        emit({ type: 'collected', files })
      } catch (err) {
        throw new JobError('collect', message(err), lease.hash, err)
      }
    } else if (stopReason && stopReason !== 'lease-lost') {
      status = stopReason
    }
    if (stopReason === 'lease-lost') {
      const held = await hold
      failure = new JobError('run', `the lease could not be kept open: ${held instanceof Error ? held.message : held.reason}`, lease.hash, held)
    }
  } catch (err) {
    failure = err instanceof JobError ? err : new JobError('run', message(err), lease.hash, err)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    session?.close()
    holdStop.abort()
    await hold
  }

  // Released: nothing renews it any more; it runs out at the end of the minute already paid.
  const final = await xe.lease(lease.hash).catch(() => lease)
  emit({ type: 'released', lease: final })
  if (failure) throw failure
  return {
    status,
    exitCode,
    stdout,
    stderr,
    files,
    lease: lease.hash,
    provider,
    wallMs: Date.now() - t0,
    pricePerMinute: price,
    billedMinutes: Number(final.effectiveDuration / 60n),
    paid: leasePaid(final),
  }
}
