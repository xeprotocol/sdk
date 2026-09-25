// 2. Site check — how fast is a website, seen from somewhere else?
//
// Runs the same job on every leasable provider at once: fetch a URL a number of
// times with curl and report, per phase (DNS, TCP connect, TLS, first byte,
// total), the median and worst time. Each provider is a different vantage
// point, so the table shows how the site looks from each.
//
// Starts by quoting every provider's price for the machine, and gives each job
// its own budget: every provider sends its own bill.
//
// The job's result is its stdout — one JSON line per request — so nothing is
// uploaded or collected. Needs the machines to have outbound internet.
//
//   node 02-site-check.ts https://example.com 20

import { readFileSync } from 'node:fs'
import { Wallet, Xe, fromMicro, toMicro } from '@xeprotocol/sdk'
import { runJob } from '@xeprotocol/sdk/jobs'

const URL = process.argv[2] ?? 'https://example.com'
const SAMPLES = Number(process.argv[3] ?? 10)

const xe = new Xe({
  client: 'https://ldn.core.test.network',
  wallet: Wallet.fromSeedHex(readFileSync('wallet.seed', 'utf8').trim()),
  timekeepers: ['https://ldn.core.test.network', 'https://ffm.core.test.network', 'https://nyc.core.test.network'],
})

// curl's own timers, cumulative from the start of the request, in seconds.
const FORMAT =
  '{"code":%{http_code},"ip":"%{remote_ip}","dns":%{time_namelookup},"connect":%{time_connect},' +
  '"tls":%{time_appconnect},"firstByte":%{time_starttransfer},"total":%{time_total},"bytes":%{size_download}}\\n'

interface Sample { code: number; ip: string; dns: number; connect: number; tls: number; firstByte: number; total: number; bytes: number }

const machine = { vcpus: 1, memoryMb: 512, diskGb: 1 }
const quotes = await xe.quote(machine)
for (const q of quotes) console.log(`${q.provider.slice(0, 12)}…  ${fromMicro(q.pricePerMinute)} XUSD/min`)
console.log(`checking ${URL} ×${SAMPLES} from ${quotes.length} provider(s)…`)

const jobs = await Promise.all(
  quotes.map((q) =>
    runJob(xe, {
      machine,
      provider: q.provider,
      maxPricePerMinute: q.pricePerMinute, // the price just quoted, and no more
      budget: toMicro('0.01'),
      env: { URL, SAMPLES: String(SAMPLES) },
      run: `for i in $(seq "$SAMPLES"); do curl -s -o /dev/null --max-time 15 -w '${FORMAT}' "$URL"; sleep 0.5; done`,
      timeoutSecs: 300,
    }),
  ),
)

const ms = (s: number) => `${(s * 1000).toFixed(0)}ms`.padStart(7)
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
const worst = (xs: number[]) => Math.max(...xs)

for (const job of jobs) {
  console.log(`\nprovider ${job.provider.slice(0, 12)}… — ${job.status}, paid ${fromMicro(job.paid)} XUSD`)
  if (job.status !== 'succeeded') {
    console.log(job.stderr.trim())
    continue
  }
  const samples: Sample[] = job.stdout.trim().split('\n').map((line) => JSON.parse(line) as Sample)
  const failed = samples.filter((s) => s.code === 0 || s.code >= 500).length
  console.log(`  ${samples.length} requests to ${samples[0]?.ip}, ${failed} failed, HTTP ${[...new Set(samples.map((s) => s.code))].join('/')}`)
  console.log('  phase          median    worst')
  // Each phase's own duration: the gap between curl's cumulative timers.
  const phases: [string, (s: Sample) => number][] = [
    ['dns', (s) => s.dns],
    ['tcp connect', (s) => s.connect - s.dns],
    ['tls', (s) => (s.tls > 0 ? s.tls - s.connect : 0)],
    ['server wait', (s) => s.firstByte - Math.max(s.tls, s.connect)],
    ['download', (s) => s.total - s.firstByte],
    ['total', (s) => s.total],
  ]
  for (const [name, pick] of phases) {
    const xs = samples.map(pick)
    console.log(`  ${name.padEnd(12)} ${ms(median(xs))}  ${ms(worst(xs))}`)
  }
}
