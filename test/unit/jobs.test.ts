import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const sshMocks = vi.hoisted(() => ({
  exec: vi.fn(),
  listRemote: vi.fn(),
  openMachineSession: vi.fn(),
  opensshPrivateKey: vi.fn(() => 'FAKE-KEY'),
  readRemote: vi.fn(),
  sftp: vi.fn(),
  writeRemote: vi.fn(),
}))

vi.mock('../../src/jobs/ssh.js', () => sshMocks)

import type { LeaseRecord } from '../../src/client.js'
import { XeUsageError } from '../../src/errors.js'
import { runJob } from '../../src/jobs/index.js'
import { toAddress, toHash } from '../../src/types.js'
import type { Xe } from '../../src/xe.js'

const PROVIDER = toAddress('c'.repeat(64))
const LEASE_HASH = toHash('a'.repeat(64))

function fakeSession() {
  const start = BigInt(Date.now()) * 1_000_000n
  const lease: LeaseRecord = {
    hash: LEASE_HASH,
    state: 'accepted',
    consumer: toAddress('b'.repeat(64)),
    provider: PROVIDER,
    vcpus: 1n,
    memoryMb: 1024n,
    diskGb: 1n,
    duration: 60n,
    cost: 500n,
    startTime: start,
    settled: false,
    certificateHash: '',
    renewals: [],
    effectiveDuration: 60n,
    effectiveExpiry: start + 60_000_000_000n,
    raw: {},
  }

  const commands: string[] = []
  const writes: Array<{ path: string; data: string | Uint8Array; mode?: number }> = []
  const listedDirs: string[] = []
  const readPaths: string[] = []

  sshMocks.openMachineSession.mockResolvedValue({ vm: {}, close: vi.fn() })
  sshMocks.sftp.mockResolvedValue({})
  sshMocks.exec.mockImplementation(async (_vm: unknown, cmd: string) => {
    commands.push(cmd)
    return { code: 0, signal: undefined }
  })
  sshMocks.writeRemote.mockImplementation(async (_s: unknown, path: string, data: string | Uint8Array, mode?: number) => {
    writes.push(mode === undefined ? { path, data } : { path, data, mode })
  })
  sshMocks.listRemote.mockImplementation(async (_s: unknown, dir: string) => {
    listedDirs.push(dir)
    return ['nested/result.txt']
  })
  sshMocks.readRemote.mockImplementation(async (_s: unknown, path: string) => {
    readPaths.push(path)
    return new TextEncoder().encode('ok\n')
  })

  const quote = vi.fn(async () => [{ provider: PROVIDER, pricePerMinute: 500n, freeVcpus: 4n, freeMemoryMb: 4096n, freeDiskGb: 20n }])
  const rentLease = vi.fn(async () => ({ opened: { hash: LEASE_HASH, accepted: true, cost: 500n, certificate: {} as never }, lease, attempts: 1 }))

  const xe = {
    quote,
    rentLease,
    waitForLease: async () => lease,
    lease: async () => lease,
    openingPricePerMinute: async () => 500n,
    renewLease: async () => {
      throw new Error('unexpected renewal in 1-minute job test')
    },
  } as unknown as Xe

  return { xe, quote, rentLease, commands, writes, listedDirs, readPaths }
}

describe('runJob POSIX guest paths vs host saveTo paths', () => {
  it('constructs POSIX /root/job paths for mkdir, SFTP uploads, and collection even with Windows backslash keys', async () => {
    const { xe, commands, writes, listedDirs, readPaths } = fakeSession()
    const saveDir = await mkdtemp(join(tmpdir(), 'xe-job-test-'))

    try {
      const result = await runJob(xe, {
        machine: { vcpus: 1, memoryMb: 1024, diskGb: 1 },
        timeoutSecs: 30,
        files: {
          'input.txt': 'hello',
          'src/run.py': 'print(1)',
          'win\\sub\\data.bin': new Uint8Array([1, 2, 3]),
        },
        run: 'python3 src/run.py',
        collect: 'artifacts\\out/',
        saveTo: saveDir,
      })

      expect(result.status).toBe('succeeded')
      expect(commands[0]).toBe("mkdir -p '/root/job' '/root/job/src' '/root/job/win/sub'")
      for (const cmd of commands) {
        expect(cmd).not.toContain('\\root\\job')
      }

      const uploadedPaths = writes.map((w) => w.path)
      expect(uploadedPaths).toEqual([
        '/root/job/input.txt',
        '/root/job/src/run.py',
        '/root/job/win/sub/data.bin',
        '/root/job/.xe-run.sh',
      ])
      for (const p of uploadedPaths) {
        expect(p.startsWith('/root/job/')).toBe(true)
        expect(p).not.toContain('\\')
      }

      expect(listedDirs).toEqual(['/root/job/artifacts/out'])
      expect(readPaths).toEqual(['/root/job/artifacts/out/nested/result.txt'])

      const saved = await readFile(join(saveDir, 'nested', 'result.txt'), 'utf8')
      expect(saved).toBe('ok\n')
    } finally {
      await rm(saveDir, { recursive: true, force: true })
    }
  })

  it('allows collecting from "." (the job root) as POSIX /root/job', async () => {
    const { xe, listedDirs, readPaths } = fakeSession()
    await runJob(xe, {
      machine: { vcpus: 1, memoryMb: 1024, diskGb: 1 },
      timeoutSecs: 10,
      run: 'true',
      collect: '.',
    })
    expect(listedDirs).toEqual(['/root/job'])
    expect(readPaths).toEqual(['/root/job/nested/result.txt'])
  })

  it('rejects invalid, escaping, or duplicate remote paths with XeUsageError before quoting or renting a lease', async () => {
    const badFiles: Array<Record<string, string>> = [
      { '': 'empty' },
      { '.': 'dot' },
      { 'dir/': 'trailing-slash' },
      { 'dir/.': 'dot-segment' },
      { 'dir/sub/..': 'dotdot-segment' },
      { '/etc/passwd': 'abs-posix' },
      { '\\Windows\\win.ini': 'abs-win' },
      { '../outside.txt': 'dotdot' },
      { 'a/../../outside.txt': 'nested-dotdot' },
      { 'a\\..\\..\\outside.txt': 'win-dotdot' },
      { '../job2/file.txt': 'sibling-prefix' },
      { 'bad\0name.txt': 'nul' },
      { 'src/a.txt': '1', 'src\\a.txt': '2' },
    ]

    for (const files of badFiles) {
      const { xe, quote, rentLease } = fakeSession()
      await expect(
        runJob(xe, {
          machine: { vcpus: 1, memoryMb: 1024, diskGb: 1 },
          timeoutSecs: 10,
          files,
          run: 'true',
        }),
      ).rejects.toThrow(XeUsageError)
      expect(quote).not.toHaveBeenCalled()
      expect(rentLease).not.toHaveBeenCalled()
    }

    for (const collect of ['/etc', '\\etc', '..', '../job2', 'out\0bad']) {
      const { xe, quote, rentLease } = fakeSession()
      await expect(
        runJob(xe, {
          machine: { vcpus: 1, memoryMb: 1024, diskGb: 1 },
          timeoutSecs: 10,
          run: 'true',
          collect,
        }),
      ).rejects.toThrow(XeUsageError)
      expect(quote).not.toHaveBeenCalled()
      expect(rentLease).not.toHaveBeenCalled()
    }
  })
})
