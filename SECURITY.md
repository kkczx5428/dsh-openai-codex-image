# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's
[Security Advisories](https://github.com/kkczx5428/dsh-openai-codex-image/security/advisories/new)
rather than opening a public issue. Include reproduction steps and the affected
version. You will get an acknowledgement as soon as possible.

## What this plugin touches

- **Credentials.** OAuth tokens obtained by the device-code flow are stored in the
  DSH credential store under `openai-image/chatgpt`. The plugin can also read the
  local Codex CLI login at `~/.codex/auth.json`, read-only.
- **Network.** Requests go to `auth.openai.com` (OAuth device flow, token refresh)
  and `chatgpt.com/backend-api/codex/responses` (image generation). Prompts are
  sent to OpenAI as part of the generation request.
- **Files.** Generated PNG files are written to the configured output directory
  (default `generated_images`), relative to the session working directory.

## What the plugin does not do

- It does not log, print, or copy access/refresh tokens.
- It does not write to the Codex CLI's `auth.json`.
- It does not read browser data, cookies, or any credential source other than the
  two above.
- It does not collect telemetry.

## Scope note

`CLIENT_ID` and the OAuth endpoints are the public values used by the Codex CLI
and pi-ai; they are not secrets. This project is an unofficial integration with
no affiliation to OpenAI.
