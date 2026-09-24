// 4. Train a small model — a long job, paid for a minute at a time.
//
// Installs scikit-learn, then trains a small neural network on the bundled
// handwritten-digits dataset for EPOCHS passes, printing progress as it goes.
// The trained model and its metrics come home in ./model/.
//
// With the default 400 epochs this runs for several minutes, so the lease is
// renewed many times underneath; every renewal is printed. Ctrl-C stops the
// training, still brings home whatever the script has saved, and releases the
// machine.
//
// The setup step installs from PyPI, so the machine needs outbound internet.
//
//   EPOCHS=400 node 04-train-a-model.ts

import { readFileSync } from 'node:fs'
import { Wallet, Xe, fromMicro } from '@xeprotocol/sdk'
import { runJob } from '@xeprotocol/sdk/jobs'

const EPOCHS = process.env['EPOCHS'] ?? '400'

const xe = new Xe({
  client: 'https://ldn.core.test.network',
  wallet: Wallet.fromSeedHex(readFileSync('wallet.seed', 'utf8').trim()),
  timekeepers: ['https://ldn.core.test.network', 'https://ffm.core.test.network', 'https://nyc.core.test.network'],
})

const train = `
import json, os, pickle, sys, time
import numpy as np
from sklearn.datasets import load_digits
from sklearn.model_selection import train_test_split
from sklearn.neural_network import MLPClassifier

X, y = load_digits(return_X_y=True)
X = X / 16.0
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.25, random_state=1)
model = MLPClassifier(hidden_layer_sizes=(256, 128), learning_rate_init=1e-3, random_state=1)
classes = np.unique(y)
epochs = int(os.environ['EPOCHS'])
os.makedirs('out', exist_ok=True)
best, t0 = 0.0, time.time()

def save(epoch, acc):
    with open('out/model.pkl', 'wb') as f:
        pickle.dump(model, f)
    with open('out/metrics.json', 'w') as f:
        json.dump({'epoch': epoch, 'test_accuracy': acc, 'seconds': round(time.time() - t0, 1)}, f)

for epoch in range(1, epochs + 1):
    for _ in range(20):
        model.partial_fit(X_train, y_train, classes=classes)
    acc = model.score(X_test, y_test)
    if acc > best:
        best = acc
        save(epoch, acc)
    if epoch % 10 == 0:
        print(f'epoch {epoch}/{epochs}  loss {model.loss_:.4f}  test acc {acc:.4f}  best {best:.4f}', flush=True)
print(f'done: best test accuracy {best:.4f}')
`

const stop = new AbortController()
process.once('SIGINT', () => {
  console.log('\nstopping: collecting the best model so far, then releasing the machine')
  stop.abort()
})

const job = await runJob(xe, {
  machine: { vcpus: 2, memoryMb: 2048, diskGb: 4 },
  files: { 'train.py': train },
  setup: 'python3 -m pip install --quiet --user numpy scikit-learn',
  run: 'python3 train.py',
  env: { EPOCHS },
  collect: 'out',
  saveTo: './model',
  timeoutSecs: 60 * 60,
  signal: stop.signal,
  onEvent: (e) => {
    if (e.type === 'leased') console.log(`leased ${e.lease.hash.slice(0, 12)}… on ${e.provider.slice(0, 12)}…`)
    if (e.type === 'started') console.log(`— ${e.step} —`)
    if (e.type === 'stdout' && e.step === 'run') process.stdout.write(e.text)
    if (e.type === 'renewed') console.log(`  (lease renewed: ${e.lease.effectiveDuration}s so far)`)
    if (e.type === 'released') console.log('machine released')
  },
})

console.log(`${job.status} after ${(job.wallMs / 60_000).toFixed(1)} min, paid ${fromMicro(job.paid)} XUSD`)
if (job.files.some((f) => f.path === 'model.pkl')) {
  const metrics = JSON.parse(readFileSync('./model/metrics.json', 'utf8')) as { epoch: number; test_accuracy: number }
  console.log(`model saved to ./model/model.pkl — epoch ${metrics.epoch}, test accuracy ${metrics.test_accuracy.toFixed(4)}`)
} else {
  console.error(`no model came back:\n${job.stderr}`)
  process.exit(1)
}
