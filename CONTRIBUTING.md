# Contributing

Thanks for taking a look. Myna is a Windows-first Electron shell for the pi coding agent; the renderer has no build step and the product intentionally stays close to pi's own semantics.

## Before you start

- Read [`AGENTS.md`](AGENTS.md) for the architecture map and constraints.
- For anything larger than a bug fix, open an issue first. The product boundary is deliberate: desktop rendering and desktop-only helpers, not a second agent runtime.
- Do not add a runtime dependency, a framework, or a bundler without discussing it first.

## Setup

```powershell
npm install
npm test
npm run check
```

`npm start` needs Node.js 20+ and a global pi CLI:

```powershell
npm install -g @earendil-works/pi-coding-agent
npm start
```

`npm run e2e` starts a real Electron instance. It hides the window by default; set `MYNA_E2E_SHOW=1` if you need to watch it. E2E does not call a model.

## What to change

- Pure logic belongs in `src/core/*.js` and needs a `tests/*.test.mjs` case.
- UI modules belong in `src/features/*.js`, export `init(ctx)`, inject their own CSS, and are registered in `src/app.js`'s `FEATURES`.
- Keep user-visible strings and docs consistent with actual behavior. If you change a limit or count, update the README, `llms.txt`, and `AGENTS.md` in the same PR.

## Pull requests

- Keep changes focused; one concern per PR.
- Include the commands you ran (`npm test`, `npm run check`, and `npm run e2e` when UI/streaming/queue/attachments changed).
- Update `CHANGELOG.md` under `Unreleased` for user-visible changes.
- Do not include screenshots of private sessions or personal paths.
- Do not commit, push, tag, or publish unless the maintainer asks.

## Reporting bugs

Include:

- Myna version and Windows version.
- What you expected vs. what happened.
- Whether pi was installed separately or the bundled one is in use.
- The last ~100 lines of `%LOCALAPPDATA%\Temp\myna.log`, with secrets removed.

Never paste API keys, session contents, or private repository paths into an issue.
