/**
 * Image generation and editing through a dedicated images endpoint, driven by
 * the user's own words.
 *
 * Image models — GPT Image and its siblings — are not chat models: a provider
 * that serves them serves them at `POST /images/generations` (text to image)
 * and `POST /images/edits` (image plus text to image), and refuses the same ids
 * on `/chat/completions`. They therefore cannot ride the LLM adapter, and this
 * plugin talks to those endpoints directly.
 *
 * The session model is a courier, not an author. With the default
 * `promptMode: user-message` the plugin takes the calling session's most recent
 * human turn — its text verbatim, and its first attached image as the edit
 * reference — and sends exactly that to the painter, which draws the whole
 * picture including any text the user asked for. A prompt the model composed
 * itself is never substituted for the user's words; when the model passes one
 * anyway it is ignored and the result says so.
 *
 * 绘画模式 (painting mode) is a per-session policy on top of that, switched by
 * a slash command and recoverable from the session log:
 *
 *   - `/painter 原文` (or the client's own `/原文`) sends the complete original
 *     text to the painter, whatever `promptMode` says;
 *   - `/painter 优化` (or `/优化`) first asks the session's own chat model for
 *     one image prompt and sends that;
 *   - `/painter off` leaves the mode.
 *
 * Configuration carries no credential: `apiKeyEnv` names a reference the
 * credentials seam resolves per request. Every config field is a live
 * reference, so a value edited in Settings → 模型 (which writes the profile's
 * `cordis.patch.yml` through the ConfigEditor) reaches the next call without
 * reloading anything. Nothing in this package is tied to a particular gateway,
 * model, or account.
 *
 * @module dsh-image-painter
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'image-painter'
export const inject = ['tools', 'credentials']

/** Endpoint prefix assumed when the row names none: any OpenAI-compatible images API. */
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

/** Credential reference assumed when the row names none. */
const DEFAULT_API_KEY_ENV = 'IMAGE_API_KEY'

/** Painter model assumed when the row names none. */
const DEFAULT_MODEL = 'gpt-image-1'

/** Render size request; a provider may answer with its own size. */
const DEFAULT_SIZE = '1024x1024'

/** Workspace directory receiving painted files. */
const DEFAULT_OUTPUT_DIR = 'image-gen'

/** Upper bound on one painting, matching how long image endpoints take. */
const DEFAULT_TIMEOUT_MS = 300_000

/** Largest accepted reference image, as encoded bytes. */
const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024

/** Sessions whose latest human turn is remembered; older entries are evicted. */
const MAX_TRACKED_SESSIONS = 200

/** Optimized prompts memoized per session and source text; oldest entries are evicted. */
const MAX_OPTIMIZED_PROMPTS = 50

/** How many tokens one prompt optimization may spend. */
const OPTIMIZE_MAX_TOKENS = 800

/** Prompt-policy value: the complete original text goes to the painter. */
const POLICY_VERBATIM = 'verbatim'

/** Prompt-policy value: the session's chat model rewrites the text first. */
const POLICY_OPTIMIZE = 'optimize'

/** Log-only session event recording the selected painting-mode policy (`null` = mode off). */
const MODE_EVENT = 'image-painter/mode'

/** System-prompt section carrying the painting-mode guidance while the mode is on. */
const MODE_SECTION = 'image-painter:mode'

/** Session-projection key carrying the painting-mode policy to the client. */
const PROJECTION_KEY = 'imagePainter'

/** Instructions for the auxiliary call that turns a request into one image prompt. */
const OPTIMIZE_SYSTEM = [
  'You turn one user request into ONE image-generation prompt for an image model.',
  'Preserve every subject, attribute, count, colour, style and piece of on-image text the user named, and add only concrete visual detail that serves the request.',
  'Write the prompt in the language of the request unless the request itself names another language for the picture\'s text.',
  'Never ask a question, never explain, never mention an AI or a model. Answer with the prompt itself and nothing else.',
].join(' ')

/**
 * The row's configuration. Every field is volatile, so a value edited in the
 * settings form (or in the profile patch) is committed into this reference
 * without remounting the plugin, and read through `.get()` per operation.
 */
export const Config = z.object({
  /** OpenAI-compatible gateway prefix serving `/images/generations` and `/images/edits`. */
  baseURL: z.string().default(DEFAULT_BASE_URL).volatile(),
  /** Credential reference resolved by the credentials seam; never the key itself. */
  apiKeyEnv: z.string().default(DEFAULT_API_KEY_ENV).volatile(),
  /** Default painter model id. */
  model: z.string().default(DEFAULT_MODEL).volatile(),
  /** Painter model ids a caller may select; empty means the default alone. */
  models: z.array(z.string()).default([]).volatile(),
  /** Requested render size. */
  size: z.string().default(DEFAULT_SIZE).volatile(),
  /** Workspace directory receiving painted files. */
  outputDir: z.string().default(DEFAULT_OUTPUT_DIR).volatile(),
  /** Who authors the prompt outside 绘画模式. */
  promptMode: z.union(['user-message', 'model']).default('user-message').volatile(),
  /** Whether the picture attached to the user's own message is used as the edit reference. */
  useSessionImages: z.boolean().default(true).volatile(),
  /** Whether a copy of the painting is published to the attachment store for inline display. */
  inline: z.boolean().default(true).volatile(),
  /** One painting's timeout in milliseconds. */
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS).volatile(),
})

/** Output value shape shared by both tools. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    model: { type: 'string' },
    bytes: { type: 'integer' },
    prompt: { type: 'string' },
    mode: { type: 'string' },
    revisedPrompt: { type: 'string' },
    url: { type: 'string' },
    note: { type: 'string' },
    image: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachmentId: { type: 'string' },
        mediaType: { type: 'string' },
        bytes: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        name: { type: 'string' },
      },
      required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
    },
  },
  required: ['path', 'model', 'bytes', 'prompt'],
}

/** Latest human turn per session: the words and the picture the painter receives. */
const humanTurns = new Map()

/** Painting-mode policy per session id. */
const sessionPolicies = new Map()

/** Sessions already reconciled against their own log. */
const restoredSessions = new WeakSet()

/** Memoized prompt optimizations, keyed by `session id + source text`. */
const optimizedPrompts = new Map()

/** Whether a value is a plain data object rather than an array, null, or a class instance. */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one config field's live value, tolerating a plain value as well as a volatile reference. */
function liveValue(config, key, fallback) {
  const raw = isObject(config) ? config[key] : undefined
  const value = isObject(raw) && typeof raw.get === 'function' ? raw.get() : raw
  return value === undefined ? fallback : value
}

/**
 * Read the file signature of encoded image bytes.
 * @param bytes - encoded raster bytes.
 * @returns the matching media type, or undefined for other bytes.
 */
function sniffMediaType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(String.fromCharCode(...bytes.subarray(0, 6)))) return 'image/gif'
  return undefined
}

/** File extension for one media type, used for the uploaded reference and saved output. */
function extensionOf(mediaType) {
  return mediaType === 'image/jpeg' ? '.jpg' : mediaType === 'image/webp' ? '.webp' : mediaType === 'image/gif' ? '.gif' : '.png'
}

/**
 * Read the row configuration into the facts both tools share. Every field is
 * read live, so an edit through the settings form applies to the next call.
 * @param config - the row's validated config, whose fields are volatile references.
 * @returns endpoint, credential reference, painter models, prompt policy, and output placement.
 */
function planOf(config) {
  const configured = liveValue(config, 'models', [])
    .filter(id => typeof id === 'string' && id.length > 0)
  const model = liveValue(config, 'model', '') || configured[0] || DEFAULT_MODEL
  const baseURL = liveValue(config, 'baseURL', '') || DEFAULT_BASE_URL
  const timeoutMs = liveValue(config, 'timeoutMs', DEFAULT_TIMEOUT_MS)
  return {
    baseURL: baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL,
    apiKeyEnv: liveValue(config, 'apiKeyEnv', '') || DEFAULT_API_KEY_ENV,
    model,
    models: configured.length > 0 ? configured : [model],
    size: liveValue(config, 'size', '') || DEFAULT_SIZE,
    outputDir: liveValue(config, 'outputDir', '') || DEFAULT_OUTPUT_DIR,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    promptMode: liveValue(config, 'promptMode', 'user-message') === 'model' ? 'model' : 'user-message',
    useSessionImages: liveValue(config, 'useSessionImages', true) !== false,
    inline: liveValue(config, 'inline', true) !== false,
  }
}

/** Track the latest human turn of every session, which is what the painter receives. */
function trackHumanTurns(ctx) {
  const remember = (session, event) => {
    if (event?.type !== 'user/message' || event?.data?.source?.kind !== 'user') return
    const id = session?.id
    if (typeof id !== 'string') return
    const content = Array.isArray(event.data.content) ? event.data.content : []
    const text = content
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
      .trim()
    const image = content.find(block => block?.type === 'image' && isObject(block.attachment))?.attachment
    humanTurns.delete(id)
    humanTurns.set(id, { text, image, at: Date.now() })
    while (humanTurns.size > MAX_TRACKED_SESSIONS) {
      const oldest = humanTurns.keys().next().value
      humanTurns.delete(oldest)
    }
  }
  const forget = (session) => {
    if (typeof session?.id === 'string') humanTurns.delete(session.id)
  }
  const disposers = [ctx.on('session/event', remember), ctx.on('session/disposed', forget)]
  return () => { for (const dispose of disposers) dispose() }
}

/** The remembered turn of the calling session. */
function turnOf(exec) {
  const id = exec.agent?.session.id
  return typeof id === 'string' ? humanTurns.get(id) : undefined
}

/** The calling session, when the call came from an agent at all. */
function sessionOf(exec) {
  return exec.agent?.session
}

/** Normalize one stored policy value. */
function normalizePolicy(value) {
  return value === POLICY_OPTIMIZE ? POLICY_OPTIMIZE : value === POLICY_VERBATIM ? POLICY_VERBATIM : null
}

/**
 * Recover the painting-mode policy a session had already logged, so resume and
 * fork keep the mode. A session whose log cannot be read keeps only the
 * runtime value.
 */
function loggedPolicy(session) {
  try {
    const events = session.snapshotEvents?.() ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== MODE_EVENT) continue
      return normalizePolicy(event.data?.policy)
    }
  } catch { /* an unreadable log leaves the runtime policy in charge */ }
  return null
}

/**
 * The painting-mode policy in force for one session. The session projection is
 * authoritative where it is mounted — it folds the log, so resume and fork
 * restore the mode; without it the runtime cache is filled once from the log.
 * @returns `verbatim`, `optimize`, or null when 绘画模式 is off.
 */
function currentPolicy(ctx, session) {
  if (session === undefined || typeof session.id !== 'string') return null
  const projections = ctx.get('sessionProjections')
  if (projections !== undefined) {
    try {
      const state = projections.stateOf(session, PROJECTION_KEY)
      if (state !== undefined) return normalizePolicy(state.policy)
    } catch { /* an unreadable projection falls back to the log */ }
  }
  if (sessionPolicies.has(session.id)) return sessionPolicies.get(session.id)
  if (restoredSessions.has(session)) return null
  restoredSessions.add(session)
  const logged = loggedPolicy(session)
  if (logged !== null) {
    sessionPolicies.set(session.id, logged)
    while (sessionPolicies.size > MAX_TRACKED_SESSIONS) {
      const oldest = sessionPolicies.keys().next().value
      sessionPolicies.delete(oldest)
    }
  }
  return logged
}

/** Record one policy selection in the session log and in the runtime cache. */
function setPolicy(session, policy) {
  session.append(MODE_EVENT, { policy })
  if (policy === null) sessionPolicies.delete(session.id)
  else sessionPolicies.set(session.id, policy)
}

/** The user-facing name of one policy. */
function policyLabel(policy) {
  return policy === POLICY_OPTIMIZE ? '优化' : policy === POLICY_VERBATIM ? '原文' : '未开启'
}

/** One line describing the current painting-mode state. */
function describeMode(policy) {
  return policy === null
    ? '绘画模式：未开启。用 /原文 把完整原文交给画手，用 /优化 先让对话模型润色提示词，用 /退出绘画 关闭。'
    : `绘画模式：${policyLabel(policy)}。${policy === POLICY_VERBATIM
      ? '用户的完整原文会直接作为画手提示词。'
      : '会先用当前对话模型把用户的话优化成画手提示词，再交给画手。'}`
}

/**
 * Turn the user's words into one painter prompt through the session's own chat
 * model. Memoized per session and source text so one request that paints twice
 * pays for one optimization.
 * @returns the optimized prompt.
 */
async function optimizePrompt(ctx, exec, source) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('this deployment mounts no llm service')
  const session = sessionOf(exec)
  const key = `${session?.id ?? 'no-session'}\u0000${source}`
  const memoized = optimizedPrompts.get(key)
  if (memoized !== undefined) return memoized
  const routed = session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  if (typeof provider !== 'string' || typeof model !== 'string') {
    throw new Error('the calling session has no selected model to optimize with')
  }
  let text = ''
  const options = {
    provider,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: source }] }],
    system: OPTIMIZE_SYSTEM,
    maxTokens: OPTIMIZE_MAX_TOKENS,
    ...(typeof session?.id === 'string' ? { sessionId: session.id } : {}),
    ...(exec.signal === undefined ? {} : { signal: exec.signal }),
  }
  for await (const chunk of llm.stream(options)) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
  }
  const prompt = text.trim()
  if (prompt.length === 0) throw new Error('the optimizing model returned no text')
  optimizedPrompts.set(key, prompt)
  while (optimizedPrompts.size > MAX_OPTIMIZED_PROMPTS) {
    const oldest = optimizedPrompts.keys().next().value
    optimizedPrompts.delete(oldest)
  }
  return prompt
}

/**
 * Resolve the prompt the painter receives.
 *
 * 绘画模式 decides first: `原文` always sends the complete original text,
 * `优化` rewrites it through the session's chat model (falling back to the
 * original words, with a note, when that call cannot run). With the mode off,
 * `promptMode` is back in charge — the user's words by default.
 *
 * @returns the prompt plus how it was produced, and whether a model-authored one was discarded.
 */
async function resolvePrompt(ctx, exec, plan, requested) {
  const turn = turnOf(exec)
  const verbatim = typeof turn?.text === 'string' && turn.text.length > 0 ? turn.text : undefined
  const authored = typeof requested === 'string' ? requested.trim() : ''
  const ignored = authored.length > 0 && authored !== verbatim
  const policy = currentPolicy(ctx, sessionOf(exec))
  if (policy === POLICY_VERBATIM) {
    if (verbatim !== undefined) return { prompt: verbatim, ignored, mode: '绘画模式 · 原文' }
    if (authored.length > 0) return { prompt: authored, ignored: false, mode: '绘画模式 · 原文' }
    throw new Error('绘画模式（原文）需要一条人类消息：这个会话还没有用户发言')
  }
  if (policy === POLICY_OPTIMIZE) {
    const source = verbatim ?? (authored.length > 0 ? authored : undefined)
    if (source === undefined) throw new Error('绘画模式（优化）需要一条人类消息：这个会话还没有用户发言')
    try {
      return {
        prompt: await optimizePrompt(ctx, exec, source),
        ignored,
        mode: '绘画模式 · 优化',
        note: 'the prompt was optimized from the user\'s words by the session\'s chat model',
      }
    } catch (error) {
      return {
        prompt: source,
        ignored,
        mode: '绘画模式 · 优化（回退为原文）',
        note: `prompt optimization failed, so the user's own words went to the painter: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
  if (plan.promptMode === 'user-message' && verbatim !== undefined) return { prompt: verbatim, ignored }
  if (authored.length > 0) return { prompt: authored, ignored: false }
  if (verbatim !== undefined) return { prompt: verbatim, ignored: false }
  throw new Error(
    'no prompt available: this deployment sends the user\'s own request, and this session has no human turn yet',
  )
}

/** Read one reference image from the session workspace. */
async function workspaceImage(ctx, exec, path) {
  const fs = ctx.get('fs')
  const cwd = exec.agent?.session.header.cwd
  let bytes
  let name = basename(path)
  if (fs !== undefined) {
    const target = await fs.resolve(path, { ...(cwd === undefined ? {} : { cwd }), signal: exec.signal })
    bytes = await fs.readBytes(target, exec.signal, MAX_INPUT_IMAGE_BYTES)
    name = basename(target.displayPath)
  } else {
    bytes = new Uint8Array(await readFile(path))
    if (bytes.length > MAX_INPUT_IMAGE_BYTES) throw new Error(`reference image exceeds ${MAX_INPUT_IMAGE_BYTES} bytes`)
  }
  const mediaType = sniffMediaType(bytes)
  if (mediaType === undefined) throw new Error(`cannot use "${path}" as a reference image: it is not a PNG/JPEG/WebP/GIF file`)
  return { bytes, mediaType, name }
}

/**
 * Resolve the reference image of one edit: an explicit path, else the picture the
 * user attached to their own message.
 */
async function referenceImage(ctx, exec, plan, requestedPath) {
  const path = typeof requestedPath === 'string' ? requestedPath.trim() : ''
  if (path.length > 0) return workspaceImage(ctx, exec, path)
  if (plan.useSessionImages) {
    const attached = turnOf(exec)?.image
    const hostPath = attached === undefined ? undefined : ctx.get('attachments')?.imageHostPath?.(attached)
    if (typeof hostPath === 'string') {
      const bytes = new Uint8Array(await readFile(hostPath))
      const mediaType = sniffMediaType(bytes) ?? 'image/png'
      return { bytes, mediaType, name: `reference${extensionOf(mediaType)}` }
    }
  }
  throw new Error('no reference image: attach an image to your message, or pass image_path')
}

/** Render one provider failure as the message a caller can act on. */
function describeFailure(status, text) {
  let detail = text.slice(0, 300)
  try {
    const parsed = JSON.parse(text)
    const error = parsed?.error
    if (isObject(error)) {
      const code = typeof error.code === 'string' ? ` [${error.code}]` : ''
      const message = typeof error.message === 'string' ? error.message : JSON.stringify(error).slice(0, 200)
      detail = `${message}${code}`
    }
  } catch { /* non-JSON bodies keep their raw text */ }
  return `image endpoint refused the request (HTTP ${status}): ${detail}`
}

/** Resolve the row's credential through the credentials seam. */
async function resolveKey(ctx, plan) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new Error('dsh-image-painter: the credentials service is not mounted')
  const resolved = await credentials.resolve(plan.apiKeyEnv)
  const value = resolved?.value
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`dsh-image-painter: credential "${plan.apiKeyEnv}" is empty or unset; set it before painting`)
  }
  return value
}

/**
 * Post one images request and decode the image it returns.
 * @returns encoded bytes plus the provider's url and revised prompt.
 */
async function requestImage(key, plan, path, init, signal) {
  const timeout = AbortSignal.timeout(plan.timeoutMs)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const response = await fetch(`${plan.baseURL}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
    signal: combined,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(describeFailure(response.status, text))
  let first
  try {
    first = JSON.parse(text)?.data?.[0]
  } catch {
    throw new Error(`image endpoint returned a non-JSON body: ${text.slice(0, 200)}`)
  }
  const revisedPrompt = typeof first?.revised_prompt === 'string' ? first.revised_prompt : undefined
  const url = typeof first?.url === 'string' ? first.url : undefined
  if (typeof first?.b64_json === 'string') return { bytes: Buffer.from(first.b64_json, 'base64'), revisedPrompt, url }
  if (url !== undefined) {
    const download = await fetch(url, { signal: combined })
    if (!download.ok) throw new Error(`painted image download refused (HTTP ${download.status})`)
    return { bytes: Buffer.from(await download.arrayBuffer()), revisedPrompt, url }
  }
  throw new Error(`image endpoint returned no image data: ${text.slice(0, 200)}`)
}

/** Build the on-disk name for one painted image. */
function outputName(requested, mediaType, prompt) {
  const explicit = typeof requested === 'string' && requested.trim().length > 0 ? basename(requested.trim()) : undefined
  if (explicit !== undefined) return explicit
  const slug = prompt.replace(/[^\p{Letter}\p{Number}]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 32)
  const stamp = new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 14)
  return `${slug.length > 0 ? `${slug}-` : 'image-'}${stamp}${extensionOf(mediaType)}`
}

/** Whether the calling route can be shown an image at all. */
async function routeSeesImages(ctx, exec) {
  const llm = ctx.get('llm')
  if (llm === undefined) return false
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  if (provider === undefined || model === undefined) return false
  try {
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    return info.inputModalities?.includes('image') === true
  } catch {
    return false
  }
}

/**
 * The directory painted files belong under: the calling session's workspace. A
 * harness-owned cwd is never a substitute, so a call without a session
 * workspace produces no file instead of dropping one into the installation.
 */
function workspaceRoot(ctx, exec) {
  const cwd = exec.agent?.session.header.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  const policy = ctx.get('sandboxPolicy')
  try {
    const root = policy?.resolve({ session: exec.agent?.session }).workspaceRoot
    if (typeof root === 'string' && root.length > 0) return root
  } catch { /* an unresolvable policy leaves the call without a workspace */ }
  return undefined
}

/** Whether this session may write into its workspace. */
function writable(ctx, exec) {
  const policy = ctx.get('sandboxPolicy')
  if (policy === undefined) return true
  try {
    return policy.resolve({ session: exec.agent?.session }).mode !== 'read-only'
  } catch {
    return true
  }
}

/**
 * Write the painted image into the session workspace and publish it as an attachment.
 * @returns the model-facing value: path, prompt actually sent, size, notes, and the attachment.
 */
async function publish(ctx, exec, plan, input) {
  const notes = []
  if (input.ignored) notes.push('the session model authored a prompt, which was not sent: the user\'s own words went to the painter')
  if (input.note !== undefined) notes.push(input.note)
  const relative = `${plan.outputDir}/${outputName(input.filename, input.mediaType, input.prompt)}`
  const root = workspaceRoot(ctx, exec)
  let displayPath = ''
  if (root === undefined) {
    notes.push('this call has no session workspace, so the image was not written to disk')
  } else if (writable(ctx, exec)) {
    const fs = ctx.get('fs')
    try {
      let absolute
      if (fs !== undefined) {
        const target = await fs.resolve(relative, { cwd: root, signal: exec.signal })
        displayPath = target.displayPath
        absolute = fs.processPath(target)
      } else {
        absolute = join(root, relative)
        displayPath = absolute
      }
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, input.bytes)
    } catch (error) {
      displayPath = ''
      notes.push(`file was not written: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    notes.push('this session is read-only, so the image was not written to the workspace')
  }

  const value = {
    path: displayPath,
    model: input.model,
    bytes: input.bytes.length,
    prompt: input.prompt,
    ...input.mode === undefined ? {} : { mode: input.mode },
    ...input.revisedPrompt === undefined ? {} : { revisedPrompt: input.revisedPrompt },
    ...input.url === undefined ? {} : { url: input.url },
  }

  const attachments = ctx.get('attachments')
  const wantsInline = plan.inline || displayPath === ''
  if (attachments !== undefined && wantsInline && await routeSeesImages(ctx, exec)) {
    try {
      const ref = await attachments.saveImage({ data: input.bytes, mediaType: input.mediaType, name: basename(relative) })
      value.image = {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...ref.name === undefined ? {} : { name: ref.name },
      }
    } catch (error) {
      notes.push(`inline copy unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (notes.length > 0) value.note = notes.join('; ')
  if (displayPath === '' && value.image === undefined) {
    throw new Error(`the image was painted but could not be delivered: ${notes.join('; ')}`)
  }
  return value
}

/** Render one painted image as its envelope beside the image block. */
function imageContent(value) {
  const size = value.image === undefined
    ? `${value.bytes} bytes`
    : `${value.image.width}x${value.image.height} px, ${value.bytes} bytes`
  const lines = [
    `<path>${value.path.length > 0 ? value.path : '(not written)'}</path>`,
    '<type>painted image</type>',
    '<content>',
    `${value.model}, ${size}`,
    ...value.mode === undefined ? [] : [`mode: ${value.mode}`],
    `prompt sent: ${value.prompt}`,
    ...value.revisedPrompt === undefined ? [] : [`provider prompt: ${value.revisedPrompt}`],
    ...value.note === undefined ? [] : [`note: ${value.note}`],
    '</content>',
  ]
  const blocks = [{ type: 'text', text: lines.join('\n') }]
  if (value.image !== undefined) blocks.push({ type: 'image', attachment: value.image })
  return blocks
}

/** Parameter properties both tools accept. */
function sharedProperties(plan) {
  return {
    prompt: {
      type: 'string',
      description: 'Optional. Leave empty when the user\'s own request should go to the painter; outside 绘画模式 this deployment forwards the user\'s message itself and a prompt you author is ignored.',
    },
    model: {
      type: 'string',
      description: `Painter model id; defaults to ${plan.model}. Configured ids: ${plan.models.join(', ')}.`,
    },
    size: { type: 'string', description: `Requested size such as ${plan.size}; a provider may answer with its own size.` },
    filename: { type: 'string', description: 'Optional file name (no directories) for the saved image.' },
  }
}

/** Pick the painter model for one call, defaulting to the configured one. */
function modelOf(args, plan) {
  const requested = typeof args.model === 'string' && args.model.length > 0 ? args.model : plan.model
  if (!plan.models.includes(requested)) {
    throw new Error(`unknown painter model "${requested}"; configured models are ${plan.models.join(', ')}`)
  }
  return requested
}

/** Size for one call, defaulting to the configured one. */
function sizeOf(args, plan) {
  return typeof args.size === 'string' && args.size.length > 0 ? args.size : plan.size
}

/** Painting-mode guidance, rendered only while a policy is selected. */
function modeGuidance(policy) {
  if (policy === null) return ''
  return [
    '# 绘画模式',
    `This session is in 绘画模式 with the prompt policy "${policyLabel(policy)}" (${policy}).`,
    'When the user asks for a picture or a change to one, call generate_image or edit_image instead of describing the image yourself.',
    policy === POLICY_VERBATIM
      ? 'The plugin sends the user\'s complete original words to the painter; do not rewrite, translate, shorten, or embellish them, and pass no prompt of your own.'
      : 'The plugin asks this session\'s chat model for one image prompt and sends that; do not compose the painter prompt inside the tool call.',
    'The user may switch the policy at any time with /原文, /优化, or leave the mode with /退出绘画.',
  ].join('\n')
}

/** Structural parse-only schema for the projection's persisted state and wire view. */
const modeStateSchema = {
  parse: (value) => ({ policy: normalizePolicy(isObject(value) ? value.policy : undefined) }),
}

/**
 * Register the painting tools over the configured endpoint.
 * @param ctx - the plugin context; `tools` and `credentials` are required.
 * @param config - the row config, whose fields are volatile references.
 */
export function apply(ctx, config) {
  // This plugin renders its own form on the Models page, so it needs no
  // auto-generated settings page of its own.
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  ctx.inject(['systemPrompt'], (child) => {
    child.systemPrompt.section({
      name: MODE_SECTION,
      order: child.systemPrompt.getSectionOrder('PLAN_POLICY') + 1,
      text: (context) => (context.agent === undefined ? '' : modeGuidance(currentPolicy(ctx, context.agent.session))),
    })
  })

  // The durable half of 绘画模式: the log event folds into a session projection,
  // which survives resume and fork and is what the client's mode chip renders.
  ctx.inject(['sessionProjections'], (child) => {
    child.effect(() => child.sessionProjections.register({
      key: PROJECTION_KEY,
      stateVersion: 1,
      stateSchema: modeStateSchema,
      init: () => ({ policy: null }),
      apply: (state, event) => {
        if (event?.type !== MODE_EVENT) return state
        const policy = normalizePolicy(event.data?.policy)
        return state.policy === policy ? state : { policy }
      },
      wire: { viewSchema: modeStateSchema, view: state => state },
    }), 'dsh-image-painter: painting-mode projection')
  })

  ctx.inject(['commands'], (child) => {
    child.commands.register({
      definitionId: 'dsh-image-painter',
      name: 'painter',
      description: '绘画模式：/painter 原文 | /painter 优化 | /painter off',
      input: { hint: '[原文|优化|off]' },
      handler: ({ agent, rawInput }) => {
        const session = agent.session
        const argument = rawInput.trim()
        const current = currentPolicy(ctx, session)
        if (argument === '') return { kind: 'success', text: describeMode(current) }
        const normalized = argument.toLowerCase()
        const next = argument === '原文' || normalized === 'raw' || normalized === 'verbatim' ? POLICY_VERBATIM
          : argument === '优化' || normalized === 'optimize' || normalized === 'opt' ? POLICY_OPTIMIZE
            : normalized === 'off' || argument === '退出' || argument === '关闭' || argument === '关' ? null
              : undefined
        if (next === undefined) {
          return { kind: 'error', text: `未知参数「${argument}」：用 /painter 原文、/painter 优化 或 /painter off` }
        }
        try {
          setPolicy(session, next)
        } catch (error) {
          return { kind: 'error', text: `绘画模式未能写入会话日志：${error instanceof Error ? error.message : String(error)}` }
        }
        ctx.logger.info(`dsh-image-painter: painting mode for ${session.id} is now ${policyLabel(next)}`)
        return { kind: 'success', text: describeMode(next) }
      },
    })
  })

  const definitions = [
    {
      name: 'generate_image',
      description: 'Paint an image from the user\'s request through the deployment\'s dedicated images endpoint — the only path image '
        + 'models such as GPT Image serve; they are not chat models and fail on chat requests. The painter draws the whole picture, '
        + 'text included. Do not rewrite the request: the deployment decides the prompt itself — outside 绘画模式 it forwards the '
        + 'user\'s own message, and in 绘画模式 the session\'s policy (原文/优化) owns it. '
        + 'The image is saved under the session workspace and returned inline.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: sharedProperties(planOf(config)),
        required: [],
      },
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => imageContent(value) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const plan = planOf(config)
        const resolved = await resolvePrompt(ctx, exec, plan, args.prompt)
        const model = modelOf(args, plan)
        const key = await resolveKey(ctx, plan)
        const result = await requestImage(key, plan, '/images/generations', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, prompt: resolved.prompt, n: 1, size: sizeOf(args, plan) }),
        }, exec.signal)
        const mediaType = sniffMediaType(result.bytes)
        if (mediaType === undefined) throw new Error('the image endpoint returned bytes in no supported image format')
        return publish(ctx, exec, plan, { ...result, ...resolved, mediaType, model, filename: args.filename })
      },
    },
    {
      name: 'edit_image',
      description: 'Paint a new image from one reference picture through the deployment\'s dedicated images endpoint: the file is '
        + 'uploaded as the reference and the painter returns the whole new image, text included. Use it for "change this picture" '
        + 'requests — restyle, background change, add or remove elements, redraw. '
        + (planOf(config).useSessionImages
          ? 'When the user attached the picture to their own message, leave image_path empty and it is used automatically. '
          : '')
        + 'Do not rewrite the request: the deployment decides the prompt itself — outside 绘画模式 it forwards the user\'s own '
        + 'message, and in 绘画模式 the session\'s policy (原文/优化) owns it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          image_path: { type: 'string', description: 'Reference image path; omit to use the picture the user attached to their message.' },
          ...sharedProperties(planOf(config)),
        },
        required: [],
      },
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => imageContent(value) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const plan = planOf(config)
        const resolved = await resolvePrompt(ctx, exec, plan, args.prompt)
        const model = modelOf(args, plan)
        const reference = await referenceImage(ctx, exec, plan, args.image_path)
        const key = await resolveKey(ctx, plan)
        const form = new FormData()
        form.set('model', model)
        form.set('prompt', resolved.prompt)
        form.set('n', '1')
        form.set('size', sizeOf(args, plan))
        form.set('image', new Blob([reference.bytes], { type: reference.mediaType }), reference.name)
        const result = await requestImage(key, plan, '/images/edits', { method: 'POST', body: form }, exec.signal)
        const mediaType = sniffMediaType(result.bytes)
        if (mediaType === undefined) throw new Error('the image endpoint returned bytes in no supported image format')
        return publish(ctx, exec, plan, {
          ...result,
          ...resolved,
          mediaType,
          model,
          filename: args.filename,
          note: [resolved.note, `reference: ${reference.name}`].filter(Boolean).join('; '),
        })
      },
    },
  ]

  const disposers = definitions.map(definition => ctx.tools.register(definition))
  const stopTracking = trackHumanTurns(ctx)
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
    stopTracking()
  })
  const plan = planOf(config)
  ctx.logger.info(
    `dsh-image-painter: generate_image/edit_image ready on ${plan.baseURL}`
    + ` (model ${plan.model}, promptMode ${plan.promptMode}, painting mode via /painter)`,
  )
}
