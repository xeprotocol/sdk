import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Proof of work is a brute-force search. The default 5s is not enough on a
    // loaded CI runner, and a flaky timeout here would read as a crypto bug.
    testTimeout: 60_000,
  },
})
