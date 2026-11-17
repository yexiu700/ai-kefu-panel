#!/usr/bin/env node
'use strict'
/**
 * Unified zero-dependency syntax check & unit test runner for AI Agents and CI.
 *
 * Usage:
 *   node scripts/run-tests.cjs               # syntax check + all cross-platform Node unit tests
 *   node scripts/run-tests.cjs --check-only  # syntax check only (node --check)
 *   node scripts/run-tests.cjs --win         # include Windows PowerShell / native snapshot suites (auto-skips on Linux)
 *   node scripts/run-tests.cjs send feishu   # run syntax check + matching unit suites only
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')

const NODE_UNIT_SUITES = [
  'scripts/unit-send-rule.cjs',
  'scripts/unit-send.cjs',
  'scripts/unit-send-media.cjs',
  'scripts/unit-toasts.cjs',
  'scripts/unit-store-cache.cjs',
  'scripts/unit-snap-policy.cjs',
  'scripts/unit-ui-protocol.cjs',
  'scripts/unit-pinyin-lazy.cjs',
  'scripts/unit-manager-lazy.cjs',
  'scripts/unit-feishu-sync.mjs',
  'scripts/unit-feishu-config.cjs',
  'scripts/unit-media.cjs',
]

const WIN_POWERSHELL_SUITES = [
  'scripts/unit-paste-wait.ps1',
  'scripts/test-feishu-config.ps1',
]

function collectSyntaxTargets() {
  const dirs = ['electron', 'frontend/panel', 'scripts']
  const files = []
  for (const rel of dirs) {
    const abs = path.join(ROOT, rel)
    if (!fs.existsSync(abs)) continue
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (/\.(?:js|cjs|mjs)$/.test(entry.name)) {
        files.push(path.posix.join(rel, entry.name))
      }
    }
  }
  return files.sort()
}

function runStep(label, cmd, args) {
  const started = Date.now()
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  })
  const ms = Date.now() - started
  const ok = res.status === 0 && !res.error
  if (ok) {
    console.log(`PASS  ${label} (${ms}ms)`)
  } else {
    console.error(`FAIL  ${label} (${ms}ms)`)
    if (res.error) console.error(res.error)
    if (res.stdout) process.stderr.write(res.stdout)
    if (res.stderr) process.stderr.write(res.stderr)
  }
  return ok
}

function main() {
  const argv = process.argv.slice(2)
  const checkOnly = argv.includes('--check-only')
  const includeWin = argv.includes('--win')
  const filters = argv.filter((a) => !a.startsWith('--')).map((a) => a.toLowerCase())

  const startedAll = Date.now()
  let passed = 0
  let failed = 0

  // 1. Syntax check across all non-minified source & test scripts
  const syntaxFiles = collectSyntaxTargets()
  const syntaxStarted = Date.now()
  let syntaxFailed = false
  for (const rel of syntaxFiles) {
    const res = spawnSync(process.execPath, ['--check', rel], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
    })
    if (res.status !== 0 || res.error) {
      syntaxFailed = true
      failed++
      console.error(`FAIL  syntax:${rel}`)
      if (res.stderr) process.stderr.write(res.stderr)
    }
  }
  if (!syntaxFailed) {
    passed++
    console.log(`PASS  syntax (${syntaxFiles.length} files, ${Date.now() - syntaxStarted}ms)`)
  }

  if (checkOnly) {
    process.exit(failed ? 1 : 0)
  }

  // 2. Cross-platform isolated Node unit tests
  const suites = filters.length
    ? NODE_UNIT_SUITES.filter((s) => filters.some((f) => s.toLowerCase().includes(f)))
    : NODE_UNIT_SUITES

  if (!suites.length) {
    console.error(`No unit test suites matched filter: ${filters.join(', ')}`)
    process.exit(1)
  }

  for (const suite of suites) {
    if (runStep(suite, process.execPath, [suite])) passed++
    else failed++
  }

  // 3. Optional Windows-only isolated PowerShell & Koffi snapshot checks
  if (includeWin) {
    if (process.platform !== 'win32') {
      console.log('SKIP  Windows PowerShell / Koffi suites (non-win32 host)')
    } else {
      for (const psSuite of WIN_POWERSHELL_SUITES) {
        if (filters.length && !filters.some((f) => psSuite.toLowerCase().includes(f))) continue
        const ok = runStep(psSuite, 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psSuite])
        if (ok) passed++
        else failed++
      }
      if (!filters.length || filters.some((f) => 'smoke-win32-snapshot'.includes(f))) {
        if (fs.existsSync(path.join(ROOT, 'node_modules', 'koffi'))) {
          if (runStep('scripts/smoke-win32-snapshot.cjs', process.execPath, ['scripts/smoke-win32-snapshot.cjs'])) passed++
          else failed++
        } else {
          console.log('SKIP  scripts/smoke-win32-snapshot.cjs (node_modules/koffi not installed)')
        }
      }
    }
  }

  const totalMs = Date.now() - startedAll
  console.log(`\nSummary: ${passed} passed, ${failed} failed (${totalMs}ms)`)
  if (failed > 0) process.exit(1)
}

main()
