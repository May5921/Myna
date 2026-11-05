# 30-second demo GIF

The README should open with a real 30-second recording, not a static screenshot. This file is the storyboard and recording checklist. It is not a generated GIF; record it on a real Myna window with a disposable session and redact anything private.

## Output

- 1280×820, 12–15 fps, ≤ 8 MB, loop forever.
- Keep text large enough to read on a phone; crop browser chrome if needed.
- Do not use a real API key, private repo path, customer name, or personal session title.

## Timeline

| Time | Scene | Action | On-screen proof |
|---|---|---|---|
| 0–3s | Hook | Start on an empty Myna window, then paste a short prompt | “one turn, one screen” |
| 3–8s | Turn folding | Let one turn finish; collapse the process block, expand it | thinking + 5 tools + duration + tok/s |
| 8–13s | Documents | Drag `notes.pdf` and `README.md` into the composer; send | attachment chips, extracted text in message |
| 13–18s | Tool work | Show a read/bash tool card, diff and image preview | real tool duration, diff, image |
| 18–23s | Steering | While generating, Ctrl+Enter a short correction | “waiting for current turn” row, then delivery |
| 23–28s | Crash recovery | Kill the pi process from Task Manager; send again | Myna resumes the same session, no blank screen |
| 28–30s | End card | Show “Windows · pi bundled fallback · no Node required” | install command / release URL |

## Recording

1. Launch a disposable copy with `MYNA_DEV=1` and a separate state file if possible.
2. Use a scratch workspace containing only `notes.pdf`, `README.md` and a tiny source file.
3. Record at 1280×820; hide the tray, notifications, and any other apps.
4. Capture with OBS/ShareX at 15 fps, then convert:

```powershell
ffmpeg -i demo.mkv -vf "fps=12,scale=1280:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" -loop 0 docs/images/demo.gif
```

If `ffmpeg` is unavailable, export MP4 and link it; do not fake a GIF from screenshots.

## Honesty rules

- If the data is scripted (demo hooks), label it as a UI demo, not a real model turn.
- Do not show a signed installer or auto-update if the build is unsigned.
- Do not show macOS/Linux/mobile.
