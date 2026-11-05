<p align="center">
  <img src="https://raw.githubusercontent.com/Emball/claudette/main/icons/icon128.png" width="80" alt="Claudette">
</p>

<h1 align="center">Claudette</h1>

<p align="center">A Chromium extension companion to Claude.ai that adds several features catered to power users. No ads, no telemetry, clean UI.</p>

<p align="center"><em>Designed for Claude by Claude. They say we're soulmates!</em></p>

## Install

```bash
git clone https://github.com/Emball/claudette.git
```

1. Go to `chrome://extensions` → enable **Developer mode**
2. Click **Load unpacked** → select the `claudette` folder

**To update:** `git pull` inside the folder, then hit **↻** on the Claudette card in `chrome://extensions`.

## Chat Exporter

Export any Claude.ai conversation as Markdown or plain text, instantly using the following methods:

- **Single chat**: **Export** and **Copy** buttons in the top bar of any open conversation. Export downloads the file; Copy writes the same formatted text straight to your clipboard.
- **Bulk** — on the `/chats` page, check conversations and hit **Export** in the selection bar.

### Export format

| Content | Format |
|---|---|
| Messages | `**User:**` / `**Assistant:**` inline |
| Tool calls & output | `> **Action title**` blockquote + fenced block |
| Thinking blocks | `> *italic blockquote*` *(toggle: off by default)* |
| Artifacts | Fenced code block with filename as first-line comment |
| Uploaded files | `*<File: filename.ext>*` + fenced block |
| Pasted text | `*<Pasted>*` + fenced block |
| Screenshots (OCR on) | `*<Screenshot: filename>*` + extracted text in fenced block |
| Screenshots (OCR off) | `*<Screenshot: filename>*` + embedded in ZIP |
| Photos | `*<Photo: filename>*` + `![name](./filename)` |

### Export options

| Setting | Default | |
|---|---|---|
| Format | MD | `.md` or `.txt` |
| Include thinking | Off | Extended reasoning blocks |
| Include tool calls | On | Tool invocations and output |
| Include images | On | Process images at all |
| ↳ Use OCR | Off | OCR on screenshots (slow) |
| ↳ Package in ZIP | On | Save images to ZIP |
| ZIP non-image files | On | Bundle uploaded files into ZIP |
| Truncate large documents | On | Pasted/uploaded text over 40 lines is cut to its first and last 16 lines |
| ↳ Truncate embedded content | On | Same for file contents embedded in tool calls and long tool output |

Prior Claudette transcripts pasted or attached to a chat are detected automatically, woven inline into the export without file wrappers, and truncated the same way if they haven't been already.

## Coming soon

- **Session Chaining** — a local conversation library. Every chat you open gets absorbed into a local index. Chains are named groups of sessions; spawning a new chain chat injects the full prior context so Claude picks up seamlessly. Powers full-text search across your entire history.
- **Prompt Library** — store and inject reusable prompts into the input box.

## Technical

- **Auth:** session cookie only — no API keys, no OAuth
- **API:** Claude's internal undocumented endpoints (same ones the frontend uses — may break on Anthropic UI changes)
- **OCR:** Tesseract.js v5 in a hidden extension-origin iframe; `eng.traineddata` cached in IndexedDB after first run
- **Concurrency:** 3 parallel conversation fetches, 3 parallel OCR jobs, memory ceiling to prevent tab crashes
