# dsh-image-painter

DSH 插件：用**专用图片端点**出图与改图（GPT Image 及兼容模型真正服务的那条路），把**用户原话原样**交给画手，
并在 **设置 → 模型** 里直接填画手网关，在会话里用 **绘画模式**（`/原文` · `/优化`）随时切换提示词策略。

## 为什么要单独走一条路

绘图模型不是对话模型。网关服务它们的端点是：

- `POST {baseURL}/images/generations` —— 文生图
- `POST {baseURL}/images/edits` —— 以图为参考改图（multipart）

而同一个模型 id 打 `POST {baseURL}/chat/completions` 会被拒（`400 This model is not supported on the Chat Completions
endpoint`）。DSH 的 LLM 适配器只说对话协议，所以绘图模型上不了那条路，给它声明图片输入也没用。本插件直接对接图片端点。

## 会话模型是传令兵，不是作者

默认 `promptMode: user-message` 时，插件自己去读调用会话**最近一条人类消息**：

- 消息**原文**就是提示词——会话模型不许改写、翻译、缩句或加戏；
- 消息里**第一张附件图**自动作为改图参考——用户贴图说「改成水彩」时，模型不需要给路径；
- 画面**全部**由画手生成，包括用户要求出现在图里的文字。

会话模型自己拟的提示词永远不会顶替用户原话：即使传了也会被丢弃，并在结果里注明。两个工具都会回显
`prompt sent`，任何时候都能看到真正发出去的提示词。

## 在设置里填画手网关

**设置 → 模型** 页面底部多了一张「画手模型（dsh-image-painter）」卡片：

- **网关地址（v1）**：画手模型所在的 OpenAI 兼容网关，例如 `https://your-gateway/v1`；
- **凭据名**：凭据库/环境变量里的名字，不是密钥本身；
- **默认画手模型 / 可选画手模型**、尺寸、产物目录、提示词模式、超时等；
- 「保存」写进当前 profile 的 `cordis.patch.yml` 里 `- id: image-painter` 那一行（不会新建第二份配置），
  注释保留、原子落盘、写前校验，宿主随即热更新——**下一次出图就用新值，不用重启**。

也就是说，你不需要手改 YAML：表单和 `cordis.patch.yml` 是同一份配置的两个入口，改哪边都一样。
表单只在宿主确实挂载了本插件时出现；换过 row id 也能自动找到（按 schema 特征匹配）。

## 绘画模式（每个会话独立）

| 命令 | 作用 |
|---|---|
| `/原文` | 进入绘画模式·原文：**完整原文**直接作为画手提示词 |
| `/优化` | 进入绘画模式·优化：先用**当前会话的对话模型**把用户的话润色成一条画手提示词，再交给画手 |
| `/退出绘画` | 关闭绘画模式，回到 `promptMode` 的默认行为 |
| `/绘画模式` | 查看当前状态 |
| `/painter [原文\|优化\|off]` | 宿主侧命令，同上（宿主命令名只能是 ASCII，中文那几个由浏览器端提供） |

- 模式**写进会话日志**（`image-painter/mode`），随会话恢复/分叉一起恢复；
- 开启期间输入框工具行会出现一枚 **绘画 chip**（`绘画·原文` / `绘画·优化`），点击在两种策略间切换，`✕` 退出；
- 开启期间会话获得一段简短的绘画模式说明，模型知道该调 `generate_image` / `edit_image` 而不是自己描述画面；
- `/优化` 用的是会话**当前选中的对话模型**，不需要额外配置；润色失败（没选模型、模型返回空）会自动**回退为原文**，
  并在结果 `note` 里说明；
- 同一条消息在同一个会话里只润色一次（按会话+原文记忆）。

## 安装

```
plugin_manager install_bundle /本包绝对路径
```

发布到 registry 之后：

```bash
dsh plugin --profile <profile> add dsh-image-painter
```

装好后**首次需要重启一次 `dsh web`**（宿主半边换的是新的模块代次，装载器不会热替换已加载的宿主模块）；
之后只改浏览器半边（`lib/client.js`）会由客户端 HMR 自动重载，不必重启。

## 配置

设置页表单最省事。也可以继续在 profile 的 `cordis.patch.yml` 里用同 id 覆盖（`config` 是**整体替换**，
需要改的字段要写全）：

```yaml
- id: image-painter
  name: dsh-image-painter
  config:
    baseURL: https://api.openai.com/v1   # 任何 OpenAI 兼容的图片端点
    apiKeyEnv: IMAGE_API_KEY             # 凭据名，不是密钥本身
    model: gpt-image-1
    models: [gpt-image-1]
    size: 1024x1024
    outputDir: image-gen                 # 相对会话工作区（"." 即工作区根）
    promptMode: user-message             # 或：model
    useSessionImages: true
    inline: true
    timeoutMs: 300000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | `https://api.openai.com/v1` | 图片端点前缀 |
| `apiKeyEnv` | `IMAGE_API_KEY` | 凭据名，经 `ctx.credentials` 解析 |
| `model` | `gpt-image-1` | 默认画手，可在 `models` 里按需换 |
| `models` | `[model]` | 允许选择的画手 id |
| `size` | `1024x1024` | 请求尺寸；网关可能返回自己的尺寸 |
| `outputDir` | `image-gen` | 产物写入的工作区目录 |
| `promptMode` | `user-message` | 绘画模式关闭时谁写提示词 |
| `useSessionImages` | `true` | 自动使用用户贴的图作为改图参考 |
| `inline` | `true` | 另存一份附件以便对话内联显示 |
| `timeoutMs` | `300000` | 单次出图超时 |

所有字段都是 volatile：改完立即生效，不重启、不重挂插件。

## 凭据

`apiKeyEnv` 写的是**引用**不是密钥。用 DSH 凭据库，或同名环境变量：

```bash
export IMAGE_API_KEY=sk-...
```

包里不含任何网关地址、模型 id 或账号信息。

## 用法

直接跟 Agent 说需求即可，会话模型会调工具：

- 「画一只戴蓝帽子的橘猫，扁平插画风格」→ `generate_image`
- 贴一张图说「把它改成水彩风格」→ `edit_image`（不用给路径）
- 先 `/优化` 再说「画一只戴蓝帽子的橘猫」→ 画手收到的是对话模型润色后的提示词

产物写到 `<会话工作区>/<outputDir>/`，当前对话模型能看图时同时内联显示。只读会话不写文件并会说明。
端点报错原样透出：`HTTP 402 … insufficient_balance`、`HTTP 400 … content policy` 都会带着上游原文与 request id 呈现。

## 已知边界

- 一次一张图，未开放 `n > 1`；改图一次一张参考图。
- **图里的文字**由画手负责，效果取决于模型：部分模型渲染中文容易出错。
- **上游内容策略**可能拒绝含真实人名的提示词，这与 DSH 和本插件无关。
- 哪些画手可用取决于网关背后的账号：同一网关上一个模型 200，另一个可能因上游账号欠费返回 402/503。
- `inline: true` 的附件副本正是对话里能看到图的原因；只要工作区文件就把 `inline` 设成 `false`。
- `/优化` 需要会话已经选中一个对话模型；没有可选模型时它自动回退为原文，不会让出图失败。
- 中文斜杠命令（`/原文`、`/优化`、`/退出绘画`、`/绘画模式`）由浏览器半边注册——宿主命令名的字符集只允许
  `[a-z][a-z0-9_-]*`，所以宿主侧叫 `/painter`。命令补全菜单里两者都能用。

## 依赖

- 运行时依赖：`@deepseek-ai/schemastery`（声明 volatile 配置 schema 用）；
- 浏览器半边是手写的懒加载 CJS 工厂包（`lib/client.js`），只用平台内置模块（react / react-dom / ui-slots /
  ui-primitives / client-store），**不需要构建步骤**。

## 发布

包没有 `private` 标记，补上自己的 `version`、`author`、`repository` 后可直接 `npm publish`。
无安装脚本。

### 隐私闸门

发布前有一道可重复执行的检查（`prepublishOnly` 会自动跑，也可单独执行）：

```bash
npm run privacy                                                   # 扫描将要发布的 tarball 内容
DSH_PRIVACY_FORBID='my-gw.example,MY_KEY_NAME' npm run privacy    # 顺带查自己的网关/凭据名（不必写进仓库）
```

`scripts/privacy-check.mjs` 先问 npm 要**这次发布真正会带上的文件清单**，再对每个文件扫描私钥块、各类 API key /
token 形状、家目录路径、邮箱，并拒绝任何不在预期白名单里的文件（`node_modules/`、lockfile、`tests/`、`scripts/`、
本地覆盖层、日志一律不得进入 tarball）。命中即 `exit 1`，发布中止。

本包的实际发布面固定为 10 个文件：`package.json`、`LICENSE`、`README.md`、`README.zh.md`、`cordis.patch.yml`、
`icon.svg`、`lib/index.js`、`lib/client.js`、`locale/zh.json`、`locale/en.json`。

**关键约定**：`apiKeyEnv` 只是凭据名，密钥由 `ctx.credentials` 在请求时解析——包里永远不存密钥。你自己的网关地址、
凭据名、账号只应写在 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/<profile>/`），密钥只应写在 DSH 凭据库
（`~/.dsh/.credentials.yaml`）或同名环境变量里——它们都不在本包目录内。

`.gitignore` 是第二道防线：拦截依赖（`node_modules/`）、`.env`/`.npmrc`/`*.key`/`credentials*`/`*token*` 等任何形式的
机密文件、`*.local.yml` 之类的本机覆盖层、日志，以及出图产物（`image-gen/`，万一某个会话的工作区正是本目录）。

## 许可

MIT，见 [LICENSE](LICENSE)。
