#!/usr/bin/env node
/**
 * Launch the desktop app.
 *
 * This exists for one reason: if the shell you start from already has
 * `ELECTRON_RUN_AS_NODE=1` set - which is the case inside any Electron-based
 * terminal or editor - the Electron binary starts as a plain Node process and
 * `require('electron')` resolves to the npm helper package instead of the real
 * API. The app then fails with a confusing "cannot read properties of
 * undefined" on the first Electron call. Stripping the variable here makes
 * `npm run desktop` behave the same everywhere.
 */
const { spawn } = require('node:child_process')
const { join } = require('node:path')

const electron = require('electron')
const root = join(__dirname, '..')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// `npm run smoke` drives the real UI through a real peer and exits with a code.
const args = process.argv.slice(2).filter((a) => a !== '--smoke')
if (process.argv.includes('--smoke')) {
  env.S2S_SMOKE = '1'
  // The smoke test writes real posts, so give it a scratch profile rather than
  // scribbling test data into the account you actually use.
  args.push(`--user-data-dir=${join(require('node:os').tmpdir(), 's2s-smoke')}`)
}

const child = spawn(electron, [root, ...args], {
  stdio: 'inherit',
  env,
  windowsHide: false
})

child.on('close', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error('could not start Electron:', err.message)
  process.exit(1)
})
