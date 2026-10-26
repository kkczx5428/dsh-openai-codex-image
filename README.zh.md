# dsh-openai-codex-image

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：用 **ChatGPT 账号**（Codex OAuth）授权，消耗 ChatGPT **订阅额度**生成图片，不走付费 API Key。

[English](README.md) | [中文](README.zh.md)

## 为什么做这个

OpenAI 的 `gpt-image-2` 官方只提供付费 API Key 路径（`api.openai.com`）。如果你已经订阅了 ChatGPT，Agent 再调 API 生图等于同一个模型付两次钱。这个插件复用 Codex CLI 的调用路径：

```
POST https://chatgpt.com/backend-api/codex/responses
  tools: [{ type: "image_generation", model: "gpt-image-2", size }]
  tool_choice: { type: "image_generation" }
```

请求带 ChatGPT OAuth access token 和 `chatgpt_account_id`，图片请求走订阅额度，不烧 API 余额。

> 这是对 Codex CLI 所用端点的非官方集成，与 OpenAI 无关联，端点可能随时变化。请自行确认使用方式符合你账号适用的条款。

## 效果示例

下面两张都是用 `generate_image` 通过 ChatGPT 订阅账号真实生成的：

| 请求 `1024x1024`（实际 1312x1199） | 请求 `1536x1024` + `quality=low`（实际 1672x941） |
|---|---|
| ![戴圆框眼镜用笔记本电脑的小熊猫](docs/demo/red-panda.webp) | ![黄昏灯塔极简插画](docs/demo/lighthouse.webp) |

## 功能

- `generate_image` 工具：prompt → 工作区里的 PNG 文件；当前模型支持图片输入时在对话中内联显示。
- `openai_account` 工具：查看状态 / 设备码登录 / 确认登录 / 退出授权。
- 授权优先级：插件自己保存在 DSH 凭据里的 OAuth 记录优先，其次只读复用本机 Codex CLI 的 `~/.codex/auth.json`。
- 插件内授权快到期时自动用 refresh token 刷新，并把新 token 写回同一条凭据记录。
- 不 import 任何 `@deepseek-ai/*` 包，只依赖 Node 内置模块与 `ctx` 上的服务，因此可以作为本地 bundle 直接安装。
- 原创 SVG 图标，中英文插件元数据。

## 环境要求

- DSH Desktop，或挂载了 `credentials`、`attachments`、`workingDirectory`、`llm` 服务的 DSH profile。
- Node.js `^22.19.0 || >=24.0.0`。
- 一个能使用 Codex 的 ChatGPT 账号，并且已经通过以下任一方式登录：
  - Codex CLI（`codex login`）；或
  - 本插件的设备码授权。

## 安装

```bash
git clone https://github.com/kkczx5428/dsh-openai-codex-image.git
```

在 DSH 会话里让 Agent 执行：

```
plugin_manager(action="install_bundle", target="<克隆目录的绝对路径>")
```

`install_bundle` 会把目录链接进当前 profile 并加入 bundle 列表。改源码后需要重启 DSH；新装 bundle 会立即生效。

卸载：

```
plugin_manager(action="remove_bundle", target="openai-codex-image")
```

## 使用

```
generate_image(prompt="一只戴圆框眼镜的小熊猫在木桌前用发光笔记本电脑，温暖书房，3/4 视角")
generate_image(prompt="...", size="1536x1024", quality="low", output_dir="素材")
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `prompt` | 是 | 画面描述，中英文均可 |
| `size` | 否 | `1024x1024`（默认）、`1536x1024`、`1024x1536`、`2048x2048`、`2048x1152`、`3840x2160`、`2160x3840` |
| `quality` | 否 | `auto` / `low` / `medium` / `high` |
| `model` | 否 | 生图模型，默认 `gpt-image-2` |
| `host_model` | 否 | 承载 `image_generation` 工具的对话模型，默认取配置 |
| `output_dir` | 否 | 相对会话工作目录或绝对路径，默认 `generated_images` |
| `file_name` | 否 | 可选文件名（自动补 `.png`，会去掉路径部分） |

返回 `path`、实际 `width`/`height`、`bytes`、`model`、请求的 `size`、可选 `revised_prompt`；模型支持图片输入时附带 `image` 附件块。

服务端会把请求尺寸吸附到它支持的画幅，返回值和界面以实际尺寸为准。

### 账号授权

| action | 作用 |
|---|---|
| `status` | 查看授权来源、账号、档位、token 到期时间、生图默认值 |
| `login_start` | 发起 OpenAI 设备码登录，返回 `https://auth.openai.com/codex/device` 和 8 位代码 |
| `login_poll` | 浏览器登录完成后调用，换取并保存 token |
| `logout` | 删除插件保存的授权（不影响 Codex CLI 的登录） |

设备码流程：

1. `openai_account(action="login_start")`，打开返回的网址并输入代码；
2. 在浏览器里完成 ChatGPT 登录；
3. `openai_account(action="login_poll")` → `authorized`；
4. 之后 `generate_image` 就使用这份授权。

## 授权来源

1. **插件内授权**：DSH 凭据记录 `openai-image/chatgpt`（`kind: "grant"`，payload 为
   `{ type: "oauth", access, refresh, expires, accountId, ... }`）。到期前 60 秒自动刷新，新 token 写回同一条记录。
2. **本机 Codex CLI**：`~/.codex/auth.json`（`auth_mode: "chatgpt"`）。只读，插件不改写，
   避免与 Codex CLI 的 refresh token 轮换互相踢下线。若已过期，插件会提示重新 `codex login`
   或改用设备码授权。

## 配置

全部可选，写在 bundle 的 `cordis.patch.yml` 行配置里：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `authFile` | `~/.codex/auth.json` | Codex CLI 登录文件路径 |
| `hostModel` | `gpt-6.1-sol` | 承载 `image_generation` 的对话模型 |
| `imageModel` | `gpt-image-2` | 生图模型 |
| `defaultSize` | `1024x1024` | 默认出图尺寸 |
| `outputDir` | `generated_images` | 默认输出目录 |
| `timeoutMs` | `240000` | 单次生图超时，接受 30s–600s |

## 失败排查

| 现象 | 含义 / 处理 |
|---|---|
| `HTTP 400 ... model is not supported when using Codex with a ChatGPT account` | 宿主模型对当前账号不可用。换一个 `host_model`（可用值见 Codex 的 `models_cache.json`，如 `gpt-6.1-sol`、`gpt-6-sol`、`gpt-5.6-sol`） |
| `HTTP 401/403` | 授权失效或过期，执行 `openai_account(action="login_start")` 重新授权 |
| `HTTP 429` | 触发频率或额度限制，等待订阅额度重置 |
| 超时 | 调大 `timeoutMs`；普通生图约 20–60 秒，大尺寸更久 |
| 图片没有内联显示 | 当前模型不接受图片输入；PNG 仍保存在 `path` |

## 开发

```bash
node --check index.js   # 语法检查
node scripts/smoke.mjs  # 离线冒烟测试：工具注册与 schema，无网络请求
```

目录结构：

```
index.js            # 插件全部逻辑（Host 半边，只用 Node 内置模块）
cordis.patch.yml    # 插入 openai-codex-image 行
package.json        # dsh.bundle.patch 指向 cordis.patch.yml
locale/en.json      # 插件管理器的标题/描述
locale/zh.json
icon.svg            # 原创 SVG 图标
scripts/smoke.mjs   # 离线冒烟测试
generated/          # 本地测试输出（git 忽略）
```

已在 Windows 上端到端验证（2026-10-26）：通过 ChatGPT 订阅账号真实出图、`generate_image` 返回内联图片、按尺寸与质量档位出图、上表错误路径，以及完整的设备码登录链路（`login_start` → 浏览器登录 → `login_poll` → 凭据写入 DSH → 用这份插件内授权出图）。CI 只覆盖离线冒烟测试，联网与账号流程需要真实账号。

## 安全说明

- token 只存在 DSH 凭据存储和 Codex CLI 自己的 `~/.codex/auth.json` 中，插件不记录、不复制、不打印 token。
- `logout` 只删除插件自己的凭据记录；要退出 Codex CLI 需另外运行 `codex logout`。
- prompt 会发送给 OpenAI，这是生图本身必需的。
- 漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE)
