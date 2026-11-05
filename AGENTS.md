# AGENTS.md

This file is for coding agents working on Myna. It describes the project, the commands, and the constraints that are easy to get wrong.

## What this is

Myna is an Electron desktop client for the pi coding agent. The renderer is plain ES modules with no build step. The main process bridges pi's RPC mode (`pi --mode rpc`) and exposes a narrow `window.pi` API through `preload.cjs`.

- Product name: Myna
- Repository: `May5921/Myna` (local directory may still be `pi-mini`)
- Target: Windows 10/11 x64
- Runtime deps: `shiki`, `fflate`, `pdfjs-dist`
- Dev deps: `electron`, `electron-builder`, `rcedit`

## Commands

```powershell
npm install
npm test          # node:test unit tests
npm run check     # node --check all source files + contract checks
npm run e2e       # real Electron, 17 scenarios; history-dependent assertion count; window hidden by default
$env:MYNA_DEV=1; npm start   # dev watcher; legacy PI_MINI_DEV still works
npm run build:portable
npm run build:zip
npm run build:installer
```

E2E needs a real Electron window internally; set `MYNA_E2E_SHOW=1` only when you need to watch it. E2E does not call a model.

## Layout

- `main.js` — Electron main process, pi RPC subprocess, IPC, tray, packaging helpers, dev watcher.
- `preload.cjs` — exposes only `window.pi`.
- `src/app.js` — pi event consumption, message rendering, history, input, TPS.
- `src/core/*.js` — pure logic with node:test coverage (turn model, assistant message, metrics, provider store, input trigger, queue store, RPC attachments, doc extraction).
- `src/features/*.js` — self-contained UI modules registered in `FEATURES`; each exports `init(ctx)` and injects its own CSS. First-run onboarding lives in `onboarding.js` and skips under E2E.
- `tests/*.test.mjs` — unit/contract tests.
- `scripts/e2e/scenarios.mjs` — browser-side assertions injected into the real renderer.

## Constraints

- Keep the zero-build setup: no bundler, no framework, no new runtime dependency without an explicit decision.
- Do not move product state back into the DOM. Pure state belongs in `src/core`.
- Do not commit, push, tag, or publish unless the operator asks.
- Before changing files while an Electron instance is running, check `.dev-quiet`; it disables auto-reload.
- Windows is the only supported target today. Do not add macOS/Linux packaging claims without building and testing them.
- The terminal feature is a one-shot PowerShell command runner, not a PTY.
- `steer` is delivered by pi after the current assistant turn finishes its tool calls, before the next LLM call. Do not describe it as instant.
- Session list refresh is a 2.5s filename-fingerprint poll in `main.js`; external pi processes are detected there, not via RPC events.

## Testing rules

- New pure logic goes in `src/core` and gets a `tests/*.test.mjs` case.
- New UI behavior needs an e2e scenario only if it is hard to cover as pure logic.
- After changes run: `npm test`, `npm run check`, and `npm run e2e` when UI/queue/attachments/streaming changed.
- Keep docs honest: update test counts, scenario counts, dependency lists, and feature limits in the same change.

## Release notes

- `package.json` version drives the release.
- `npm run release <version>` updates the version, runs tests, builds, tags, and uploads the release.
- The installer is currently unsigned; do not claim otherwise.
- Third-party licenses are listed in `THIRD-PARTY-NOTICES.md`; build scripts copy pi and pdfjs licenses into the package.
