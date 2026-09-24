import ssh2 from 'ssh2'
import type { Client as SshClient, ClientChannel, SFTPWrapper } from 'ssh2'

import { hexToBytes } from '../hex.js'
import type { Hash } from '../types.js'
import type { Wallet } from '../wallet.js'

const { Client } = ssh2

export type { SshClient, SFTPWrapper }

function sshString(bytes: Uint8Array): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(bytes.length)
  return Buffer.concat([len, bytes])
}

/**
 * An unencrypted OpenSSH private-key file for a wallet's ed25519 key.
 *
 * A lease's access key is an XE wallet key; the VM trusts its public half as
 * an `ssh-ed25519` key, so the same seed signs the SSH login.
 */
export function opensshPrivateKey(key: Wallet): string {
  const type = Buffer.from('ssh-ed25519')
  const seed = hexToBytes(key.seedHex())
  const pub = hexToBytes(key.publicKey)
  const pubBlob = Buffer.concat([sshString(type), sshString(pub)])
  const check = Buffer.alloc(4)
  check.writeUInt32BE(0x78656a62)
  let priv = Buffer.concat([
    check,
    check,
    sshString(type),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(Buffer.from('xe-job')),
  ])
  const pad: number[] = []
  for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i)
  priv = Buffer.concat([priv, Buffer.from(pad)])
  const nkeys = Buffer.alloc(4)
  nkeys.writeUInt32BE(1)
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString(Buffer.from('none')),
    sshString(Buffer.from('none')),
    sshString(Buffer.alloc(0)),
    nkeys,
    sshString(pubBlob),
    sshString(priv),
  ])
  const lines = body.toString('base64').match(/.{1,70}/g) ?? []
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`
}

function connect(options: ssh2.ConnectConfig): Promise<SshClient> {
  return new Promise((resolve, reject) => {
    const c = new Client()
    c.once('ready', () => resolve(c))
      .once('error', reject)
      .connect({ readyTimeout: 30_000, keepaliveInterval: 10_000, ...options })
  })
}

/** A session on the leased machine: the gateway hop, and the machine's own sshd inside it. */
export interface MachineSession {
  vm: SshClient
  close(): void
}

/**
 * Reach a leased machine through the network's SSH gateway.
 *
 * Two hops: the gateway authenticates the lease (username = lease hash, key =
 * the lease's access key) and forwards a stream to the machine's sshd; the SDK
 * then logs in to the machine itself as root with the same key, end to end.
 */
export async function openMachineSession(gateway: { host: string; port: number }, lease: Hash, key: string): Promise<MachineSession> {
  const gw = await connect({ host: gateway.host, port: gateway.port, username: lease, privateKey: key })
  try {
    const stream = await new Promise<ClientChannel>((resolve, reject) =>
      gw.forwardOut('127.0.0.1', 0, '127.0.0.1', 22, (err, s) => (err ? reject(err) : resolve(s))),
    )
    const vm = await connect({ sock: stream, username: 'root', privateKey: key })
    return {
      vm,
      close: () => {
        vm.end()
        gw.end()
      },
    }
  } catch (err) {
    gw.end()
    throw err
  }
}

export interface ExecResult {
  code: number | null
  signal: string | undefined
}

/** Run a command, streaming its output; resolves when the remote process exits. */
export function exec(
  vm: SshClient,
  command: string,
  onStdout: (text: string) => void,
  onStderr: (text: string) => void,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    vm.exec(command, (err, stream) => {
      if (err) return reject(err)
      const out = new TextDecoder()
      const errs = new TextDecoder()
      let result: ExecResult | undefined
      stream.on('exit', (code: number | null, signal?: string) => {
        result = { code, signal }
      })
      stream.on('data', (d: Buffer) => onStdout(out.decode(d, { stream: true })))
      stream.stderr.on('data', (d: Buffer) => onStderr(errs.decode(d, { stream: true })))
      stream.on('close', () => {
        if (result) resolve(result)
        else reject(new Error('connection to the machine closed before the command exited'))
      })
    })
  })
}

export function sftp(vm: SshClient): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => vm.sftp((err, s) => (err ? reject(err) : resolve(s))))
}

export function writeRemote(s: SFTPWrapper, path: string, data: string | Uint8Array, mode = 0o644): Promise<void> {
  const body = typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return new Promise((resolve, reject) => s.writeFile(path, body, { mode }, (err) => (err ? reject(err) : resolve())))
}

export function readRemote(s: SFTPWrapper, path: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => s.readFile(path, (err, data) => (err ? reject(err) : resolve(new Uint8Array(data)))))
}

/** Every regular file under `dir`, relative to it. Empty if `dir` does not exist. */
export async function listRemote(s: SFTPWrapper, dir: string): Promise<string[]> {
  const entries = await new Promise<ssh2.FileEntryWithStats[] | undefined>((resolve, reject) =>
    s.readdir(dir, (err, list) => {
      if (err) return (err as { code?: number }).code === 2 ? resolve(undefined) : reject(err)
      resolve(list)
    }),
  )
  if (!entries) return []
  const files: string[] = []
  for (const e of entries) {
    if (e.filename === '.' || e.filename === '..') continue
    if (e.attrs.isDirectory()) {
      for (const f of await listRemote(s, `${dir}/${e.filename}`)) files.push(`${e.filename}/${f}`)
    } else if (e.attrs.isFile()) {
      files.push(e.filename)
    }
  }
  return files
}
