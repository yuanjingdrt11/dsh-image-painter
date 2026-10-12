/**
 * Browser-half smoke test for dsh-image-painter.
 *
 * Loads `lib/client.js` exactly the way the page's module loader does (a
 * classic script registering a factory on `window.__ModuleLoader__`), then
 * exercises the pure helpers and drives `apply()` against a minimal client
 * context.
 *
 * Component rendering needs React. When React cannot be resolved (this package
 * ships none), those checks are skipped with a notice instead of failing, so
 * the file stays dependency-free and portable. Point `DSH_REACT_ROOT` at a
 * directory whose module graph can resolve `react` to run the full suite.
 *
 * Run: node tests/client.test.mjs   (or: pnpm test)
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const bundlePath = new URL('../lib/client.js', import.meta.url)
const pkgRequire = createRequire(import.meta.url)

/** Resolve React from an explicit root, else from this package, else give up. */
function loadReact() {
  const roots = [process.env.DSH_REACT_ROOT, process.env.DSH_CLIENT_ROOT].filter(Boolean)
  for (const root of roots) {
    try {
      const req = createRequire(`${root.replace(/\/$/u, '')}/index.js`)
      return { react: req('react'), server: req('react-dom/server'), jsx: req('react/jsx-runtime') }
    } catch { /* try the next candidate */ }
  }
  try {
    return { react: pkgRequire('react'), server: pkgRequire('react-dom/server'), jsx: pkgRequire('react/jsx-runtime') }
  } catch {
    return undefined
  }
}

const runtime = loadReact()
const modules = new Map([
  ['react', runtime?.react ?? {}],
  ['react-dom', runtime?.react ?? {}],
  ['react/jsx-runtime', runtime?.jsx ?? {}],
])

let registration
let styleTags = 0
globalThis.window = { __ModuleLoader__: { load(entry) { registration = entry } } }
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: () => { styleTags += 1 } },
}

// The bundle is a classic script: evaluate it with `window`/`document` in scope.
new Function('window', 'document', readFileSync(bundlePath, 'utf8'))(globalThis.window, globalThis.document)

const failures = []
const check = (name, ok, detail) => {
  if (!ok) failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

check('registration id', registration?.id === 'dsh-image-painter', String(registration?.id))
const api = registration.factory(spec => {
  if (!modules.has(spec)) throw new Error(`unexpected external request: ${spec}`)
  return modules.get(spec)
})
check('exports apply', typeof api.apply === 'function')
check('exports inject', Array.isArray(api.inject) && api.inject.includes('slots'))
const t = api.__test
check('exposes test helpers', t !== undefined)

// --- pure helpers -----------------------------------------------------------
const draft = t.toDraft(t.toValues(undefined))
check('defaults render', draft.baseURL === 'https://api.openai.com/v1' && draft.models === '')

const values = t.toValues({
  baseURL: 'https://gw.example/v1', apiKeyEnv: 'K', model: 'm', models: ['a', 'b'],
  size: '512x512', outputDir: '.', promptMode: 'model', useSessionImages: false, inline: true, timeoutMs: 1000,
})
check('section projects', values.models.length === 2 && values.useSessionImages === false)

const dirty = { ...t.toDraft(values), baseURL: ' https://other.example/v1 ', models: 'x\ny, z', useSessionImages: true }
const ops = t.opsFor(t.FIELDS, dirty, values)
check('ops only for changed fields', ops.length === 3, JSON.stringify(ops))
check('text trimmed', ops[0].path[0] === 'baseURL' && ops[0].value === 'https://other.example/v1')
check('lines split', ops.find(o => o.path[0] === 'models').value.join('|') === 'x|y|z')
check('bool written', ops.find(o => o.path[0] === 'useSessionImages').value === true)
check('clean section yields null', t.opsFor(t.FIELDS, t.toDraft(values), values) === null)
check('invalid number skipped', t.opsFor(t.FIELDS, { ...t.toDraft(values), timeoutMs: '0' }, values) === null)

const describe = (namespaces) => ({ getSnapshot: () => ({ view: { namespaces } }) })
check('namespace by id', t.resolveNamespace(describe([{ ns: 'image-painter' }])) === 'image-painter')
check('namespace by schema', t.resolveNamespace(describe([
  { ns: 'other' },
  { ns: 'renamed-row', schema: { uid: 3, refs: { 3: { dict: { baseURL: {}, apiKeyEnv: {}, outputDir: {} } } } } },
])) === 'renamed-row')
check('namespace absent', t.resolveNamespace(describe([{ ns: 'other' }])) === undefined)

// --- dictionaries -----------------------------------------------------------
const zhDict = t.zh
const enDict = t.en
check('zh/en dictionaries share one key set',
  JSON.stringify(Object.keys(zhDict).sort()) === JSON.stringify(Object.keys(enDict).sort()),
  `${Object.keys(zhDict).length} zh vs ${Object.keys(enDict).length} en`)
const fieldKeys = t.FIELDS.flatMap(f => [`field.${f.key}`, ...(f.hint === undefined ? [] : [f.hint])])
check('every field label/hint exists in both dictionaries',
  fieldKeys.every(k => zhDict[k] !== undefined && enDict[k] !== undefined),
  fieldKeys.filter(k => zhDict[k] === undefined || enDict[k] === undefined).join(','))

// --- components (need React) -------------------------------------------------
if (runtime === undefined) {
  console.log('skip component rendering — React not resolvable; set DSH_REACT_ROOT to run it')
} else {
  const react = runtime.react
  const ReactDOMServer = runtime.server
  const tBound = (key, args) => {
    const value = zhDict[key]
    if (value === undefined) throw new Error(`missing dict key ${key}`)
    return args === undefined ? value : value.replace('%s', String(args))
  }
  const form = {
    getSnapshot: () => ({ status: 'ready', value: { ...values, models: ['a', 'b'] }, revision: 1, writable: true }),
    subscribe: () => () => {},
    mutate: async () => true,
  }
  const html = ReactDOMServer.renderToStaticMarkup(react.createElement(t.PainterGateway, { form, t: tBound }))
  check('gateway form renders', html.includes('画手模型') && html.includes('https://gw.example/v1'))
  check('gateway form has controls', (html.match(/<input|<textarea|<select/gu) ?? []).length >= 8)

  const chip = ReactDOMServer.renderToStaticMarkup(react.createElement(t.PainterChip, {
    t: tBound, sessionId: 's1', runCommand: () => {}, useProjection: () => ({ policy: 'optimize' }),
  }))
  check('chip renders while on', chip.includes('绘画·优化'))
  check('chip hidden while off', ReactDOMServer.renderToStaticMarkup(react.createElement(t.PainterChip, {
    t: tBound, sessionId: 's1', runCommand: () => {}, useProjection: () => ({ policy: null }),
  })) === '')
  check('chip tolerates no useProjection', ReactDOMServer.renderToStaticMarkup(react.createElement(t.PainterChip, {
    t: tBound, sessionId: 's1', runCommand: () => {},
  })) === '')
  check('chip needs a session', ReactDOMServer.renderToStaticMarkup(react.createElement(t.PainterChip, {
    t: tBound, runCommand: () => {}, useProjection: () => ({ policy: 'verbatim' }),
  })) === '')
}

// --- apply() wiring ----------------------------------------------------------
const calls = { slots: [], contributions: [], locales: [], settingsForms: 0 }
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect: (fn) => { const disposer = typeof fn === 'function' ? fn() : undefined; return typeof disposer === 'function' ? disposer : () => {} },
  locale: {
    bind: () => (key, args) => {
      const value = zhDict[key] ?? key
      return args === undefined ? value : value.replace('%s', String(args))
    },
    register: (ns, dicts) => { calls.locales.push([ns, Object.keys(dicts.zh).length, Object.keys(dicts.en).length]); return () => {} },
  },
  get: (name) => (name === 'remote' ? { commands: { execute: async () => ({ ok: true }) } } : undefined),
  inject: (names, cb) => { cb(ctx); return () => {} },
  slots: {
    inject: (name, cb) => { cb(); return () => {} },
    register: (options) => { calls.slots.push(options.name); return () => {} },
  },
  commandUi: { register: (contribution) => { calls.contributions.push(contribution.name); return () => {} } },
  configForms: {
    describe: () => describe([{ ns: 'image-painter' }]),
    get: () => ({ getSnapshot: () => ({ status: 'loading' }), subscribe: () => () => {}, mutate: async () => true }),
    whileServed: (namespaces, register) => { calls.settingsForms += 1; return register(new Set(namespaces)) },
  },
}
check('apply returns nothing fatal', api.apply(ctx) === undefined)
check('apply registers both slots', calls.slots.includes('settings.models.footer') && calls.slots.includes('conversation.input.left'), calls.slots.join(','))
check('apply registers local dictionaries', calls.locales.length === 1 && calls.locales[0][1] === calls.locales[0][2], JSON.stringify(calls.locales))
check('apply registers four slash commands', calls.contributions.join(',') === '原文,优化,退出绘画,绘画模式', calls.contributions.join(','))
check('style tag installed by apply', styleTags === 1, String(styleTags))
check('apply never leaks a key into the bundle', !readFileSync(bundlePath, 'utf8').includes('test-key'))

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED:\n- ${failures.join('\n- ')}`)
process.exit(failures.length === 0 ? 0 : 1)
