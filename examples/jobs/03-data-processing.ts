// 3. Data processing — send a dataset, get a report back.
//
// Generates a sales ledger locally (a stand-in for your own data), uploads it
// with a processing script, and brings home what the script writes to out/:
// a per-region, per-month summary as CSV and the headline numbers as JSON.
//
// Uses only the Python standard library on the machine, so it needs no
// internet there. The price ceiling rules out any provider dearer than
// 0.002 XUSD a minute; the budget caps the whole job at 0.02 XUSD.
//
//   ROWS=500000 node 03-data-processing.ts

import { readFileSync } from 'node:fs'
import { Wallet, Xe, fromMicro, toMicro } from '@xeprotocol/sdk'
import { runJob } from '@xeprotocol/sdk/jobs'

const ROWS = Number(process.env['ROWS'] ?? 200_000)

const xe = new Xe({
  client: 'https://ldn.core.test.network',
  wallet: Wallet.fromSeedHex(readFileSync('wallet.seed', 'utf8').trim()),
  timekeepers: ['https://ldn.core.test.network', 'https://ffm.core.test.network', 'https://nyc.core.test.network'],
})

// Your data would come from a file; this makes some up.
const regions = ['north', 'south', 'east', 'west']
const products = ['widget', 'gadget', 'gizmo', 'doohickey', 'sprocket']
const lines = ['date,region,product,units,unit_price']
for (let i = 0; i < ROWS; i++) {
  const day = new Date(Date.UTC(2026, 0, 1) + Math.floor(Math.random() * 365) * 86_400_000)
  lines.push(
    [
      day.toISOString().slice(0, 10),
      regions[i % regions.length],
      products[Math.floor(Math.random() * products.length)],
      1 + Math.floor(Math.random() * 20),
      (5 + Math.random() * 95).toFixed(2),
    ].join(','),
  )
}
const sales = lines.join('\n') + '\n'

const summarise = `
import csv, json, os, time
from collections import defaultdict

t0 = time.time()
revenue = defaultdict(float)
units = defaultdict(int)
by_product = defaultdict(float)
rows = 0
with open('sales.csv', newline='') as f:
    for r in csv.DictReader(f):
        key = (r['region'], r['date'][:7])
        amount = int(r['units']) * float(r['unit_price'])
        revenue[key] += amount
        units[key] += int(r['units'])
        by_product[r['product']] += amount
        rows += 1

os.makedirs('out', exist_ok=True)
with open('out/summary.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['region', 'month', 'units', 'revenue'])
    for (region, month) in sorted(revenue):
        w.writerow([region, month, units[(region, month)], f'{revenue[(region, month)]:.2f}'])

top = max(by_product, key=by_product.get)
with open('out/report.json', 'w') as f:
    json.dump({'rows': rows, 'revenue': round(sum(revenue.values()), 2), 'top_product': top,
               'seconds': round(time.time() - t0, 2)}, f, indent=2)
print(f'processed {rows} rows in {time.time() - t0:.2f}s')
`

const job = await runJob(xe, {
  machine: { vcpus: 1, memoryMb: 1024, diskGb: 1 },
  files: { 'sales.csv': sales, 'summarise.py': summarise },
  run: 'python3 summarise.py',
  collect: 'out',
  saveTo: './results',
  maxPricePerMinute: toMicro('0.002'),
  budget: toMicro('0.02'),
  onEvent: (e) => {
    if (e.type === 'uploaded') console.log(`uploaded ${e.files} files, ${(e.bytes / 1e6).toFixed(1)} MB`)
    if (e.type === 'stdout') process.stdout.write(e.text)
    if (e.type === 'collected') console.log(`collected ${e.files.map((f) => f.path).join(', ')}`)
  },
})

if (job.status !== 'succeeded') {
  console.error(`job ${job.status} (exit ${job.exitCode}):\n${job.stderr}`)
  process.exit(1)
}

const report = JSON.parse(readFileSync('./results/report.json', 'utf8')) as { rows: number; revenue: number; top_product: string }
console.log(`${report.rows} rows → revenue ${report.revenue.toLocaleString()}, best seller: ${report.top_product}`)
console.log(`summary in ./results/summary.csv — job took ${(job.wallMs / 1000).toFixed(1)}s, paid ${fromMicro(job.paid)} XUSD`)
