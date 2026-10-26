# dsh-openai-codex-image

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that signs in with a **ChatGPT account** (Codex OAuth) and generates images through the ChatGPT **subscription quota** instead of a paid API key.

[![CI](https://github.com/kkczx5428/dsh-openai-codex-image/actions/workflows/ci.yml/badge.svg)](https://github.com/kkczx5428/dsh-openai-codex-image/actions/workflows/ci.yml)
[English](README.md) | [中文](README.zh.md)

## Why

OpenAI's `gpt-image-2` is documented for the paid API-key path (`api.openai.com`). If you already pay for ChatGPT, an agent that calls the image API pays for the same model twice. This plugin follows the same route the Codex CLI uses:

```
POST https://chatgpt.com/backend-api/codex/responses
  tools: [{ type: "image_generation", model: "gpt-image-2", size }]
  tool_choice: { type: "image_generation" }
```

…authenticated with the ChatGPT OAuth access token + `chatgpt_account_id`. Image calls ride the ChatGPT subscription instead of API credits.

> This is an unofficial integration of a Codex CLI endpoint. It is not affiliated with OpenAI, and OpenAI may change the endpoint at any time. Make sure using it complies with the terms that apply to your account.

## Demo

Both images were generated with `generate_image` through a ChatGPT subscription account:

| `1024x1024` request (actual 1312x1199) | `1536x1024` + `quality=low` (actual 1672x941) |
|---|---|
| ![A red panda with round glasses using a laptop](docs/demo/red-panda.webp) | ![Minimalist lighthouse at dusk](docs/demo/lighthouse.webp) |

## Features

- `generate_image` tool: prompt → PNG file in your workspace, displayed inline in chat when the active model accepts image input.
- `openai_account` tool: status / device-code login / poll / logout.
- Auth resolution: plugin-owned OAuth record in DSH credentials first, then the local Codex CLI login (`~/.codex/auth.json`, **read-only**).
- Automatic token refresh for the plugin-owned record (refreshed tokens are written back to the same DSH credential record).
- No hard dependency on `@deepseek-ai/*` packages: the plugin only uses Node built-ins and the services on the DSH context, so it works as a locally installed bundle.
- Original SVG icon, localized metadata (en / zh).

## Requirements

- DSH Desktop (or a DSH profile with the `credentials`, `attachments`, `workingDirectory` and `llm` services).
- Node.js `^22.19.0 || >=24.0.0`.
- A ChatGPT account that can use Codex, logged in either through:
  - the Codex CLI (`codex login`), or
  - this plugin's device-code flow.

## Install

```bash
git clone https://github.com/kkczx5428/dsh-openai-codex-image.git
```

In a DSH session, ask the agent to run:

```
plugin_manager(action="install_bundle", target="<absolute path to the cloned directory>")
```

`install_bundle` links the directory into the active profile and appends the bundle to the profile. Restart DSH after changing plugin source; installing a new bundle applies immediately.

To remove it:

```
plugin_manager(action="remove_bundle", target="openai-codex-image")
```

## Usage

```
generate_image(prompt="A red panda with round glasses using a glowing laptop, cozy study, 3/4 view")
generate_image(prompt="...", size="1536x1024", quality="low", output_dir="assets")
```

| Parameter | Required | Description |
|---|---|---|
| `prompt` | yes | Image description; Chinese and English both work |
| `size` | no | `1024x1024` (default), `1536x1024`, `1024x1536`, `2048x2048`, `2048x1152`, `3840x2160`, `2160x3840` |
| `quality` | no | `auto` / `low` / `medium` / `high` |
| `model` | no | Image model, default `gpt-image-2` |
| `host_model` | no | Conversation model that hosts the `image_generation` tool; default from config |
| `output_dir` | no | Relative to the session workspace, or an absolute path; default `generated_images` |
| `file_name` | no | Optional file name (`.png` is appended, path parts are stripped) |

Returns `path`, actual `width`/`height`, `bytes`, `model`, requested `size`, optional `revised_prompt`, and an `image` attachment block when the active model accepts image input.

The backend snaps requested sizes to the aspect ratios it supports; the returned dimensions are the real ones.

### Account authorization

| Action | Purpose |
|---|---|
| `status` | Show auth source, account, plan, token expiry, image defaults |
| `login_start` | Start OpenAI device-code login; returns `https://auth.openai.com/codex/device` plus an 8-character code |
| `login_poll` | Call after finishing browser login to exchange and store the token |
| `logout` | Delete the plugin-owned credential (the Codex CLI login is left untouched) |

Device-code flow:

1. `openai_account(action="login_start")` → open the URL, enter the code;
2. complete the ChatGPT login in the browser;
3. `openai_account(action="login_poll")` → `authorized`;
4. `generate_image` now uses that authorization.

## Authentication sources

1. **Plugin credential** — DSH credential record `openai-image/chatgpt` (`kind: "grant"`, payload `{ type: "oauth", access, refresh, expires, accountId, ... }`). Refreshed automatically 60 seconds before expiry; refreshed tokens replace the same record.
2. **Codex CLI** — `~/.codex/auth.json` (`auth_mode: "chatgpt"`). Read-only: the plugin never writes to it, so token rotation in the Codex CLI stays consistent. If it is expired, the plugin asks you to run `codex login` or use the device-code flow.

## Configuration

All keys are optional and live in the bundle's `cordis.patch.yml` row config:

| Key | Default | Description |
|---|---|---|
| `authFile` | `~/.codex/auth.json` | Codex CLI login file |
| `hostModel` | `gpt-6.1-sol` | Conversation model hosting `image_generation` |
| `imageModel` | `gpt-image-2` | Image model |
| `defaultSize` | `1024x1024` | Default size |
| `outputDir` | `generated_images` | Default output directory |
| `timeoutMs` | `240000` | Per-request timeout, 30s–600s accepted |

## Troubleshooting

| Symptom | Meaning / fix |
|---|---|
| `HTTP 400 ... model is not supported when using Codex with a ChatGPT account` | The host model is unavailable for your account. Pass another `host_model` (values can be found in Codex's `models_cache.json`, e.g. `gpt-6.1-sol`, `gpt-6-sol`, `gpt-5.6-sol`). |
| `HTTP 401/403` | Authorization invalid or expired; run `openai_account(action="login_start")`. |
| `HTTP 429` | Rate or quota limit; wait for the subscription quota to reset. |
| Timeout | Raise `timeoutMs`; typical generations take 20–60 s, larger sizes longer. |
| Image not shown inline | The active model does not accept image input; the PNG is still saved at `path`. |

## Development

```bash
node --check index.js   # syntax
node scripts/smoke.mjs  # registration/schema smoke test, no network
```

Layout:

```
index.js            # all plugin logic (Host half, Node built-ins only)
cordis.patch.yml    # inserts the openai-codex-image row
package.json        # dsh.bundle.patch -> cordis.patch.yml
locale/en.json      # plugin manager title/description
locale/zh.json
icon.svg            # original SVG icon
scripts/smoke.mjs   # offline smoke test
generated/          # local test output (git-ignored)
```

Verified end-to-end on Windows (2026-10-26): real image generation through a ChatGPT subscription account, inline image results, sized and quality-controlled output, the error paths above, and the full device-code login (`login_start` → browser login → `login_poll` → credential stored in DSH → generation using that stored credential). CI covers the offline smoke test only; network and account flows need a real account.

## Security

- Tokens live only in the DSH credential store and in the Codex CLI's own `~/.codex/auth.json`; the plugin never logs or copies them.
- `logout` removes only the plugin-owned record; run `codex logout` separately to sign the Codex CLI out.
- Prompts are sent to OpenAI — that is inherent to image generation.
- See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

[MIT](LICENSE)
