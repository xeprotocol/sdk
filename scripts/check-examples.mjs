#!/usr/bin/env node
// Type-check every complete program in the tutorials against the SDK source.
//
// A tutorial's complete program is a fenced block whose info string carries a
// file name: ```ts title="first-wallet.ts"``` or ```js title="first-wallet.mjs"```.
// Each is written out and checked by tsc with `@xeprotocol/sdk` mapped to
// src/, the TypeScript strictly and the JavaScript with checkJs, so a renamed
// method or a wrong argument in the docs fails here rather than in a reader's
// terminal.
//
//   npm run examples:check

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, '.examples-check')
const FENCE = /^```(ts|js) title="([\w.-]+)"\n([\s\S]*?)^```$/gm

rmSync(out, { recursive: true, force: true })
const programs = []
for (const lang of ['typescript', 'javascript']) {
  const dir = join(root, 'examples', lang)
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const text = readFileSync(join(dir, name), 'utf8')
    for (const [, , file, body] of text.matchAll(FENCE)) {
      const target = join(out, lang, file)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, body)
      programs.push(`${lang}/${name} → ${relative(root, target)}`)
    }
  }
}
if (programs.length === 0) {
  console.error('FAIL: no complete programs found in examples/')
  process.exit(1)
}

// TypeScript at the SDK's own strictness. JavaScript is checked for API misuse
// (wrong methods, wrong arguments) but not for missing annotations it cannot have.
const base = {
  target: 'ES2022',
  lib: ['ES2022'],
  module: 'ESNext',
  moduleResolution: 'Bundler',
  types: ['node'],
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noEmit: true,
  skipLibCheck: true,
  baseUrl: '.',
  paths: { '@xeprotocol/sdk': ['../src/index.ts'] },
}
const configs = {
  'tsconfig.ts.json': { compilerOptions: base, include: ['typescript/*.ts'] },
  'tsconfig.js.json': {
    compilerOptions: { ...base, allowJs: true, checkJs: true, noImplicitAny: false },
    include: ['javascript/*.mjs'],
  },
}

for (const p of programs) console.log(`  ${p}`)
let failed = false
for (const [name, config] of Object.entries(configs)) {
  writeFileSync(join(out, name), JSON.stringify(config))
  try {
    execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['-p', join(out, name)], { stdio: 'inherit' })
  } catch {
    failed = true
  }
}
if (failed) {
  console.error('FAIL: tutorial programs do not type-check against the SDK')
  process.exit(1)
}
rmSync(out, { recursive: true, force: true })
console.log(`PASS: ${programs.length} tutorial programs type-check against the SDK`)
