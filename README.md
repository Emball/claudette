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
- **Bulk** — on the `/chats` page, check conversations and hit **Export** in the selection bar. Several chats download as one ZIP with a Markdown file per conversation.

### Export format

| Content | Format |
|---|---|
| Messages | `**Your name:**` / `**Claude:**` inline (your name is a setting, default `User`) |
| Tool calls | `> **Action title**` blockquote; input and output as fenced blocks only when tool call content is on |
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
| Output type | MD | `.md` or `.txt` |
| Your name | User | Label for your turns in transcripts |
| Add Claudette header and footer | On | Wraps the transcript in `[Claudette Chat Export: "title"]` markers |
| Truncate large documents | On | Pasted/uploaded text over 40 lines is cut to its first and last 16 lines |
| Tag repeated documents | On | Repeats are matched by content, not filename, and replaced with a short tag |
| ↳ Keep first copy in full | Off | Leaves the first copy of each document uncut |
| Drop repeated session turns | On | Runs of turns already included earlier in a transcript are replaced by a short note |
| Trim transcript noise | On | Strips shell-cwd lines and collapses long runs of thinking lines |
| Truncate long code blocks | On | Claude's code over 20 lines keeps its first 10 and last 5 |
| Include thinking | Off | Thinking summaries |
| Include tool call summaries | On | A title line for each tool call |
| ↳ Include bash calls | Off | Bash tool calls and results |
| ↳ Include tool call content | Off | Tool input and output, each capped at 4,000 characters |
| ↳ Truncate long bash content | On | Same cut as documents for tool input and output |
| ↳ Skip repeat file reads | On | Drops bash reads of content already shown |
| Include images | On | Process images at all |
| ↳ Use OCR on screenshots | Off | OCR on screenshots (slow) |
| ↳ Package images in ZIP | On | Save images to ZIP |
| ZIP non-image files | On | Bundle uploaded files into ZIP |

The popup's **Clean up an old transcript** opens a page that applies these settings to an older export.

Prior Claudette transcripts pasted or attached to a chat are detected automatically, woven inline into the export without file wrappers, and truncated the same way if they haven't been already.

## Tweaks

- **Keep mic active when switching tabs** — keeps Claude.ai's voice input running while you work in another tab. Off by default.

## Experimental: Library

Tap the version number at the bottom of the popup four times to reveal the dev section. Its **Library** archives every conversation on the account you're logged into into local extension storage:

- **Sweep this account** fetches all of its chats (resumable; chats already stored are skipped).
- Sweep each account once while logged into it. The library is per Chrome profile and lists every account you've swept, with a per-account clear button.
- **Search library** opens a search page over everything you've swept, across all accounts. All words must match (use `"quotes"` for exact phrases), and it also searches code and commands Claude ran through tools. Filter by account or by who wrote the message. Each result shows the account it belongs to, so you know which login to switch to before opening the link.
- **Export full library (ZIP)** exports everything under your current export settings.

Chats swept by an older version don't have tool inputs stored. To add them, clear that account in the list (✕) and sweep it again.

## Coming soon

- **Session Chaining** — named groups of sessions; spawning a new chain chat injects the full prior context so Claude picks up seamlessly.
- **Prompt Library** — store and inject reusable prompts into the input box.

## Technical

- **Auth:** session cookie only — no API keys, no OAuth
- **API:** Claude's internal undocumented endpoints (same ones the frontend uses — may break on Anthropic UI changes)
- **OCR:** Tesseract.js v5 in a hidden extension-origin iframe; `eng.traineddata` cached in Cache Storage after first run
- **Concurrency:** 3 parallel conversation fetches for exports, library sweeps in batches of 20, 3 parallel OCR jobs, memory ceiling to prevent tab crashes
