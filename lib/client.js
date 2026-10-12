/**
 * dsh-image-painter, browser half.
 *
 * Ships three surfaces, all registered through ordinary client extension
 * points — no edit to any first-party package:
 *
 *  - a painter-gateway form in the Models settings page footer
 *    (`settings.models.footer`), editing this plugin's own profile entry
 *    through `ctx.configForms`; every accepted edit lands in the profile's
 *    `cordis.patch.yml` under `- id: image-painter` and applies live;
 *  - a 绘画模式 chip in the composer tool row (`conversation.input.left`) fed by
 *    the host's `imagePainter` session projection, clicking it toggles
 *    原文/优化 and its ✕ leaves the mode;
 *  - the literal Chinese slash commands `/原文`, `/优化`, `/退出绘画`, and
 *    `/绘画模式`. Host command names are ASCII-only (the loader validates
 *    `/^[a-z][a-z0-9_-]*$/`), but a client-owned command contribution is keyed
 *    by the typed token itself, so these spellings run here and forward
 *    `/painter …` to the host, which owns the durable state.
 *
 * Hand-written bundle: its only external is the platform-baseline `react`
 * module, so it needs no build step. The client module system serves it from
 * `exports["./client"]`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-image-painter',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    const PLUGIN = 'dsh-image-painter'
    /** Locale namespace owned by this bundle. */
    const NS = 'imagePainter'
    /** Host loader entry id — the settings namespace this form edits. */
    const ENTRY = 'image-painter'
    /** Host command the contributions forward to. */
    const HOST_COMMAND = 'painter'
    /** Session projection key carrying the painting-mode policy. */
    const PROJECTION = 'imagePainter'
    /** Style tag identity owned by this bundle. */
    const STYLE_TAG_ID = `${PLUGIN}/styles.css`

    //#region dictionaries

    const zh = {
      'form.title': '画手模型（dsh-image-painter）',
      'form.intro': '填写画手模型所在的 OpenAI 兼容网关（/v1 结尾）。保存后写入当前 profile 的 cordis.patch.yml，并立即生效，无需重启。',
      'field.baseURL': '网关地址（v1）',
      'field.baseURL.hint': '形如 https://your-gateway/v1 —— 图片端点所在网关',
      'field.apiKeyEnv': '凭据名',
      'field.apiKeyEnv.hint': '凭据库/环境变量里的名字，不是密钥本身',
      'field.model': '默认画手模型',
      'field.models': '可选画手模型',
      'field.models.hint': '每行一个；留空表示只使用默认模型',
      'field.size': '默认尺寸',
      'field.outputDir': '产物目录',
      'field.outputDir.hint': '相对会话工作区；"." 即工作区根',
      'field.promptMode': '提示词模式',
      'field.promptMode.hint': '未进入绘画模式时谁写提示词',
      'option.user-message': '用户原话直通（默认）',
      'option.model': '会话模型自拟',
      'field.useSessionImages': '用户贴图自动作为改图参考',
      'field.inline': '另存附件以便对话内联显示',
      'field.timeoutMs': '单次出图超时（毫秒）',
      'action.save': '保存',
      'action.discard': '撤销改动',
      'action.reload': '重新读取',
      'status.loading': '正在读取配置…',
      'status.unavailable': '宿主没有提供 %s 配置（插件未挂载或本页只读）。',
      'status.readonly': '当前 profile 不接受写入。',
      'status.saved': '已保存到 profile 的 cordis.patch.yml，并已生效。',
      'status.unchanged': '没有改动。',
      'status.failed': '保存失败：%s',
      'chip.raw': '绘画·原文',
      'chip.optimize': '绘画·优化',
      'chip.toggle': '点击切换 原文 / 优化',
      'chip.leave': '退出绘画模式',
      'cmd.raw.label': '原文',
      'cmd.raw.desc': '绘画模式：把完整原文直接作为画手提示词',
      'cmd.optimize.label': '优化',
      'cmd.optimize.desc': '绘画模式：先用对话模型优化提示词，再交给画手',
      'cmd.leave.label': '退出绘画',
      'cmd.leave.desc': '关闭绘画模式，恢复默认提示词策略',
      'cmd.state.label': '绘画模式',
      'cmd.state.desc': '查看当前绘画模式与提示词策略',
    }

    const en = {
      'form.title': 'Painter model (dsh-image-painter)',
      'form.intro': 'Point the plugin at the OpenAI-compatible gateway that serves the painter models (ending in /v1). Saving writes this profile\'s cordis.patch.yml and applies at once — no restart.',
      'field.baseURL': 'Gateway (v1)',
      'field.baseURL.hint': 'e.g. https://your-gateway/v1 — the images endpoint prefix',
      'field.apiKeyEnv': 'Credential name',
      'field.apiKeyEnv.hint': 'The name resolved by the credentials store; never the key itself',
      'field.model': 'Default painter model',
      'field.models': 'Selectable painter models',
      'field.models.hint': 'One per line; empty means the default model alone',
      'field.size': 'Default size',
      'field.outputDir': 'Output directory',
      'field.outputDir.hint': 'Relative to the session workspace; "." is its root',
      'field.promptMode': 'Prompt mode',
      'field.promptMode.hint': 'Who authors the prompt while 绘画模式 is off',
      'option.user-message': 'The user\'s own words (default)',
      'option.model': 'The session model',
      'field.useSessionImages': 'Use the picture the user attached as the edit reference',
      'field.inline': 'Keep an attachment copy for inline display',
      'field.timeoutMs': 'Painting timeout (ms)',
      'action.save': 'Save',
      'action.discard': 'Discard changes',
      'action.reload': 'Reload',
      'status.loading': 'Loading configuration…',
      'status.unavailable': 'The host serves no %s configuration (plugin unmounted, or this page is read-only).',
      'status.readonly': 'This profile accepts no writes.',
      'status.saved': 'Saved to the profile\'s cordis.patch.yml and applied.',
      'status.unchanged': 'Nothing changed.',
      'status.failed': 'Save failed: %s',
      'chip.raw': 'Paint · verbatim',
      'chip.optimize': 'Paint · optimized',
      'chip.toggle': 'Click to switch verbatim / optimized',
      'chip.leave': 'Leave painting mode',
      'cmd.raw.label': '原文',
      'cmd.raw.desc': 'Painting mode: send the complete original text to the painter',
      'cmd.optimize.label': '优化',
      'cmd.optimize.desc': 'Painting mode: optimize the prompt with the chat model first',
      'cmd.leave.label': '退出绘画',
      'cmd.leave.desc': 'Leave painting mode and restore the default prompt policy',
      'cmd.state.label': '绘画模式',
      'cmd.state.desc': 'Show the current painting mode and prompt policy',
    }

    //#endregion

    //#region shared helpers

    /** One form field: the config key, its control shape, and how a draft value is written. */
    const FIELDS = [
      { key: 'baseURL', kind: 'text', hint: 'field.baseURL.hint' },
      { key: 'apiKeyEnv', kind: 'text', hint: 'field.apiKeyEnv.hint' },
      { key: 'model', kind: 'text' },
      { key: 'models', kind: 'lines', hint: 'field.models.hint' },
      { key: 'size', kind: 'text' },
      { key: 'outputDir', kind: 'text', hint: 'field.outputDir.hint' },
      { key: 'promptMode', kind: 'select', options: ['user-message', 'model'], hint: 'field.promptMode.hint' },
      { key: 'useSessionImages', kind: 'bool' },
      { key: 'inline', kind: 'bool' },
      { key: 'timeoutMs', kind: 'number' },
    ]

    /** Config defaults, mirroring the host schema, so the form renders before the first read lands. */
    const DEFAULTS = {
      baseURL: 'https://api.openai.com/v1',
      apiKeyEnv: 'IMAGE_API_KEY',
      model: 'gpt-image-1',
      models: [],
      size: '1024x1024',
      outputDir: 'image-gen',
      promptMode: 'user-message',
      useSessionImages: true,
      inline: true,
      timeoutMs: 300000,
    }

    const cx = (...names) => names.filter(Boolean).join(' ')

    /** Whether a value is a plain data object. */
    function isObject(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    /** How one config value renders in a control. */
    function display(field, value) {
      if (field.kind === 'lines') return Array.isArray(value) ? value.join('\n') : ''
      if (field.kind === 'bool') return value !== false
      return value === undefined || value === null ? '' : String(value)
    }

    /** The section as control values: what the Host holds, with schema defaults filled in. */
    function toValues(value) {
      const source = isObject(value) ? value : {}
      const values = {}
      for (const field of FIELDS) {
        const raw = source[field.key]
        values[field.key] = raw === undefined ? DEFAULTS[field.key] : raw
      }
      return values
    }

    /** The section as editable control values (text stays text while typing). */
    function toDraft(values) {
      const draft = {}
      for (const field of FIELDS) draft[field.key] = display(field, values[field.key])
      return draft
    }

    /** The config value one control stands for, or undefined while it is not a usable value. */
    function draftToValue(field, shown) {
      if (field.kind === 'bool') return shown !== false
      if (field.kind === 'lines') {
        return String(shown).split(/[\n,]/u).map(part => part.trim()).filter(part => part.length > 0)
      }
      if (field.kind === 'number') {
        const parsed = Number(String(shown).trim())
        return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
      }
      return String(shown).trim()
    }

    /** Whether two config values are the same selection. */
    function sameValue(field, a, b) {
      if (field.kind === 'lines') {
        const left = Array.isArray(a) ? a : []
        const right = Array.isArray(b) ? b : []
        return left.length === right.length && left.every((item, index) => item === right[index])
      }
      return a === b
    }

    /** The ops that turn the section the Host holds into the draft, or null when nothing changed. */
    function opsFor(fields, draft, values) {
      const ops = []
      for (const field of fields) {
        const next = draftToValue(field, draft[field.key])
        if (next === undefined) continue
        if (sameValue(field, next, values[field.key])) continue
        ops.push({ op: 'set', path: [field.key], value: next })
      }
      return ops.length === 0 ? null : ops
    }

    /** Resolve the settings namespace this form edits: our entry id, else the entry that carries our schema. */
    function resolveNamespace(describe) {
      const namespaces = describe?.getSnapshot?.().view?.namespaces ?? []
      if (namespaces.some(row => row.ns === ENTRY)) return ENTRY
      const match = namespaces.find((row) => {
        const envelope = row.schema
        if (!isObject(envelope) || !isObject(envelope.refs)) return false
        const node = envelope.refs[envelope.uid]
        const dict = isObject(node) && isObject(node.dict) ? node.dict : undefined
        return dict !== undefined && dict.baseURL !== undefined && dict.outputDir !== undefined && dict.apiKeyEnv !== undefined
      })
      return match === undefined ? undefined : match.ns
    }

    /** Run one host command line for a session, tolerating a deployment without the remote face. */
    function runHostCommand(ctx, sessionId, line) {
      const commands = ctx.get('remote')?.commands
      if (commands === undefined) {
        ctx.logger.warn(`${PLUGIN}: the command remote is unavailable, cannot run ${line}`)
        return
      }
      void commands.execute(sessionId, line, []).then(
        (result) => {
          if (!result?.ok) {
            ctx.logger.warn(`${PLUGIN}: ${line} was refused: ${result?.error?.code} ${result?.error?.message}`)
          }
        },
        (error) => { ctx.logger.warn(`${PLUGIN}: ${line} failed: ${error instanceof Error ? error.message : String(error)}`) },
      )
    }

    //#endregion

    //#region styles

    const CSS = `
.dip-card{margin-top:18px;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-2,transparent)}
.dip-head{display:flex;align-items:baseline;gap:8px;margin-bottom:4px}
.dip-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:22px}
.dip-badge{font-size:11px;line-height:16px;padding:0 6px;border-radius:4px;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary)}
.dip-intro{margin:0 0 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dip-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px 14px}
.dip-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dip-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary))}
.dip-input,.dip-select,.dip-area{width:100%;box-sizing:border-box;font:inherit;font-size:13px;line-height:20px;padding:5px 8px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary)}
.dip-area{resize:vertical;min-height:54px;font-family:inherit}
.dip-input:disabled,.dip-select:disabled,.dip-area:disabled{opacity:.6}
.dip-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dip-check{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.dip-actions{display:flex;align-items:center;gap:8px;margin-top:12px}
.dip-button{font:inherit;font-size:12px;line-height:18px;padding:4px 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.dip-button:hover:not(:disabled){background:var(--dsw-alias-fill-l2,rgba(127,127,127,.14))}
.dip-button:disabled{opacity:.5;cursor:default}
.dip-button--primary{border-color:transparent;background:var(--dsw-alias-fill-l3,rgba(127,127,127,.2));font-weight:600}
.dip-status{margin-left:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);text-align:right}
.dip-status--ok{color:var(--dsw-alias-state-success-primary)}
.dip-status--error{color:var(--dsw-alias-state-error-primary,#d33)}
.dip-chip{display:inline-flex;align-items:center;gap:4px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;padding:0 4px 0 8px;height:22px;background:transparent;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary));font-size:11px;line-height:20px}
.dip-chip-main{font:inherit;font-size:11px;line-height:20px;border:0;padding:0;background:transparent;color:inherit;cursor:pointer}
.dip-chip--on{background:var(--dsw-alias-fill-l2,rgba(127,127,127,.14));border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary)}
.dip-chip-close{font:inherit;font-size:11px;line-height:20px;border:0;padding:0 2px;background:transparent;color:inherit;cursor:pointer;opacity:.7}
.dip-chip-close:hover{opacity:1}
`

    /** Install the bundle's one style tag, once per page. */
    function installStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN
      tag.dataset.pluginCss = STYLE_TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    //#endregion

    //#region Models-page footer form

    /** Subscribe one component to a shared configuration form. */
    function useFormSnapshot(form) {
      const subscribe = useCallback(listener => form.subscribe(listener), [form])
      const snapshot = useCallback(() => form.getSnapshot(), [form])
      return useSyncExternalStore(subscribe, snapshot, snapshot)
    }

    /** One labelled control of the gateway form. */
    function FieldControl({ field, value, disabled, t, onChange }) {
      const label = t(`field.${field.key}`)
      const hint = field.hint === undefined ? undefined : t(field.hint)
      let control
      if (field.kind === 'bool') {
        control = h('label', { className: 'dip-check' },
          h('input', {
            type: 'checkbox',
            checked: value !== false,
            disabled,
            onChange: event => onChange(event.target.checked),
          }),
          label)
        return h('div', { className: 'dip-field' }, control, hint === undefined ? null : h('span', { className: 'dip-hint' }, hint))
      }
      if (field.kind === 'select') {
        control = h('select', {
          className: 'dip-select',
          value: String(value),
          disabled,
          onChange: event => onChange(event.target.value),
        }, field.options.map(option => h('option', { key: option, value: option }, t(`option.${option}`))))
      } else if (field.kind === 'lines') {
        control = h('textarea', {
          className: 'dip-area',
          value: String(value ?? ''),
          disabled,
          spellCheck: false,
          onChange: event => onChange(event.target.value),
        })
      } else {
        control = h('input', {
          className: 'dip-input',
          type: field.kind === 'number' ? 'number' : 'text',
          value: String(value ?? ''),
          disabled,
          spellCheck: false,
          onChange: event => onChange(event.target.value),
        })
      }
      return h('div', { className: 'dip-field' },
        h('span', { className: 'dip-label' }, label),
        control,
        hint === undefined ? null : h('span', { className: 'dip-hint' }, hint))
    }

    /** The painter-gateway form shown at the end of the Models settings page. */
    function PainterGateway(props) {
      const { form, t } = props
      const snapshot = useFormSnapshot(form)
      const values = useMemo(() => toValues(snapshot.value), [snapshot.value])
      const [draft, setDraft] = useState(() => toDraft(values))
      const [status, setStatus] = useState(null)
      const revision = snapshot.revision
      const valuesRef = useRef(values)
      valuesRef.current = values
      // A new namespace revision means the Host holds different values: adopt
      // them rather than keep editing a section that no longer exists.
      useEffect(() => { setDraft(toDraft(valuesRef.current)) }, [revision])
      const ready = snapshot.status === 'ready'
      const editable = ready && snapshot.writable !== false
      const ops = useMemo(() => (ready ? opsFor(FIELDS, draft, values) : null), [ready, draft, values])
      const dirty = ops !== null
      const label = (key, ...args) => {
        const text = t(key)
        return args.length === 0 ? text : text.replace('%s', String(args[0]))
      }
      const save = useCallback(async () => {
        if (ops === null) { setStatus({ kind: 'plain', text: label('status.unchanged') }); return }
        try {
          const accepted = await form.mutate(ops)
          setStatus(accepted
            ? { kind: 'ok', text: label('status.saved') }
            : { kind: 'error', text: label('status.failed', 'the host refused the write') })
        } catch (error) {
          setStatus({ kind: 'error', text: label('status.failed', error instanceof Error ? error.message : String(error)) })
        }
      }, [form, ops, t])
      let statusText = status
      if (statusText === null) {
        if (snapshot.status === 'loading') statusText = { kind: 'plain', text: label('status.loading') }
        else if (snapshot.status === 'unavailable') statusText = { kind: 'error', text: label('status.unavailable', ENTRY) }
        else if (ready && snapshot.writable === false) statusText = { kind: 'plain', text: label('status.readonly') }
      }
      return h('div', { className: 'dip-card' },
        h('div', { className: 'dip-head' },
          h('span', { className: 'dip-title' }, t('form.title')),
          h('span', { className: 'dip-badge' }, 'cordis.patch.yml')),
        h('p', { className: 'dip-intro' }, t('form.intro')),
        h('div', { className: 'dip-grid' }, FIELDS.map(field => h(FieldControl, {
          key: field.key,
          field,
          value: draft[field.key],
          disabled: !editable,
          t,
          onChange: (next) => {
            setDraft(previous => ({ ...previous, [field.key]: next }))
            setStatus(null)
          },
        }))),
        h('div', { className: 'dip-actions' },
          h('button', {
            type: 'button',
            className: 'dip-button dip-button--primary',
            disabled: !editable || !dirty,
            onClick: save,
          }, t('action.save')),
          h('button', {
            type: 'button',
            className: 'dip-button',
            disabled: !editable || !dirty,
            onClick: () => { setDraft(toDraft(values)); setStatus(null) },
          }, t('action.discard')),
          h('button', {
            type: 'button',
            className: 'dip-button',
            disabled: !editable,
            onClick: () => { setDraft(toDraft(valuesRef.current)); setStatus(null) },
          }, t('action.reload')),
          h('span', {
            className: cx('dip-status', statusText?.kind === 'ok' && 'dip-status--ok', statusText?.kind === 'error' && 'dip-status--error'),
          }, statusText?.text ?? '')),
      )
    }

    //#endregion

    //#region composer chip

    /** The 绘画模式 chip: visible only while the mode is on, toggling 原文/优化. */
    function PainterChip(props) {
      const { t, sessionId, useProjection, runCommand } = props
      const projection = typeof useProjection === 'function' ? useProjection(PROJECTION) : undefined
      const policy = isObject(projection) ? projection.policy : undefined
      if (typeof sessionId !== 'string' || (policy !== 'verbatim' && policy !== 'optimize')) return null
      const toggle = policy === 'optimize' ? '原文' : '优化'
      return h('span', { className: 'dip-chip dip-chip--on' },
        h('button', {
          type: 'button',
          className: 'dip-chip-main',
          title: t('chip.toggle'),
          onClick: () => runCommand(sessionId, `/painter ${toggle}`),
        }, t(policy === 'optimize' ? 'chip.optimize' : 'chip.raw')),
        h('button', {
          type: 'button',
          className: 'dip-chip-close',
          title: t('chip.leave'),
          'aria-label': t('chip.leave'),
          onClick: () => runCommand(sessionId, '/painter off'),
        }, '✕'))
    }

    //#endregion

    /** Client services this bundle needs to run at all; the rest are read tolerantly. */
    const inject = ['slots', 'locale']

    function apply(ctx) {
      installStyles()
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${PLUGIN}: dictionaries`)
      const runCommand = (sessionId, line) => runHostCommand(ctx, sessionId, line)

      // The gateway form rides the Models page's own footer seat, and exists
      // exactly while the host serves this plugin's settings namespace.
      ctx.inject(['configForms'], (child) => {
        const forms = child.configForms
        child.effect(() => forms.whileServed([ENTRY], () => child.slots.register({
          name: 'settings.models.footer',
          id: `${PLUGIN}-gateway`,
          order: 0,
          locale: NS,
          inject: () => ({ form: forms.get(resolveNamespace(forms.describe()) ?? ENTRY), t }),
        }, PainterGateway)), `${PLUGIN}: gateway form`)
      })

      // The mode chip sits in the composer tool row, which is a list seat any
      // plugin may extend.
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: `${PLUGIN}-mode`,
        order: 20,
        locale: NS,
        inject: () => ({ t, runCommand }),
      }, PainterChip))

      // Literal Chinese slash commands: the host owns the durable state, the
      // client owns the spelling.
      ctx.inject(['commandUi'], (child) => {
        const contributions = [
          { name: '原文', label: 'cmd.raw.label', description: 'cmd.raw.desc', line: '/painter 原文' },
          { name: '优化', label: 'cmd.optimize.label', description: 'cmd.optimize.desc', line: '/painter 优化' },
          { name: '退出绘画', label: 'cmd.leave.label', description: 'cmd.leave.desc', line: '/painter off' },
          { name: '绘画模式', label: 'cmd.state.label', description: 'cmd.state.desc', line: '/painter' },
        ]
        child.effect(() => {
          const disposers = contributions.map(contribution => child.commandUi.register({
            name: contribution.name,
            label: () => t(contribution.label),
            description: () => t(contribution.description),
            available: () => true,
            ui: { kind: 'action', run: session => runCommand(session.sessionId, contribution.line) },
          }))
          return () => { for (const dispose of disposers) dispose() }
        }, `${PLUGIN}: slash commands`)
      })
    }

    exports.name = PLUGIN
    exports.inject = inject
    exports.apply = apply
    /** Pure helpers, exposed for tests. */
    exports.__test = { FIELDS, DEFAULTS, zh, en, toValues, toDraft, display, draftToValue, sameValue, opsFor, resolveNamespace, PainterGateway, PainterChip }
    return module.exports
  },
})
