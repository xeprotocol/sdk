import { configDefaults, defineConfig } from 'vitest/config'

const browserRun = process.argv.some((arg) => arg.startsWith('--browser'))

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // `@xeprotocol/sdk/jobs` is Node-only (SSH + local fs); the browser job checks the browser-clean entry point.
    exclude: browserRun ? [...configDefaults.exclude, 'test/unit/jobs.test.ts'] : configDefaults.exclude,
    // Proof of work is a brute-force search. The default 5s is not enough on a
    // loaded CI runner, and a flaky timeout here would read as a crypto bug.
    testTimeout: 60_000,
  },
})
