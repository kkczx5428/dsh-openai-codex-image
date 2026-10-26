# Changelog

## 1.0.1 — 2026-10-26

- Verified the full device-code login end to end: `login_start` → browser login →
  `login_poll` → credential written to the DSH credential store
  (`openai-image/chatgpt`) → `generate_image` using that plugin-owned credential.
- Docs: replace the "not verified end to end" note with the completed verification
  result in both READMEs.
- Add this changelog.

## 1.0.0 — 2026-10-26

- Initial release.
- `generate_image` tool: `gpt-image-2` through the ChatGPT subscription quota via
  Codex OAuth, PNG written to the workspace, inline image result when the active
  model accepts image input.
- `openai_account` tool: `status` / `login_start` / `login_poll` / `logout`.
- Auth sources: plugin-owned DSH credential first, then read-only reuse of the
  local Codex CLI login.
- Automatic access-token refresh for the plugin-owned credential.
- Offline smoke test and GitHub Actions CI.
- Demo screenshots, English and Chinese READMEs, MIT license, security policy.
