// 1. Hello, world — the smallest job.
//
// Rent a small machine, run one command, print what it said, and hand the
// machine back. Takes about a minute and costs one billing minute.
//
//   node 01-hello-world.ts

import { readFileSync } from 'node:fs'
import { Wallet, Xe, fromMicro } from '@xeprotocol/sdk'
import { runJob } from '@xeprotocol/sdk/jobs'

const xe = new Xe({
  client: 'https://ldn.core.test.network',
  wallet: Wallet.fromSeedHex(readFileSync('wallet.seed', 'utf8').trim()),
  timekeepers: ['https://ldn.core.test.network', 'https://ffm.core.test.network', 'https://nyc.core.test.network'],
})

const job = await runJob(xe, {
  machine: { vcpus: 1, memoryMb: 1024, diskGb: 1 },
  run: 'echo "hello from $(hostname)"; uname -srm; nproc; free -m | head -2',
})

console.log(job.stdout)
console.log(`${job.status} on ${job.provider.slice(0, 12)}… in ${(job.wallMs / 1000).toFixed(1)}s for ${fromMicro(job.paid)} XUSD`)
