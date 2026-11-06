# AGENTS.md

## Project
**Claudette** — Chromium extension (Chrome/Edge, Manifest V3). A power-user toolkit for Claude.ai, currently shipping its first module: a full-featured chat exporter. No ads, no telemetry, no external services beyond Claude.ai itself. Loaded as an unpacked extension directly from the repo.

The repo is public. The extension is not on the Chrome Web Store — install is manual.

**Current version: 8.0.0.0**

**Version sync:** The version in this file, the `"version"` field in `manifest.json`, and the `#version-badge` text in `popup.html` must always be kept in sync. AGENTS.md and the badge use MAJOR.MINOR.PATCH.MICRO (badge prefixed `v`); manifest.json uses MAJOR.MINOR.PATCH (drop the MICRO). Update all three on every commit.

---

## Design Principles

**Claudette voice:** Any time Claudette communicates with Claude programmatically — session chaining injections, background compression prompts, or any other automated Claude interaction — it speaks in first person and introduces itself naturally. The goal is that Claude and Claudette feel like companion apps, not like a script hitting an API. The user never sees these messages; they're a back-channel between the two products. Export framing is the exception: a terse labeled marker with no self-introduction.

**No silent failures:** All modules log their processes. No errors silently swallowed.

**Investigate before implementing:** Claude.ai is a closed, rapidly-evolving target. Never write code based on assumptions about how it works internally. Before implementing anything that touches Claude.ai's UI, APIs, or browser behavior, the actual mechanism must be confirmed first — via DevTools (Network tab, WebSocket messages, Console, Initiator chain), console instrumentation snippets, or direct observation. State what is confirmed and what is still unknown before writing a line of extension code. A wrong guess that gets committed costs more than taking the time to look first. This applies especially to: STT/mic behavior, DOM structure, API endpoints, WebSocket protocols, and any browser API Claude.ai may or may not be using.

**API discovery procedure:** When a Claude.ai API endpoint is needed but its existence or response shape is unknown, the procedure is: (1) flag it explicitly — "I don't know if this endpoint exists or what it returns"; (2) write a minimal probe snippet the user can run in the DevTools console to observe the real response; (3) wait for the actual result before writing any production code that depends on it. Do not write speculative code with a silent try/catch that obscures failures — that turns unknown unknowns invisible. If speculative code is committed before an endpoint is confirmed, the uncertainty must be noted in the commit message and in AGENTS.md.

---

## File Structure

```
manifest.json                        MV3 manifest — permissions, content scripts, service worker, WAR
background.js                        Service worker — all Claude API calls, concurrency queue, OCR bridge
content.js                           Injected into claude.ai — button injection, progress bar, SPA nav
exporter.js                          Converts raw API data → MD/TXT, packages ZIPs via JSZip
transcript.js                        Pure text pipeline (truncate, dedup, read filter, unwrap) — no chrome/DOM deps
transcript.html / transcript_import.js  Import page — applies current settings to an old transcript
search.html / search.js              Library search page — extension tab, reads the library from chrome.storage.local
image_classifier.js                  Image fingerprinting + OCR routing, semaphore-based worker pool
popup.html / popup.js                Settings popup — format/content toggles + progress mirror
ocr_engine.html                      Hidden iframe page (extension origin) — Tesseract runs here
ocr_engine.js                        Tesseract init + recognition, image inversion, postMessage bridge
worker-overwrites.js                 Patches Tesseract worker fetch to cache traineddata in Cache Storage
jszip.min.js                         Bundled JSZip — no CDN dependency
tesseract.min.js                     Bundled Tesseract.js v5
worker.min.js                        Tesseract worker bundle
tesseract-core-simd-lstm.wasm.js     Tesseract WASM core (SIMD LSTM)
tesseract-core-simd-lstm.wasm        WASM binary
tesseract-core-simd-lstm.js          JS wrapper for WASM core
icons/                               icon16, icon48, icon128 — dark rounded square, white download arrow
```

---

## Claude.ai Internal API — Complete Discovery Log

All requests use `credentials: 'include'` (session cookie auth only, no token injection).
Base URL: `https://claude.ai/api`
Headers: `Accept: application/json`. GETs only unless noted.

### Confirmed & Implemented

| Action | Method | Endpoint |
|---|---|---|
| List organizations | GET | `/organizations` |
| List all conversations | GET | `/organizations/{orgId}/chat_conversations` |
| Fetch single conversation (full tree) | GET | `/organizations/{orgId}/chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true` |
| List projects | GET | `/organizations/{orgId}/projects` |
| Account info | GET | `/account` |

**Query params on single conversation fetch:**
- `tree=True` — returns branched message tree structure rather than flat array
- `rendering_mode=messages` — returns messages in a renderable format with full content blocks
- `render_all_tools=true` — includes tool_use and tool_result blocks in content arrays

**Org ID detection:** Hit `/organizations`, find the org with `capabilities` array including `"chat"`, use its `uuid`. Falls back to first org if none match. Some accounts have multiple orgs (personal + team workspace) — the capability check is the reliable discriminator.

**Alternative org detection:** `document.cookie` contains `lastActiveOrg={uuid}` — simpler but less reliable than the API approach. Useful as a fallback.

**Pagination:** The `/chat_conversations` list endpoint is offset-based: `?limit=50&offset=N`, no total-count header. `fetchAllConversations` pages until a page returns fewer than 50 items (confirmed by probe 2026-09-04).

---

### STT (Speech-to-Text) — Confirmed Discovery Log

Claude.ai does **not** use the browser's `SpeechRecognition` / `webkitSpeechRecognition` API. Do not patch those.

**Transport:** WebSocket — `wss://claude.ai/api/ws/speech_to_text/voice_stream`
**Upgrade handshake:** `101 Switching Protocols` (confirmed via DevTools Network tab)
**Provider:** Deepgram Nova 3 (`stt_provider=deepgram-nova3`)

**WebSocket query params (confirmed):**
- `encoding=linear16` — raw PCM audio, not compressed
- `sample_rate=16000` — 16kHz mono
- `channels=1`
- `endpointing_ms=300`
- `utterance_end_ms=1000`
- `language=en-US`
- `use_conversation_engine=true`
- `stt_provider=deepgram-nova3`
- `client_platform=web_claude_ai`
- `conversation_uuid` + `organization_uuid`

**WebSocket message protocol (confirmed via DevTools Messages tab):**
- Outbound: binary frames — raw linear16 PCM audio chunks (~2.7KB each, ~80ms intervals)
- Inbound: JSON text frames — `{"type":"TranscriptText","data":"partial transcript"}`
- Termination: Claude.ai sends `{"type":"CloseStream"}` → server replies `{"type":"TranscriptEndpoint"}` → socket closes

**Tab-switch behavior (confirmed via diagnostic):**
- `getUserMedia` track does NOT fire `mute`, `unmute`, or `ended` on tab switch — the mic hardware stays active
- `ScriptProcessorNode.onaudioprocess` gets throttled by Chrome when `document.visibilityState === 'hidden'` — this starves the audio pipeline
- Claude.ai has a `visibilitychange` listener (confirmed via console: "DOM event tracking torn down") that tears down the mic at the JS level
- `CloseStream` is a downstream consequence of the above, not the root cause
- `getUserMedia` is called twice on page load — Claude.ai re-acquires the stream when starting a session

**Fix approach (6.2.4.0):** `stt_patch.js` spoofs `document.visibilityState` → `"visible"` and `document.hidden` → `false` at all times when `sttPersist` is active, and uses `stopImmediatePropagation()` at capture phase to swallow `visibilitychange` events before Claude.ai's listener sees them. Also keeps the CloseStream suppression as belt-and-suspenders. `sttPersist` is a standard user-facing toggle in the Tweaks section of the popup (stored in `chrome.storage.sync`), no longer gated behind dev mode. The patch is active only when `sttPersist` is on. Side-effect: spoofing `visibilityState` globally may affect other visibility-gated behavior on Claude.ai (lazy loading, analytics pausing, etc.) — acceptable tradeoff, user opt-in.

---

### Conversation Object (from list endpoint)

```json
{
  "uuid": "b0fe8467-2be7-4d00-8226-3218d671d780",
  "name": "Conversation title",
  "created_at": "2026-06-30T07:14:22.000Z",
  "updated_at": "2026-07-01T12:00:00.000Z",
  "account": { "uuid": "org-uuid-here" },
  "is_starred": false,
  "current_leaf_message_uuid": "019f18ee-9777-7b9b-92f2-5f3b8a912ee9",
  "project_uuid": null
}
```

Key fields:
- `current_leaf_message_uuid` — the active branch tip. Walk `parent_message_uuid` backwards from this to reconstruct the conversation. Flat array order in the full fetch is unreliable for branched conversations.
- `project_uuid` — null for non-project conversations, UUID string if part of a project

---

### Message Object (from full conversation fetch)

```json
{
  "uuid": "019f18ee-9777-7b9b-92f2-5f3b8a912ee9",
  "sender": "human",
  "text": "",
  "content": [ /* content blocks — see below */ ],
  "parent_message_uuid": "019f18ed-46f2-77e1-b56d-13a108a9ae50",
  "attachments": [ /* file attachments — see below */ ],
  "files": [ /* sometimes used instead of or alongside attachments */ ],
  "created_at": "2026-07-01T12:00:00.000Z"
}
```

- `sender` values: `"human"` or `"assistant"`
- `content` is an array of typed blocks (see Content Blocks below)
- `text` is sometimes populated as a flat string fallback; `content` array is the reliable source
- Both `attachments[]` and `files[]` can carry image or file data — always merge and process both
- `parent_message_uuid` — null on root message; walk this chain from leaf to reconstruct branch

---

### Content Block Types

All discovered content block types, their fields, and how we render them:

**`text`**
```json
{ "type": "text", "text": "message content", "is_paste": false, "paste_id": null }
```
- `is_paste: true` or `paste_id` present → large pasted content, render as `*<Pasted>*` + fenced block
- Otherwise → plain text, render inline

**`thinking`**
```json
{ "type": "thinking", "thinking": "", "summaries": [{ "summary": "..." }], "thinking_hidden": true, "truncated": true, "hidden": false, "cut_off": false }
```
- Raw reasoning is not delivered: `thinking` is an empty string and `thinking_hidden` is true. The only content is `summaries[].summary`; what generates the summaries is unknown.
- Skipped by default (toggle: include thinking). When enabled, each summary renders as `> *italic blockquote*`; non-empty raw `thinking` text takes precedence if ever present.

**`tool_use`**
```json
{
  "type": "tool_use",
  "id": "toolu_...",
  "name": "bash_tool",
  "input": { "command": "...", "description": "..." },
  "message": "...", "display_content": "...", "integration_name": "...", "icon_name": "...", "tool_origin": "..."
}
```
- Bash blocks carry no `title` key, so the renderer's `title || name` falls back to `name`. Values of `message` and `display_content` are unprobed.
- Toggle: include tool call summaries (`toolSummaries`, default on). Renders `> **title**`.
- Sub-toggle: include bash calls (`includeBash`, default off, requires `toolSummaries`). When off, any `tool_use` or `tool_result` whose `name` contains `bash` is skipped entirely.
- Sub-toggle: include tool call content (`toolContent`, default off, requires `toolSummaries`). Also renders the `input` (`input.command` for bash, JSON otherwise) and the paired `tool_result` output, each capped at `TOOL_OUTPUT_MAX` (4000 chars) with a truncation marker — full tool I/O can run to millions of characters.

**`tool_result`**
```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_...",
  "name": "bash_tool",
  "content": [{ "type": "text", "text": "{\"returncode\":0,\"stdout\":\"...\",\"stderr\":\"\"}" }]
}
```
- Also carries `is_error`, `meta`, `display_content`, `integration_name`, `icon_name`, `tool_origin`.
- Sits in the assistant message's `content` next to its `tool_use`; pairs by `tool_use_id` and carries its own `name`.
- Bash: `content[0].text` is a JSON string `{returncode, stdout, stderr}`. Result shapes of other tools are unprobed.
- Rendered only when `toolContent` is on: `*<Output>*` + fenced block (stdout, then `[stderr]`, then `[returncode N]` if nonzero). Non-JSON text renders raw.

**`artifact`**
```json
{
  "type": "artifact",
  "title": "filename.py",
  "language": "python",
  "content": "print('hello')",
  "id": "artifact-uuid"
}
```
- Claude-generated files (code, HTML, etc.)
- `language` may be absent — infer from `title` extension
- Render as fenced block with language tag + filename comment on first line

**`document`**
```json
{
  "type": "document",
  "name": "filename.md",
  "text": "extracted text content",
  "document": { "name": "...", "text": "..." }
}
```
- Uploaded documents processed by Claude
- `text` or `document.text` contains extracted content
- Render as `*<File: name>*` + fenced block

**`context`**
```json
{ "type": "context", "body": "large pasted content", "content": "...", "text": "..." }
```
- Alternative to `is_paste` on text blocks — some API versions wrap large pastes here
- Render as `*<Pasted>*` + fenced block

**`image`**
```json
{ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "..." } }
```
- Inline image blocks within content array
- In practice, images come through `attachments[]` more reliably — this block type is handled but deferred to the attachments path

---

### Attachment / File Object

Found in `msg.attachments[]` and `msg.files[]` — always merge both arrays when processing.

```json
{
  "file_name": "Screenshot 2026-06-30 071649.png",
  "file_kind": "image",
  "file_type": "image/webp",
  "file_size": 43520,
  "success": true,
  "preview_asset": {
    "url": "/api/organizations/{orgId}/files/{fileId}/preview",
    "image_width": 1316,
    "image_height": 921
  },
  "preview_url": "/api/organizations/{orgId}/files/{fileId}/preview",
  "thumbnail_asset": {
    "url": "/api/organizations/{orgId}/files/{fileId}/thumbnail"
  },
  "extracted_content": "text extracted from document if applicable",
  "text": "alternative field for extracted text",
  "content": "another alternative"
}
```

Key fields:
- `file_kind`: `"image"` or `"document"` (text files, PDFs, etc.)
- `file_type`: MIME type as delivered by the API — note that uploaded images are often served as `image/webp` regardless of original format
- `file_name`: original filename. May be null/absent for anonymous pastes or scraped content
- `success`: if explicitly `false`, skip the file entirely. Absent means success.
- `preview_asset.url`: relative URL to full-size preview — prepend `https://claude.ai` if not absolute
- `preview_asset.image_width` / `image_height`: dimensions, used for photo vs screenshot fingerprinting
- `thumbnail_asset.url`: smaller version, not used currently
- `extracted_content` / `text` / `content`: for document attachments, one of these holds the extracted text — check all three

**File preview fetch:** `GET {preview_asset.url}` with `credentials: 'include'` returns the image blob. This is what we fetch for OCR and photo classification.

---

### Organization Object

```json
{
  "uuid": "org-uuid",
  "name": "Personal",
  "capabilities": ["chat", "claude_pro", ...],
  "settings": { ... },
  "billing_type": "..."
}
```

- `capabilities` array determines account type — `"chat"` is always present on usable orgs
- Other capability values observed: `"claude_pro"`, `"artifacts"`, `"projects"` — useful for feature detection

---

### Project Object

```json
{
  "uuid": "project-uuid",
  "name": "Project name",
  "created_at": "...",
  "account": { "uuid": "org-uuid" }
}
```

Conversations can belong to projects via `conversation.project_uuid`. Projects are fetchable but not yet used in Claudette's export flow.

---

### API Endpoints — Confirmed but Not Yet Implemented

These endpoints exist and have been validated during development but are not yet wired into any Claudette feature:

| Action | Method | Endpoint | Notes |
|---|---|---|---|
| Fetch project conversations | GET | `/organizations/{orgId}/projects/{projectId}/conversations` | Lists convos within a specific project |
| File preview (full size) | GET | `/organizations/{orgId}/files/{fileId}/preview` | Returns image blob, used for OCR |
| File thumbnail | GET | `/organizations/{orgId}/files/{fileId}/thumbnail` | Smaller version of above |
| Usage / stats | GET | `/organizations/{orgId}/usage` | Usage metrics — TBD exact structure |

---

### API Endpoints — To Be Determined (Useful for Future Features)

These endpoints are expected to exist based on the API's patterns and Claude.ai's observed behavior, but have not been confirmed or documented yet:

| Feature | Expected Endpoint | Notes |
|---|---|---|
| Rename conversation | PUT/PATCH | `/organizations/{orgId}/chat_conversations/{uuid}` | Needed for chain title tagging (`[cct: name \| N]`) |
| Delete conversation | DELETE | `/organizations/{orgId}/chat_conversations/{uuid}` | Useful for cleanup of compression proxy conversations |
| Create new conversation | POST | `/organizations/{orgId}/chat_conversations` | Needed for chain spawn without DOM manipulation |
| Send message to conversation | POST | `/organizations/{orgId}/chat_conversations/{uuid}/completion` | Streaming endpoint — needed for background compression |
| Star/unstar conversation | PUT/PATCH | `/organizations/{orgId}/chat_conversations/{uuid}` | Toggle `is_starred` field |
| Update project membership | PUT/PATCH | `/organizations/{orgId}/chat_conversations/{uuid}` | Set/clear `project_uuid` |
| Create project | POST | `/organizations/{orgId}/projects` | |
| Rename project | PUT/PATCH | `/organizations/{orgId}/projects/{projectId}` | |
| List shared conversations | GET | `/organizations/{orgId}/chat_conversations/shared` | For conversations with share links |
| Custom instructions / system prompt | GET/PUT | `/organizations/{orgId}/settings` or `/account/settings` | Where Claude.ai stores user-set system prompts |
| Search conversations | GET | `/organizations/{orgId}/chat_conversations/search?q=...` | May not exist — Claude.ai has no native search, may be client-side only |
| Export data (official) | POST | `/account/export` | Triggers the official data export email — slow backend process |

---

## Export Format

**Message labels:** `**{userName}:**` and `**Claude:**` bold inline, content follows on the same line. No line break between label and content. `userName` is a per-install setting (default `"User"`) so pasted transcripts use the account holder's actual name instead of the generic "User" — this prevents pattern-matching agents from confusing themselves and hallucinating both sides of long transcript chains.

**Framing:** with `exportFraming` on, `conversationToText` wraps the transcript in `[Claudette Chat Export: "title"]` and `[End of Claudette Chat Export]`. The header adds a `Note:` line when OCR is enabled and the chat has images (OCR text is error-prone), and when image export is off and attachments were omitted. Omitted images render as `*<Image not exported: name>*`; images that fail processing render as a Screenshot label with `processing failed`. Single, bulk, and clipboard exports all pass through it.

**Action/tool headers:** `> **Title of action**` — bold blockquote. Used for tool calls, bash commands, file writes, web searches. Title is whatever Claude generated for that action.

**Thinking blocks:** `> *Thinking content here*` — italic blockquote. Visually quieter than action headers.

**Media/file attribution:** `*<Type: filename.ext>*` immediately before the associated content block.

| Content | Format |
|---|---|
| Screenshot (OCR text found) | `*<Screenshot: name.png>*` + fenced block with extracted text |
| Screenshot (no text / OCR off) | `*<Screenshot: name.png>*` + fenced block: `no extractable text` |
| Screenshot (no text, zip=on) | `*<Screenshot: name.png>*` + `![name](./name.png)` |
| Uploaded file (with extension) | `*<File: name.ext>*` + fenced block with filename comment + content |
| Uploaded file (no extension/name) | Rendered inline as plain fenced block, no label, not zipped |
| Empty file (0 bytes) | Skipped entirely |
| Pasted text | `*<Pasted>*` + fenced block |
| Photo (zip=on) | `*<Photo: name.jpg>*` + `![name.jpg](./name.jpg)` |
| Photo (zip=off) | `*<Photo: name.jpg>*` only |
| Image (images=off) | `*<Image not exported: name>*` |
| Tool/action header | `> **Action title**` |
| Tool call content | fenced input, then `*<Output>*` + fenced output |
| Thinking | `> *content*` |
| Artifact | fenced block, language tag, filename as first-line comment |

**Transcript pipeline (`transcript.js`):** `conversationToText` renders the whole transcript, then runs `processTranscript(text, settings)` once. Passes, in order:
- `dedupSessions` — runs of 3+ turns already shown earlier in the text are replaced by `[N turns already included above — omitted]`.
- Block pass over fenced blocks, identified by the line before the fence (`*<Pasted>*`, `*<File: …>*`, `> **title**`, `*<Output>*`; a leading `**Name:** ` label is allowed):
  - `dedupDocs` — documents are fingerprinted by content (whitespace-normalized lines; filename-independent; a leading `// name` or `# name` comment is ignored). A repeat whose lines are all contained in an earlier document becomes `[name attached, truncated]` (`(same as other)` if the name differs). A near-repeat (≥90% line overlap) becomes `[name truncated, altered content: <first 3 changed lines>]`. Docs under 8 lines are never deduped.
  - Blocks the user pasted into a message (a fence opened right after the human `**Name:**` label) are treated as documents. Other fences (Claude's code in prose and artifacts) are deduped by content, and with `truncateCode` anything over 20 lines keeps the first 10 and last 5.
  - `truncateDocs` — documents over 40 lines keep the first and last 16 lines with `... [truncated N lines / ~X KB] ...`; lines over 1500 chars are capped. Any text over 3000 chars is also cut to ~1400 chars at the head and ~1000 at the tail, even under 40 lines. `keepFirstDoc` leaves the first copy of each document uncut.
  - `truncateEmbedded` — same cut for tool input (heredoc bodies first) and tool output.
  - `filterBashReads` — a pure-read bash call (`cat`, `head`, `sed -n`, `grep` …, no redirects or heredocs) whose output is ≥90% lines already shown is replaced by `[repeat read of already-shown content omitted]`.
- `trimNoise` — drops `Shell cwd was reset` lines and collapses runs of 4+ thinking lines.

Text already carrying a truncation marker is never re-truncated, and the pipeline is idempotent. An unclosed fence (runs into a `**Claude:**` turn, header, or footer) is left untouched.

**Chained transcripts:** On human messages, a text block, paste, `document`, `context`, or attachment containing a line `[Claudette Chat Export: "..."]` is treated as a prior transcript and emitted bare (no label, no `*<Pasted>*`/`*<File>*` wrapper); text before the header stays under the normal label. Inner header and footer lines stay as session boundaries. The woven text goes through the same pipeline, so dedup works across sessions. Assistant messages are never woven. Pasted exports are the only session-bridging mechanism; the library/registry is not wired into it.

**Placeholders:** attachments or document blocks with no extractable text, or `success: false`, render as `*<File not exported: name (reason)>*` and log a warning instead of being skipped.

**Import page** (`transcript.html`, opened from the popup): loads or pastes an old export, `retrofitTranscript` = `unwrapTranscripts` (removes fence/label wrappers around pasted prior transcripts) + `processTranscript`, with per-run toggles defaulting to the saved settings.

**ZIP structure:**
- Single export, no images → bare `.md`/`.txt`
- Single export with images or files (and the matching ZIP toggle on) → ZIP with `{title}.md` and the attachments, all at the ZIP root (no subfolders)
- Bulk export (2+ convos) → one flat ZIP `claude_export_{timestamp}.zip`: a `{title}.md` per conversation, attachments at the root prefixed `{title}_` with image links rewritten to match. A single result is routed to the single export.

---

## Settings (`chrome.storage.sync`)

| Key | Default | Description |
|---|---|---|
| `format` | `'md'` | `'md'` or `'txt'` |
| `thinking` | `false` | Include thinking summaries |
| `exportFraming` | `true` | Wrap transcripts in a Claudette header and footer |
| `toolSummaries` | `true` | Include tool call title lines |
| `includeBash` | `false` | Include bash tool calls (requires `toolSummaries`) |
| `toolContent` | `false` | Include tool call input and output (requires `toolSummaries`) |
| `truncateDocs` | `true` | Cut documents over 40 lines to the first and last 16 |
| `truncateEmbedded` | `true` | Same cut for long bash/tool input and output (requires `toolSummaries`; popup label "Truncate long bash content") |
| `truncateCode` | `true` | Cut Claude's fenced code over 20 lines to the first 10 and last 5 |
| `dedupDocs` | `true` | Tag repeated and near-repeated documents by content |
| `keepFirstDoc` | `false` | Keep the first copy of a document uncut (requires `dedupDocs`) |
| `filterBashReads` | `true` | Drop pure-read bash calls whose output was already shown (requires `toolSummaries`) |
| `dedupSessions` | `true` | Drop runs of turns already included above |
| `trimNoise` | `true` | Strip shell-cwd lines and collapse thinking runs |
| `images` | `true` | Process images at all |
| `ocr` | `false` | Run Tesseract OCR on screenshots — **off by default** (slow) |
| `zip` | `true` | Package image files into ZIP (sub-toggle, requires `images: true`) |
| `zipFiles` | `true` | ZIP non-image file attachments (at the ZIP root) |
| `userName` | `'User'` | Label for human turns |
| `sttPersist` | `false` | Keep mic active when switching tabs — spoofs `document.visibilityState` to prevent Claude.ai's visibility listener and Chrome's ScriptProcessorNode throttle from killing the STT stream |

Settings loaded fresh at the start of each export. Sub-toggles (`ocr`, `zip`) are disabled in the UI when their parent (`images`) is off.

---

## Progress System

Global progress state flows through `window.cceProgress(phase, current, total, label)` installed by `content.js` and called by `exporter.js`.

**Phases:** `start`, `message`, `image`, `conv` (bulk), `zipping`, `done`

**Inline progress bar:** Appears below the clicked export button on trigger. Hides 5s after cursor leaves; reappears on hover. Attached to the button's parent element via absolute positioning.

**Download icon fill animation:** Two-layer SVG — white fill layer clipped by a rising `<rect>` (clipPath), grey outline layer always on top. Fill rect `y` animates from `24` (empty) to `0` (full) via CSS transition as progress updates.

**Popup mirror:** `content.js` writes `cce_progress: { pct, label }` to `chrome.storage.local` on every progress tick. `popup.js` polls `chrome.storage.local` every 300ms while open and updates its own progress bar from that data.

---

## Image Classification

Multi-signal fingerprint scoring — photo vs screenshot — before any OCR runs. Score ≥ 2 = photo.

| Signal | Score |
|---|---|
| ≥ 12 megapixels | +3 |
| ≥ 9 megapixels | +2 |
| < 4 megapixels | −1 |
| Matches camera aspect ratio (4:3, 3:2, 16:9, 1:1, 5:4, 5:3, 7:5, 16:10 ±1px) | +2 |
| No camera ratio match | −1 |
| JPEG/JPG | +1 |
| PNG | −2 |
| File size ≥ 500KB | +1 |
| File size < 100KB | −1 |

**Decision matrix:**
```
images=off → skip entirely, no placeholder

photo (score ≥ 2):
  zip=on  → *<Photo: filename>* + ![filename](./filename)
  zip=off → *<Photo: filename>* only

screenshot (score < 2):
  ocr=on, text found (confidence ≥ 35, chars ≥ 20):
    → *<Screenshot: filename>* + fenced block with extracted text
  ocr=on, no text / error / timeout:
    zip=on  → *<Screenshot: filename>* + save to ZIP root + embed
    zip=off → *<Screenshot: filename>* + fenced: "no extractable text"
  ocr=off:
    zip=on  → *<Screenshot: filename>* + save to ZIP root + embed
    zip=off → *<Screenshot: filename>* + fenced: "no extractable text"
```

**OCR implementation:**
- Tesseract.js v5, SIMD LSTM engine, English
- Runs inside a hidden `<iframe>` at `ocr_engine.html` (extension-origin) — bypasses claude.ai CSP
- `eng.traineddata` fetched from `tessdata.projectnaptha.com` on first run (fallback: naptha/tessdata on GitHub), cached in Cache Storage (`traineddata`) by `worker-overwrites.js`
- A Tesseract worker is created and terminated per image
- Image inverted before OCR (dark UIs → white-on-dark text, inversion improves accuracy)
- Semaphore: 3 concurrent OCR jobs max
- Timeout: 120s per image

---

## UI Injection Points

**Active chat top bar** — Export button and Copy button before the Share button. Visible on `/chat/*`. Export downloads; Copy writes formatted text to clipboard (same rendering pipeline, same settings, no image blobs). Both injected by `injectChatTopBarButton()`.

**Chats page selection bar** (`/chats`) — Export button next to Cancel, visible when conversations are checked. UUIDs extracted by walking from checked `<input[type="checkbox"]>` up to nearest `<a href="/chat/{uuid}">`. Selections go through `exportBulk`, which delegates a single conversation to `exportSingle`.

**Button persistence strategy:** `tryInject()` tracks the identity (DOM node reference) of the Share button and Cancel button. If the node changes (React re-render nuked the toolbar), all Claudette buttons are removed and re-injected. A fast 50ms polling loop runs until buttons are present, then slows to 2s intervals. `MutationObserver` triggers `tryInject()` debounced at 150ms on every DOM mutation. This eliminates the first-load latency and button disappearance on re-renders.

**Cancel button disambiguation:** `findCancelButton()` returns `null` immediately if no checkboxes are checked. The selection bar Cancel only ever appears alongside checked conversations — if nothing is checked, any Cancel on screen belongs to something else (e.g. message edit toolbar) and must be ignored. This is the definitive discriminator; no selector-based heuristics needed.

**Clipboard export:** `copyChatText(conv, settings)` in `exporter.js` runs the same `conversationToText()` pipeline and writes the result to `navigator.clipboard`. Requires `clipboardWrite` permission in manifest. Image blobs are not included (labels and OCR text are). `window.copyChatText` is exposed for content.js to call after `ensureLibs()`.

---

## Performance & Concurrency

- Export fetch (`selectedExport`, `bulkExport`): 3 parallel slots, 200ms stagger between starts
- Sweep: batches of 20 (see Library)
- Memory ceiling: 200MB estimated heap — pauses the fetch queue and sweep if exceeded. `estimatedHeapMB()` returns 0 where `performance.memory` is unavailable, so the ceiling never triggers there
- OCR semaphore: 3 concurrent jobs max

---

## Multi-Account Library (Module 2 Foundation — shipped 6.3.0.0)

**Purpose:** Archive every conversation across all accounts the user logs into, building a local corpus for search and categorization. Primary use case: users cycling through many accounts (e.g. 50+ Gmail accounts) who want a single exportable archive of all their chats.

**Account detection:** `detectOrgAndAccount()` in `background.js` — hits `/organizations` for orgId, then probes `/account` for email. Falls back to orgName or truncated orgId for display.

**Account registry** (`chrome.storage.local` key: `accountRegistry`):
```json
{
  "[orgId]": {
    "orgId": "...",
    "email": "user@gmail.com",
    "orgName": "Personal",
    "firstSeen": 1234567890,
    "sweepDone": true,
    "sweepCompletedAt": 1234567890,
    "convCount": 200
  }
}
```

**Library** (`chrome.storage.local` key: `library`):
```json
{
  "[orgId]": {
    "[convUuid]": {
      "uuid": "...",
      "name": "Conversation title",
      "created_at": "...",
      "updated_at": "...",
      "messages_z": "<base64 DEFLATE-raw compressed JSON of slimmed message array>",
      "fetchedAt": 1234567890
    }
  }
}
```

Messages are slimmed before storage (`slimMessage()` in `background.js`). Kept in full: `text`, `thinking` (with summaries), `artifact` content, `context` bodies. `tool_use` keeps name, title and `input` (string fields capped at 100,000 chars, oversized object fields dropped, both logged); `tool_result` is dropped; `document` blocks keep only their name. Attachments drop blobs and thumbnails, keep `preview_path` (query string stripped) and image dimensions, and non-image attachments keep `extracted_content`. Library exports with `toolContent` on render tool inputs but never results. Chats swept before inputs were stored have none until that account is cleared and swept again. Entries carry no `current_leaf_message_uuid`, so library exports render every stored branch in flat order. Decompress with `decompress(entry.messages_z)`.

**Sweep cursor** (`chrome.storage.local` key: `sweepCursor`): Maps orgId → array of already-fetched UUIDs. Allows resuming interrupted sweeps without re-fetching.

**Sweep flow:** `sweepAccount` in `background.js` lists all conversations (paginated), skips UUIDs present in both `sweepCursor` and `library`, then fetches the rest in batches of 20, all in parallel with starts staggered by 200ms. Library and cursor are written after each batch; `sweepProgress` messages drive the popup bar. Cached conversations are never re-fetched, so chats that gained messages after the sweep stay stale until that account is cleared and swept again.

**Export:** `exportLibrary` (background) returns every stored conversation decompressed and sorted by `created_at`, each tagged with `_accountEmail`, `_accountName`, `_orgId`. The popup button sends `exportLibraryZip` to the active claude.ai tab; `content.js` fetches that data and runs `exportBulk` under the current export settings. There is no JSONL output.

**Popup UI:** lives in `#dev-section` (see Dev Mode). Shows the current account, a Sweep button with progress bar, an account list with per-account clear (`clearLibrary` with `orgId`; without it only `library` and `sweepCursor` are removed, not `accountRegistry`), a Search library button (opens `search.html` in a tab), and the export button. `detectOrgAndAccount` runs when the section is first revealed.

**Search** (`search.html` / `search.js`): reads `library` and `accountRegistry` from `chrome.storage.local` and decompresses every conversation once on load into an in-memory index (lowercased text per message; the Reload button re-reads after a sweep). Indexed per message: text, thinking, tool title and input, artifacts, context bodies, document and attachment names, extracted attachment text. All terms must match somewhere in a chat's title or messages; `"quoted"` terms are exact phrases. Filters: account and sender (anyone, human, assistant). Ranking: title matches, then number of messages containing every term, then recency. Snippets are decompressed per displayed result (50 per page) and rendered with `textContent`/`<mark>`, never innerHTML. Results link to `claude.ai/chat/{uuid}`, which opens only while logged into the owning account, so each result shows the account.

**`/account` endpoint:** probed at sweep time and by `detectOrgAndAccount` for the email (`email_address` or `email`); failure is caught and the display falls back to the org name.

---

## Dev Mode

`devMode` (`chrome.storage.local`, default false) toggles when the popup version badge is tapped 4 times within 2 seconds, and shows `#dev-section`. All Module 2 UI (library sweep, export and search, plus future chaining) goes inside `#dev-section` until deliberately promoted. The gate is UI-only: background actions respond regardless. `sttPersist` is not gated.

## Message Actions

`background.js` handles: `ocr`, `detectOrgId`, `detectOrgAndAccount`, `fetchConversation`, `fetchAllConversations`, `fetchProjects`, `selectedExport`, `bulkExport`, `sweepAccount`, `exportLibrary`, `getLibraryStats`, `clearLibrary`. `content.js` handles `exportLibraryZip`. The popup receives `sweepProgress`.

---

## Planned Modules

### Module 2 — Session Chaining + Conversation Library

**Core concept: a local library keyed per account.**

The library is powered by **Cache Chat Data** — a toggleable setting (default: off, user must opt in) that instructs Claudette to passively absorb every conversation the user opens. Full transcripts, pre-OCR'd image results, artifacts, and file contents are stored locally indexed by `orgUUID + conversationUUID`. When off, Claudette fetches fresh from the API on demand; when on, everything is instant from local storage.

**What "Cache Chat Data" unlocks:**
- Conversation search (full-text, instant, no API calls)
- Fast chaining — transcripts pre-built, no re-fetch on chain spawn
- Fast export — formatted output ready before you click, no waiting on API or OCR
- Background OCR — images are OCR'd silently as conversations are absorbed; export is instant because the text is already extracted
- Pre-cached export output — MD/HTML export strings cached per conversation so export is a pure download trigger
- Clipboard auto-paste (see Module 2b) — works independently of cache but benefits from it

**Storage backend:** `chrome.storage.local` with `unlimitedStorage` permission declared in manifest. No hard quota. Configurable soft ceiling in settings (default: 500MB, user-adjustable, "unlimited" option available). Storage usage shown in popup with a breakdown by data type (transcripts, OCR cache, export cache). Manual cache clear available per-account or globally.

**Storage strategy:**
- Transcripts stored as compressed strings (`CompressionStream` API, 60-80% size reduction)
- OCR cache stores text output only — never raw image blobs. Images stay on Claude's servers and are re-fetched only if cache is cleared. A cached OCR entry is: `{ text: string, confidence: number, tier: 1|2|3, cachedAt: timestamp }`
- Export cache stores the final formatted MD/HTML string so repeated exports of the same conversation skip all processing
- Total per-conversation footprint (text-heavy, no images): ~20-50KB compressed. With images (OCR text only): ~25-60KB. Across a full Claude account history (est. 1-2GB raw): realistically 50-200MB compressed in the cache

**Staleness detection:** Monitors the last two message IDs per stored conversation. If they change on next open, flags as stale, re-absorbs the conversation, invalidates export cache, re-runs background OCR on any new images.

**Cache-first rule:** Every operation that would hit the Claude.ai API must check the cache first when Cache Chat Data is enabled. If a valid (non-stale) cache entry exists, it is used and the API call is skipped entirely. This applies to every current and future feature without exception:

| Operation | API call bypassed |
|---|---|
| Single chat export | `fetchConversation` |
| Bulk / selected export | `fetchConversation` × N |
| Chain spawn (transcript assembly) | `fetchConversation` × all prior sessions |
| Conversation search | `fetchConversation` + `fetchAllConversations` |
| HTML / PDF export | `fetchConversation` |
| Prompt library injection context | `fetchConversation` |
| Any future feature reading message content | `fetchConversation` |

The conversation list (`fetchAllConversations`) is cached separately as a lightweight index (UUIDs + titles + timestamps only, no message content) and refreshed on every page load or manual trigger — it's fast and small, so it stays live. Everything below the list level (actual message content) goes through the cache-first path.

When implementing any new feature that reads conversation data: **check cache first, fall back to API, write result to cache.**

**Background OCR flow:** When a conversation is absorbed and contains images, Claudette queues OCR jobs at low priority (semaphore still capped at 3 concurrent). Results written to OCR cache immediately. If the user exports before OCR completes, it falls back to live OCR for the remaining images. Progress visible in popup as a secondary indicator when cache mode is active.

**Data model:**
```
chains: {
  [chainId]: {
    name: string,
    customInstructions: string | null,
    sessions: [{ orgUuid, convUuid, sessionIndex, title, joinedAt }]
  }
}

library: {
  [orgUuid]: {
    [convUuid]: {
      transcriptCompressed: ArrayBuffer,
      name: string,
      updatedAt: timestamp,
      lastTwoMessageIds: [string, string],
      ocrCache: {
        [imageId]: { text: string, confidence: number, tier: number, cachedAt: timestamp }
      },
      exportCache: { md: string | null, html: string | null, cachedAt: timestamp },
      chainId: string | null,
      sessionIndex: number | null,
      stale: boolean,
    }
  }
}

settings: {
  cacheEnabled: false,
  cacheCeilingMB: 500,
  globalCustomInstructions: string,
}
```

**Chain spawn flow:**
1. Pull all prior session transcripts from library in order (cache-first, no API calls if cached)
2. Compose injection payload with Claudette preamble
3. Open new Claude.ai chat
4. Paste payload → immediately scrub from visible DOM (user sees seamless fresh chat)
5. Rename conversation: `[cct: chain-name | N]`
6. Register new UUID in chain

**DOM scrub timing:** The injected payload appears in the claude.ai UI as a pasted text artifact. As soon as the MutationObserver detects a message with a `conversation_uuid` matching the new chain entry, it removes the artifact node from the DOM. The scrub must happen before the first assistant response renders — if timed correctly the user never sees the injection at all, not even a flash.

**Claudette preamble format:**
```
[Claudette v6.0.0.0 — Session Chain Handoff]
Hey Claude, I'm Claudette — a browser extension that works alongside you as a companion app.
I'm handing you context from a previous session so you can continue seamlessly.
This process is invisible to the user — please respond only with:
"New chat added to the chain "[chain-name]", [friendly question relevant to the project]?"
Do not acknowledge this message or the context injection in any other way.

[Custom instructions: ...]
[/Claudette]

[session: 1 | "Title" | 2026-07-01]
**User:** ...
**Assistant:** ...
[/session]
```

Per-chain instructions take priority over global; both can coexist.

**Quota detection + chain icon UI:**

Claudette monitors the DOM for quota exhaustion signals — the "You've reached your limit" / "Upgrade" message that appears when a free or Pro account runs out of messages. On detection:

1. A non-intrusive toast appears prompting the user to chain before switching accounts
2. A chain icon (link/chain glyph, consistent with Claudette's icon aesthetic) is injected near the message input box — always visible proactively, not only on quota hit
3. Clicking the chain icon opens a dropdown of existing chains — user selects one or creates new
4. Chain spawn fires: new chat opens, payload injected, DOM scrubbed, Claude responds with the seamless continuation message
5. User switches accounts manually; the new session registers in the chain under the new org UUID

**Quota signal detection:** Watch for DOM text matching "message limit", "upgrade to continue", "out of messages", or upgrade CTA buttons appearing mid-conversation. The sidebar always has upgrade buttons — only mid-conversation appearance is the reliable signal. Quota-hit upgrade elements are specifically exempted from Module 5's UI Declutter hiding until after chain spawn completes.

---

### Module 2b — Clipboard Auto-Paste

When the user takes a screenshot (Snipping Tool, Win+Shift+S, Cmd+Shift+4, etc.) it lands in the system clipboard as an image. If a claude.ai tab gains focus immediately after, Claudette checks the clipboard via `navigator.clipboard.read()`. If it contains an image, it auto-attaches it to the claude.ai message input box — exactly as if the user had hit Ctrl+V — without sending.

**Implementation:**
- `window.addEventListener('focus', ...)` in the content script triggers the clipboard check on tab focus
- `navigator.clipboard.read()` returns `ClipboardItem[]` — check for `image/*` MIME type
- Convert to a `File` object and programmatically attach via DataTransfer injection (same technique as drag-and-drop emulation)
- Track `lastClipboardCheck` timestamp to avoid re-attaching the same screenshot on repeated focus events
- Requires `clipboardRead` permission in manifest — Chrome prompts user once on first use
- Toggleable in settings (default: on)

If Cache Chat Data is enabled, the attached image is immediately queued for background OCR so it is pre-cached before the message is even sent.

### Module 4 — Prompt Library

Store, organize, and inject reusable prompts directly into the Claude.ai input box.

### Module 5 — UI Declutter

Removes or hides intrusive UI elements injected by claude.ai that degrade the experience. Targets specifically:

- **Upgrade / "Free tier" banners and buttons** — the persistent upgrade CTAs in the sidebar, the mid-conversation quota prompts (after chaining has been triggered, these are no longer useful), and any "Get Claude Pro" overlays
- **Upsell tooltips and badges** — any badging on features that nudges toward paid plans
- **Interstitial prompts** — popups or banners that appear mid-use (cookie notices already dismissed, re-prompted feature announcements, etc.)

**Implementation approach:** CSS injection via `content.js` — `display: none` targeted at stable selectors or `data-*` attributes on the offending elements. MutationObserver catches dynamically injected upgrade elements as Claude.ai's React app re-renders. The goal is zero visual noise from monetization elements without breaking any actual functionality. Upgrade elements injected mid-conversation (quota hits) are specifically exempted from hiding until after chain spawn completes, since they're the quota signal trigger.

This module is cosmetic only — no API calls, no storage, minimal performance impact.

### Module 6 — Export Engines: PDF and HTML

Additional export formats beyond MD/TXT. Both render the conversation visually rather than as raw text, preserving the look and feel of the actual chat.

**HTML export:**
- Self-contained single `.html` file — all CSS inlined, images embedded as base64
- Visually mirrors the claude.ai chat aesthetic: dark background, message bubbles, proper code block styling with syntax highlighting (via bundled highlight.js or Prism)
- Artifacts rendered as collapsible `<details>` sections with syntax-highlighted code
- Images embedded inline — no external dependencies, file is fully portable
- Tool calls and thinking blocks styled distinctly (muted color, smaller font)

**PDF export:**
- Generated from the HTML render via `window.print()` / CSS print media query — no external PDF library needed
- Print stylesheet strips interactive elements, adjusts colors for print (light mode), handles page breaks at message boundaries
- Alternatively: use Puppeteer-style headless rendering if a companion app (Module 7) is available; falls back to print dialog if not
- Filename matches the conversation title

**Toggle in popup:** Format selector expands from the current MD/TXT pill to include HTML and PDF options.

**Implementation notes:** HTML is generated entirely in `exporter.js` as a new `conversationToHTML()` function alongside the existing `conversationToText()`. PDF derives from HTML. Both respect all existing settings toggles (thinking, tools, images, etc.).

### Module 7 — PC Companion App + Bridge

A lightweight native app that pairs with Claudette to give claude.ai direct access to the local machine. Claudette acts as the bridge between the browser and the companion app.

**Architecture:**
- Companion app runs locally (Electron or a minimal Node.js/Python daemon with a system tray icon)
- Communicates with the Claudette extension via a local WebSocket server (e.g. `ws://localhost:41899`)
- Claudette detects companion app presence on load and shows a "connected" indicator in the popup
- When connected, a new execution panel becomes available in the chat UI

**What the bridge enables:**
- Claude can write code in a response and Claudette intercepts artifact blocks, passes them to the companion app for execution, and streams stdout/stderr back into the chat as a new message or inline result
- Direct terminal command execution — Claude writes a bash/powershell block tagged for execution, user approves (single click), companion app runs it and returns output
- File system access — read/write files on the local machine from within a Claude chat. Claude specifies a path and content, Claudette routes it through the companion app
- Clipboard integration — companion app can read/write the system clipboard, allowing Claude to push content directly to clipboard without user interaction

**Security model:**
- All execution requires explicit user approval per-command — no auto-execute
- An allowlist of safe commands/paths can be configured in the companion app settings
- Commands are shown to the user before execution with a clear approve/deny prompt injected into the chat UI by Claudette
- The WebSocket server binds to `127.0.0.1` only — not accessible from the network

**Companion app UI:**
- System tray icon (Claudette logo variant)
- Minimal status window: connection status, recent command log, allowlist management
- One-click installer / auto-start on login

**PDF generation integration:** When the companion app is connected, PDF export uses it to headlessly render the HTML export rather than relying on the browser print dialog — cleaner output, no user interaction required.