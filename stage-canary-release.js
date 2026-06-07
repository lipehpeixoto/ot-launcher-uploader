/**
 * Stage canary runtime tree for R2 upload.
 *
 * Mirrors the launcher's scripts/bundle-canary.js allowlist: copies a
 * curated subset of the canary working tree into CANARY_PATH so the
 * sync.js can then hash + upload it to R2 under the "server/" namespace.
 *
 * Why a separate staging dir instead of pointing sync at the canary
 * working tree directly: the canary repo is ~800 MB of source, build
 * artefacts, .pdb, logs, the dev sqlite save, etc. The runtime install
 * the player actually needs is ~80 MB. Keeping the staging dir as a
 * clean mirror also makes it easy to inspect what is about to ship.
 *
 * Run via `npm run stage-canary` before `npm run sync`.
 */

import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config()

const CANARY_SOURCE = process.env.CANARY_SOURCE
const CANARY_PATH = process.env.CANARY_PATH

if (!CANARY_SOURCE || !fs.existsSync(CANARY_SOURCE)) {
  console.error(`[stage-canary] CANARY_SOURCE invalid or missing: ${CANARY_SOURCE}`)
  process.exit(1)
}
if (!CANARY_PATH) {
  console.error('[stage-canary] CANARY_PATH not set in .env')
  process.exit(1)
}

// Locked in step with launcher/scripts/bundle-canary.js. If you change
// one, change the other -- otherwise the bundled-on-first-install state
// drifts from the R2-updated state, producing weird half-broken installs.
const ALLOWLIST = [
  'canary.exe',
  'config.lua',
  'schema-sqlite.sql',
  'key.pem',
  'data',
  'data-otservbr-global'
]

// Patterns we don't want INSIDE the allowed dirs. Mostly dev droppings.
function shouldSkipEntry(name) {
  if (name === '__tests__' || name === '.git' || name === 'node_modules') return true
  if (name.endsWith('.log')) return true
  if (name.endsWith('.pdb')) return true
  if (name === '.gitkeep' || name === '.gitignore' || name === '.gitattributes') return true
  return false
}

function copyTree(src, dst, totals) {
  const stat = fs.statSync(src)
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true })
    for (const entry of fs.readdirSync(src)) {
      if (shouldSkipEntry(entry)) continue
      copyTree(path.join(src, entry), path.join(dst, entry), totals)
    }
  } else {
    fs.copyFileSync(src, dst)
    totals.files++
    totals.bytes += stat.size
  }
}

function wipeAndPrep(target) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true })
  }
  fs.mkdirSync(target, { recursive: true })
}

const targetAbs = path.resolve(CANARY_PATH)
const sourceAbs = path.resolve(CANARY_SOURCE)

console.log(`[stage-canary] source: ${sourceAbs}`)
console.log(`[stage-canary] target: ${targetAbs}`)

wipeAndPrep(targetAbs)

const totals = { files: 0, bytes: 0 }
for (const item of ALLOWLIST) {
  const src = path.join(sourceAbs, item)
  const dst = path.join(targetAbs, item)
  if (!fs.existsSync(src)) {
    console.warn(`[stage-canary] skipping missing: ${item}`)
    continue
  }
  copyTree(src, dst, totals)
  console.log(`[stage-canary] copied: ${item}`)
}

console.log(
  `[stage-canary] done: ${totals.files} files, ` +
  `${(totals.bytes / 1024 / 1024).toFixed(1)} MB at ${targetAbs}`
)
