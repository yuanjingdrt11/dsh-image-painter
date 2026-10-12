/**
 * Publish-time privacy gate for dsh-image-painter.
 *
 * Answers one question with evidence: "would `npm publish` ship anything
 * private?" It asks npm for the exact file list a publish would carry, then
 * scans every one of those files for credential shapes, private keys, home
 * directories, and mail addresses — and refuses anything outside the intended
 * package surface.
 *
 * The shipped surface is deliberately narrow: the `files` whitelist in
 * package.json plus npm's always-included manifests. node_modules, the
 * lockfile, tests, tooling, and any local overlay must never appear.
 *
 * Extra local strings (your own gateway host, credential names, …) can be
 * checked without committing them — keep them in the environment only, never
 * in this repository or this file:
 *
 *   DSH_PRIVACY_FORBID='my-gateway.example,MY_KEY_NAME' node scripts/privacy-check.mjs
 *
 * Run: node scripts/privacy-check.mjs   (also wired to `prepublishOnly`)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Shapes that must never reach a published artifact. */
const FORBIDDEN = [
  { name: 'private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { name: 'OpenAI-style key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/u },
  { name: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/u },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/u },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/u },
  { name: 'literal bearer token', pattern: /Bearer\s+[A-Za-z0-9._~+/-]{20,}=*/u },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u },
  { name: 'unix home directory', pattern: /(?:\/home\/|\/Users\/)[A-Za-z0-9._-]+\//u },
  { name: 'windows user directory', pattern: /[A-Za-z]:\\Users\\[^\\\s]+/u },
  { name: 'mail address', pattern: /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/u },
  { name: 'long assigned secret', pattern: /(?:api[_-]?key|apikey|secret|password|passwd|token)\s*[:=]\s*['"][A-Za-z0-9+/_-]{24,}['"]/iu },
]

/** Paths that must never be part of a published artifact. */
const FORBIDDEN_PATHS = [
  { name: 'installed dependencies', pattern: /(^|\/)node_modules\//u },
  { name: 'lockfile', pattern: /(^|\/)pnpm-lock\.yaml$/u },
  { name: 'tests', pattern: /(^|\/)tests\//u },
  { name: 'tooling', pattern: /(^|\/)scripts\//u },
  { name: 'hidden file', pattern: /(^|\/)\.[^/]+$/u },
  { name: 'local overlay', pattern: /\.local\./u },
  { name: 'log or archive', pattern: /\.(?:log|tgz|tar|zip)$/u },
]

/** The intended publish surface: everything else in the tarball is a surprise. */
const EXPECTED = /^(?:package\.json|LICENSE|README(?:\.[a-z]{2})?\.md|icon\.svg|cordis\.patch\.yml|lib\/client\.js|lib\/index\.js|locale\/[a-z]{2}\.json)$/u

const extra = (process.env.DSH_PRIVACY_FORBID ?? '')
  .split(',')
  .map(value => value.trim())
  .filter(value => value.length > 0)
  .map(value => ({ name: `local string ${JSON.stringify(value)}`, pattern: new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u') }))

const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' })
const [info] = JSON.parse(raw)
const files = info.files.map(entry => entry.path).sort()

const failures = []
const fail = (message) => { failures.push(message); console.log(`FAIL ${message}`) }

console.log(`dsh-image-painter: ${info.name}@${info.version} would publish ${files.length} file(s), ${info.size} bytes packed / ${info.unpackedSize} unpacked`)
for (const file of files) console.log(`  ${file}`)

for (const file of files) {
  if (!EXPECTED.test(file)) fail(`unexpected file in the tarball: ${file}`)
  for (const { name, pattern } of FORBIDDEN_PATHS) {
    if (pattern.test(file)) fail(`forbidden path (${name}) in the tarball: ${file}`)
  }
  let text
  try {
    text = readFileSync(join(root, file), 'utf8')
  } catch (error) {
    fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
    continue
  }
  for (const { name, pattern } of [...FORBIDDEN, ...extra]) {
    const match = pattern.exec(text)
    if (match !== null) fail(`${file}: looks like a ${name} (${JSON.stringify(match[0].slice(0, 24))}…)`)
  }
}

if (failures.length > 0) {
  console.log(`\n${failures.length} privacy problem(s) found — publishing is refused.`)
  process.exit(1)
}
console.log(`\nPRIVACY OK — ${files.length} file(s) scanned, no credential, home path, or unexpected file.`)
