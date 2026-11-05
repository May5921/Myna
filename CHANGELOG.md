# Changelog

All notable changes to Myna are documented here. The format follows Keep a Changelog; versions use the release tag.

## Unreleased

### Added

- First-run onboarding: workspace → model → a real test message, with readable failures.
- Markdown (`.md`, `.markdown`) attachments: dropped files are extracted as text and sent with the prompt.
- One-click update flow: checks GitHub Releases, downloads the installer, verifies SHA256, then launches it. Release builds now publish `.sha256` assets.
- System-pi preference: when a full global pi >= 1.5.0 is installed, Myna uses it instead of the bundled bundle, restoring extension SDK compatibility (subagent etc.). `MYNA_BUNDLED_PI=1` forces the bundle.
- Settings → About shows whether pi came from the system install or the bundled fallback.
- External session refresh: sessions created by another pi process appear in the sidebar within ~2.5s.
- `MYNA_*` environment variables; legacy `PI_MINI_*` names still work.
- `THIRD-PARTY-NOTICES.md`, including bundled pi and pdfjs license handling in build scripts.
- `llms.txt`, `AGENTS.md`, `CONTRIBUTING.md`, and this changelog for human and AI contributors.
- Unit tests for provider config normalization, `@`/`/` trigger detection and ranking, queue persistence, RPC attachment payloads, Markdown extraction, and clock formatting.
- Real Electron E2E coverage for the queue dock: enqueue, edit, delete, and clear without calling a model.
- Real Electron E2E coverage for the first-run onboarding flow with an intercepted test prompt.
- Crash recovery E2E now fails when the renderer does not actually observe `process_exit`, instead of recording a false-positive pass.
- Process exit errors now offer an explicit “重启 pi” action in the UI.
- First-run model testing now fails immediately on pi process exit, provider errors, or an aborted run instead of waiting for the timeout or marking the test successful.
- Copied diagnostics now include the latest pi exit code and a short, redacted pi stderr summary; raw provider output stays in the local log.

### Changed

- Running-turn timer now uses `H:MM:SS` instead of an ever-growing `123.4s` seconds counter.
- Steer messages keep a visible “waiting for the current turn to finish” row until pi echoes them.
- Steer payloads now use pi's `{type, data, mimeType}` image format and include extracted document text.
- Tool partial results are coalesced to 80ms instead of rebuilding the whole tool card on every update.
- Live Markdown freezes its prefix once the tail exceeds 3000 characters, avoiding O(n²) re-parsing on long answers.
- E2E runs hide the Electron window by default and skip the tray icon; set `MYNA_E2E_SHOW=1` to watch.
- CI runs unit tests and checks on both Ubuntu and Windows.
- Docs were corrected to match actual test counts, scenario counts, dependencies, terminal behavior, and tok/s semantics.
- Release/installer docs and scripts now support optional Azure Trusted Signing or a traditional PFX; unsigned builds still warn and are not described as signed.
- `release --dry` now only runs local tests and syntax checks; it does not modify the version, build artifacts, commits, tags, or remote state.

### Fixed

- `localhost:port` and bare `host:port` were rejected by the right-panel URL validator.
- The queue module could throw `QUEUE_STORE_NEW is not defined` after the queue-store extraction.
- A blank Electron window could appear during E2E runs.
- Steer images were previously sent as raw attachment objects and could be dropped by pi.
- Windows installer builds now invoke the local electron-builder CLI directly and verify the generated installer version, avoiding Node 24 `npx.cmd` failures and stale artifact misreporting.
- Session refreshes now ignore stale `get_state` responses from an earlier session epoch, preventing a fast session switch from restoring the previous session pointer.
- Failed workspace changes now restore the previous cwd, session list, history, project order, and right-panel workspace state after the main process rolls back.
- The first `agent_start` now persists the session pointer early enough for crash recovery during a brand-new session's first turn.
- System file opens now surface the error returned by Windows instead of reporting success when no application can open the path.
- Portable builds now fail when the bundled pi runtime is missing instead of generating a misleading package that requires a separate pi install.

## 0.1.1 — 2026-11-04

- Stable workspace switching; session list renders before pi restarts.
- Switch sessions by painting local history first.
- Large sessions parse only the tail records for the first paint.
- NSIS installer and portable zip; bundled pi; desktop shortcut.

## 0.1.0 — 2026-11-03

- First public Windows build: session list, streaming messages, thinking/tool folding, queue/steer, right panel, settings, terminal, tray.
