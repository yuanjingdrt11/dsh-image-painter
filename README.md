# dsh-image-painter

A [DSH](https://www.npmjs.com/search?q=%40deepseek-ai%2Fdsh) plugin that paints and edits images through a **dedicated images
endpoint** — the path GPT Image and compatible models actually serve — forwards **the user's own request verbatim**, lets
you fill in the painter gateway right in **Settings → Models**, and switches prompt policy per session with **painting
mode** (`/原文` · `/优化`).

## Why a separate path

Image models are not chat models. A provider that serves them serves them at:

- `POST {baseURL}/images/generations` — text to image
- `POST {baseURL}/images/edits` — image plus text to image (multipart)

and refuses the very same model ids on `POST {baseURL}/chat/completions` (`400 This model is not supported on the Chat
Completions endpoint`). DSH's LLM adapters speak chat protocols only, so an image model cannot ride them, and declaring
image input on its route cannot help. This plugin talks to the images endpoints directly.

## The session model is a courier, not an author

With the default `promptMode: user-message` the plugin reads the calling session's most recent human turn:

- its **text verbatim** becomes the prompt — no rewriting, translating, shortening, or embellishing by the chat model;
- its **first attached image** becomes the edit reference, so "turn this into a watercolour" needs no path from the model;
- the painter draws the **whole** picture, including any text the user asked to appear in it.

A prompt the chat model composed itself is never substituted for the user's words. If the model passes one anyway it is
dropped, and the tool result says so. Both tools also echo the exact `prompt sent`, so what reached the painter is always
visible.

## Fill in the painter gateway in Settings

**Settings → Models** grows a "Painter model (dsh-image-painter)" card at the bottom of the page:

- **Gateway (v1)** — the OpenAI-compatible gateway serving the painter models, e.g. `https://your-gateway/v1`;
- **Credential name** — the name the credentials store resolves, never the key itself;
- default/selectable painter models, size, output directory, prompt mode, timeout;
- **Save** writes the `- id: image-painter` row of the active profile's `cordis.patch.yml` — comments preserved, atomic,
  validated before the write, and applied live: **the next painting already uses the new values, no restart**.

You never have to hand-edit YAML: the form and the patch file are two doors to the same configuration. The card appears
only while the host actually mounts this plugin (and finds it by schema even under a renamed row id).

## Painting mode (per session)

| Command | Effect |
|---|---|
| `/原文` | Painting mode · verbatim: the **complete original text** is the painter prompt |
| `/优化` | Painting mode · optimized: this session's **chat model** rewrites the request into one painter prompt first |
| `/退出绘画` | Leave painting mode; `promptMode` governs again |
| `/绘画模式` | Show the current state |
| `/painter [原文\|优化\|off]` | The host-side spelling of the same switches |

- The choice is **logged in the session** (`image-painter/mode`), so resume and fork restore it.
- While the mode is on, a **painting chip** appears in the composer tool row (`绘画·原文` / `绘画·优化`); clicking it
  toggles the policy, its `✕` leaves the mode.
- While the mode is on, the session carries a short painting-mode section telling the model to call
  `generate_image` / `edit_image` rather than describe a picture itself.
- `/优化` uses the session's currently selected chat model — nothing extra to configure. When that call cannot run (no
  model selected, empty answer) the plugin **falls back to the raw words** and says so in the result's `note`.
- One message is optimized once per session (memoized by session + source text).

Host command names are ASCII-only in DSH (`/^[a-z][a-z0-9_-]*$/`), which is why the host side is `/painter`; the literal
Chinese spellings are client-owned command contributions, so they work exactly as typed.

## Install

```
plugin_manager install_bundle /path/to/dsh-image-painter
```

or from a registry once published:

```bash
dsh plugin --profile <profile> add dsh-image-painter
```

Restart `dsh web` **once** after installing or upgrading: replacing a host half loads a fresh JavaScript module
generation, which the loader does not hot-swap. After that, browser-half edits alone (`lib/client.js`) reload through the
client HMR transport without a restart.

## Configure

The settings form is the easy path. The profile's `cordis.patch.yml` still works (`config` replaces the row's config
wholesale, so restate the fields you need):

```yaml
- id: image-painter
  name: dsh-image-painter
  config:
    baseURL: https://api.openai.com/v1   # any OpenAI-compatible images API
    apiKeyEnv: IMAGE_API_KEY             # credential reference, never the secret
    model: gpt-image-1
    models: [gpt-image-1]
    size: 1024x1024
    outputDir: image-gen                 # relative to the session workspace ("." = its root)
    promptMode: user-message             # or: model
    useSessionImages: true
    inline: true
    timeoutMs: 300000
```

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `https://api.openai.com/v1` | Images endpoint prefix |
| `apiKeyEnv` | `IMAGE_API_KEY` | Credential reference resolved through `ctx.credentials` |
| `model` | `gpt-image-1` | Default painter; may be overridden per call from `models` |
| `models` | `[model]` | Painter ids the tools may select |
| `size` | `1024x1024` | Requested size; a provider may answer with its own |
| `outputDir` | `image-gen` | Workspace directory for painted files |
| `promptMode` | `user-message` | Who authors the prompt while painting mode is off |
| `useSessionImages` | `true` | Use the picture the user attached as the edit reference |
| `inline` | `true` | Also publish a durable attachment for inline display (costs one copy in the DSH attachment store) |
| `timeoutMs` | `300000` | Per-painting timeout |

Every field is volatile: an edit applies to the next painting without a restart or a remount.

## Credentials

`apiKeyEnv` names a **reference**, not the key. Resolve it through the credentials seam — a DSH credential store entry or
an environment variable of that name:

```bash
export IMAGE_API_KEY=sk-...
```

Nothing in this package contains a gateway address, model id, or account.

## Usage

Just talk to the agent; the chat model calls the tools:

- "画一只戴蓝帽子的橘猫，扁平插画风格" → `generate_image`
- attach a picture and say "把它改成水彩风格" → `edit_image` (no path needed)
- `/优化`, then "画一只戴蓝帽子的橘猫" → the painter receives the chat model's rewritten prompt

Results are written to `<session workspace>/<outputDir>/` and returned inline when the calling route can see images.
A read-only session writes no file and says so. Endpoint failures surface verbatim — `HTTP 402 … insufficient_balance`,
`HTTP 400 … content policy` and friends read as themselves, with the provider's own wording and request id.

## Known limitations

- One image per call; `n > 1` is not exposed. One reference image per edit.
- **Text inside the picture** is the painter's job and only as good as the model: some models render CJK text poorly.
- **Upstream content policy** may refuse prompts that name real people, regardless of DSH or this plugin.
- Which painters work depends on the account behind the gateway: one model may answer 200 while its sibling returns
  402/503 from an unfunded upstream account.
- The DSH attachment copy (`inline: true`) is what makes the picture visible in the conversation; set `inline: false` to
  keep the workspace file only.
- `/优化` needs a chat model selected for the session; it falls back to the raw words rather than failing the painting.

## Dependencies

- Runtime: `@deepseek-ai/schemastery`, for the volatile Config schema the settings form needs.
- The browser half is a hand-written lazy-CJS factory bundle (`lib/client.js`) using platform-baseline modules only
  (react, react-dom, ui-slots, ui-primitives, client-store) — **no build step**.

## Publishing

The package is not `private`: `npm publish` works after you set your own `version`, `author`, and `repository` metadata.
It has no install scripts.

### Privacy gate

A repeatable check runs on `prepublishOnly` (and standalone):

```bash
npm run privacy                                                   # scan the exact tarball contents
DSH_PRIVACY_FORBID='my-gw.example,MY_KEY_NAME' npm run privacy    # also check your own strings (never committed)
```

`scripts/privacy-check.mjs` asks npm for the file list this publish would actually carry, then scans every one of those
files for private-key blocks, credential shapes, home directories, and mail addresses, and refuses any file outside the
intended surface (`node_modules/`, lockfiles, `tests/`, `scripts/`, local overlays, and logs must never reach the
tarball). Any hit exits 1 and stops the publish.

The published surface is fixed at ten files: `package.json`, `LICENSE`, `README.md`, `README.zh.md`,
`cordis.patch.yml`, `icon.svg`, `lib/index.js`, `lib/client.js`, `locale/zh.json`, `locale/en.json`.

**The rule behind it**: `apiKeyEnv` is only a credential *name*; the key is resolved per request by `ctx.credentials`,
so the package never stores one. Your gateway address, credential names, and account belong in the profile's
`cordis.patch.yml` (`~/.dsh/profiles/<profile>/`), and the key itself in the DSH credential store
(`~/.dsh/.credentials.yaml`) or an environment variable — none of which live in this directory.

`.gitignore` is the second line of defence: dependencies (`node_modules/`), any `.env`/`.npmrc`/`*.key`/`credentials*`/
`*token*`-shaped secret file, local overlays such as `*.local.yml`, logs, and painted output (`image-gen/`, should a
session's workspace ever be this directory).

## License

MIT — see [LICENSE](LICENSE).
