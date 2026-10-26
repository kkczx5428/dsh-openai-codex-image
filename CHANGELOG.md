# Changelog

## 1.1.0 — 2026-10-26

- Add a Web settings page (`client.js`) registered as a `settings.section`
  ("ChatGPT Image"): authorization status (source / account / plan / expiry),
  device-code login, confirmation, sign-out, and the current image defaults.
  Localized in English and Chinese, styled with theme variables.
- Host: same-origin JSON routes under `/api/openai-codex-image/*`
  (`status`, `login/start`, `login/poll`, `logout`). They never return tokens —
  the account id is masked. Every request goes through the harness `connection`
  trust fence when mounted, with a structural loopback same-origin fallback.
- CI: syntax-check `client.js` and exercise the Web API routes, trust fence and
  manifest in the offline smoke test.
- Fix: export `./package.json` from `package.json`; DSH's client-module scan
  resolves a bundle manifest through that subpath and silently skips a package
  without it (the settings page would never appear).
- Client bundles load when the host starts, so a new or changed settings page
  requires a DSH restart.

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
