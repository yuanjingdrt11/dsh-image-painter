/**
 * Host-half smoke test for dsh-image-painter.
 *
 * Mounts `lib/index.js` against a minimal fake harness context, drives the
 * `/painter` command, and calls both tools with a stubbed images endpoint so
 * the prompt that actually reaches the painter can be asserted for every
 * policy (off / 原文 / 优化).
 *
 * No dependencies and no network: everything outside this package is mocked,
 * and painted files land in a throwaway OS temp directory.
 *
 * Run: node tests/host.test.mjs   (or: pnpm test)
 */
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

const failures = []
const check = (name, ok, detail) => {
  if (!ok) failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// --- fake harness ------------------------------------------------------------

const listeners = new Map()
const tools = new Map()
const commands = new Map()
const sections = new Map()
const logs = []
let optimizedReply = 'OPTIMIZED-PROMPT'

const config = mod.Config({
  baseURL: 'https://gw.example/v1',
  apiKeyEnv: 'TEST_KEY',
  model: 'gpt-image-2',
  models: ['gpt-image-2', 'gpt-image-2.5-flare'],
  size: '1024x1024',
  outputDir: 'image-gen',
  promptMode: 'user-message',
  useSessionImages: true,
  inline: false,
  timeoutMs: 30000,
})

const llmCalls = []
const ctx = {
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`warn ${m}`), error: (m) => logs.push(`error ${m}`) },
  effect: (fn) => { const disposer = typeof fn === 'function' ? fn() : undefined; return typeof disposer === 'function' ? disposer : () => {} },
  on: (event, handler) => { listeners.set(event, handler); return () => listeners.delete(event) },
  get: (name) => {
    if (name === 'credentials') return { resolve: async () => ({ value: 'test-key' }) }
    if (name === 'llm') {
      return {
        resolveModelInfo: async () => ({ inputModalities: ['text'] }),
        stream: (options) => {
          llmCalls.push(options)
          const text = optimizedReply
          return (async function* () {
            if (text.length > 0) yield { type: 'text-delta', index: 0, text }
            yield { type: 'finish', reason: 'stop' }
          })()
        },
      }
    }
    if (name === 'settings') return { configure: () => () => {} }
    return undefined
  },
  inject: (names, cb) => {
    const provided = new Set(['tools', 'credentials', 'settings', 'llm', 'commands', 'systemPrompt'])
    if (names.every(name => provided.has(name))) cb(ctx)
    return () => {}
  },
  tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
  commands: { register: (definition) => { commands.set(definition.name, definition); return () => commands.delete(definition.name) } },
  settings: { configure: () => () => {} },
  systemPrompt: {
    section: (section) => { sections.set(section.name, section); return () => sections.delete(section.name) },
    getSectionOrder: (name) => ({ PLAN_POLICY: 500 }[name] ?? 0),
  },
  fiber: {},
}

mod.apply(ctx, config)

check('registers both tools', tools.has('generate_image') && tools.has('edit_image'))
check('registers the painter command', commands.has('painter'))
check('registers the mode prompt section', sections.has('image-painter:mode'))

// --- one session -------------------------------------------------------------

const workspace = mkdtempSync(join(tmpdir(), 'dip-workspace-'))
const events = []
const session = {
  id: 'session-test',
  header: { cwd: workspace },
  append: (type, data) => { events.push({ type, data }); return { type, data, seq: events.length - 1 } },
  snapshotEvents: () => events,
  requestHeader: () => ({ config: { provider: 'p', model: 'chat-model' } }),
}
const agent = { session, options: { provider: 'p', model: 'chat-model' } }
const exec = { agent, signal: undefined, callId: 'call-1' }
const remember = listeners.get('session/event')

const say = (text) => remember(session, {
  type: 'user/message',
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
})

// --- stubbed images endpoint -------------------------------------------------

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
let lastBody
globalThis.fetch = async (url, init) => {
  lastBody = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body
  return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }) }
}

const promptSectionText = () => sections.get('image-painter:mode').text({ agent })

// --- outside 绘画模式: the user's words by default -----------------------------

say('一只戴蓝帽子的橘猫')
check('mode off: no prompt guidance', promptSectionText() === '')
const off = await tools.get('generate_image').execute({}, exec)
check('mode off: original words sent', off.prompt === '一只戴蓝帽子的橘猫', off.prompt)
check('mode off: no mode field', off.mode === undefined)
check('mode off: no llm call', llmCalls.length === 0)
check('mode off: image written', readdirSync(join(workspace, 'image-gen')).length === 1)
check('mode off: nothing appended to the log', events.length === 0, JSON.stringify(events))

// --- /painter 原文 -------------------------------------------------------------

const runCommand = line => commands.get('painter').handler({ agent, rawInput: line })
let result = runCommand('原文')
check('原文: command succeeds', result.kind === 'success', JSON.stringify(result))
check('原文: logged', events.length === 1 && events[0].type === 'image-painter/mode' && events[0].data.policy === 'verbatim', JSON.stringify(events))
check('原文: section explains the mode', promptSectionText().includes('绘画模式') && promptSectionText().includes('原文'))
say('一只戴蓝帽子的橘猫')
const verbatim = await tools.get('generate_image').execute({}, exec)
check('原文: full original text sent', verbatim.prompt === '一只戴蓝帽子的橘猫', verbatim.prompt)
check('原文: mode reported', verbatim.mode === '绘画模式 · 原文', String(verbatim.mode))
check('原文: no llm call', llmCalls.length === 0)

// --- /painter 优化 -------------------------------------------------------------

result = runCommand('优化')
check('优化: command succeeds', result.kind === 'success', JSON.stringify(result))
const optimized = await tools.get('generate_image').execute({}, exec)
check('优化: optimizer called once', llmCalls.length === 1, String(llmCalls.length))
check('优化: optimizer used the session model', llmCalls[0]?.provider === 'p' && llmCalls[0]?.model === 'chat-model')
check('优化: optimizer received the original words', llmCalls[0]?.messages?.[0]?.content?.[0]?.text === '一只戴蓝帽子的橘猫')
check('优化: optimized prompt sent to the painter', optimized.prompt === 'OPTIMIZED-PROMPT', optimized.prompt)
check('优化: body carries the optimized prompt', lastBody.prompt === 'OPTIMIZED-PROMPT', JSON.stringify(lastBody))
check('优化: mode reported', optimized.mode === '绘画模式 · 优化', String(optimized.mode))
check('优化: optimization memoized per text', (await tools.get('generate_image').execute({}, exec)).prompt === 'OPTIMIZED-PROMPT' && llmCalls.length === 1)

// optimizer failure falls back to the user's words
optimizedReply = ''
say('一只趴在窗台上的白猫')
const fallback = await tools.get('generate_image').execute({}, exec)
check('优化: empty optimizer output falls back', fallback.prompt === '一只趴在窗台上的白猫', fallback.prompt)
check('优化: fallback is reported', fallback.mode === '绘画模式 · 优化（回退为原文）' && String(fallback.note).includes('optimization failed'), String(fallback.note))
optimizedReply = 'OPTIMIZED-PROMPT'

// --- /painter off --------------------------------------------------------------

result = runCommand('off')
check('off: command succeeds', result.kind === 'success', JSON.stringify(result))
check('off: logged as whole value', events.at(-1).data.policy === null, JSON.stringify(events.at(-1)))
check('off: section goes quiet', promptSectionText() === '')
const afterOff = await tools.get('generate_image').execute({}, exec)
check('off: back to the user\'s words', afterOff.prompt === '一只趴在窗台上的白猫' && afterOff.mode === undefined)

// --- command grammar ----------------------------------------------------------

check('bare command reports state', runCommand('').text.includes('未开启'), runCommand('').text)
check('unknown argument is an error', runCommand('紫色').kind === 'error')
check('english aliases work', runCommand('optimize').kind === 'success' && events.at(-1).data.policy === 'optimize')
runCommand('off')
check('exit aliases work', runCommand('退出').kind === 'success' && events.at(-1).data.policy === null)

// --- model validation ---------------------------------------------------------

let rejected = false
try { await tools.get('generate_image').execute({ model: 'nope' }, exec) } catch (error) { rejected = String(error.message).includes('unknown painter model') }
check('unknown painter model rejected', rejected)

// --- edit path ----------------------------------------------------------------

const reference = join(workspace, 'ref.png')
writeFileSync(reference, PNG)
const edited = await tools.get('edit_image').execute({ image_path: reference }, exec)
check('edit_image sends the multipart form', edited.prompt === '一只趴在窗台上的白猫' && edited.note.includes('reference: ref.png'), String(edited.note))
check('edit_image reached /images/edits', lastBody instanceof FormData)
check('edit_image carried the painter model', lastBody.get('model') === 'gpt-image-2')

// --- secret hygiene -----------------------------------------------------------

check('plugin logs its endpoint', logs.some(line => String(line).includes('https://gw.example/v1')), logs.join(' | '))
check('the resolved key never enters a tool result', !JSON.stringify(off).includes('test-key') && !JSON.stringify(edited).includes('test-key'))

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED:\n- ${failures.join('\n- ')}`)
process.exit(failures.length === 0 ? 0 : 1)
