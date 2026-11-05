// exporter.js — converts raw Claude API conversation data to MD and packages ZIP

const EXPORTER_DEFAULTS = {
  format:        'md',
  thinking:      false,
  toolSummaries: true,
  includeBash:   false,
  toolContent:   false,
  images:        true,
  ocr:           false,
  zip:           true,
  zipFiles:      true,
  userName:      'User',
  exportFraming: true,
  truncateDocs:  true,
  truncateEmbedded: true,
};

const TOOL_OUTPUT_MAX = 4000;

function capText(text) {
  if (text.length <= TOOL_OUTPUT_MAX) return text;
  return `${text.slice(0, TOOL_OUTPUT_MAX)}\n[truncated ${text.length - TOOL_OUTPUT_MAX} chars]`;
}

function toolInputText(input, settings) {
  if (!input || typeof input !== 'object') return '';
  const trunc = settings && settings.truncateEmbedded;
  if (typeof input.command === 'string')
    return trunc ? truncateToolInput(input.command) : input.command;
  return JSON.stringify(trunc ? truncateInputObject(input) : input, null, 2);
}

// --- Truncation + chained transcript helpers ---
// Large documents and embedded tool-call content are cut to the first and last
// TRUNC_KEEP lines. Anything already carrying a truncation marker is left alone,
// so re-processing a pasted transcript never double-truncates.

const TRUNC_KEEP  = 16;
const TRUNC_SLACK = 8;
const TRUNC_MARKER_RE = /^\.\.\. \[truncated \d+ lines \/ ~\d+ KB[^\]]*\] \.\.\.\s*$/m;
const CHAIN_HEADER_RE = /^\[Claudette Chat Export: .*\]\s*$/m;
const CHAIN_FOOTER_RE = /^\[End of Claudette Chat Export\]\s*$/;
const CHAIN_HEADER_LINE_RE = /^\[Claudette Chat Export: /;
const CLAUDE_TURN_RE = /^\*\*Claude:\*\* /;

function truncMarker(skipped) {
  const kb = Math.max(1, Math.round(skipped.join('\n').length / 1024));
  return `... [truncated ${skipped.length} lines / ~${kb} KB] ...`;
}

function truncateLines(text) {
  if (TRUNC_MARKER_RE.test(text)) return text;
  const lines = text.split('\n');
  if (lines.length <= TRUNC_KEEP * 2 + TRUNC_SLACK) return text;
  const skipped = lines.slice(TRUNC_KEEP, lines.length - TRUNC_KEEP);
  console.log(`[exporter] truncated ${skipped.length} lines (~${skipped.join('\n').length} chars)`);
  return [
    ...lines.slice(0, TRUNC_KEEP),
    truncMarker(skipped),
    ...lines.slice(lines.length - TRUNC_KEEP),
  ].join('\n');
}

// Shell command text: truncate heredoc bodies first (the embedded file content),
// then fall back to plain line truncation if the command is still long.
function truncateToolInput(text) {
  if (TRUNC_MARKER_RE.test(text)) return text;
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    out.push(line);
    i++;
    const m = line.match(/(?<!<)<<-?\s*(['"]?)([A-Z_][A-Z0-9_]*)\1(?=\s|$|[|;&)>])/);
    if (!m) continue;
    let j = i;
    while (j < lines.length && lines[j].trim() !== m[2]) j++;
    if (j >= lines.length) continue;
    const body = lines.slice(i, j);
    if (body.length > TRUNC_KEEP * 2 + TRUNC_SLACK) {
      const skipped = body.slice(TRUNC_KEEP, body.length - TRUNC_KEEP);
      console.log(`[exporter] truncated heredoc '${m[2]}': ${skipped.length} lines`);
      out.push(...body.slice(0, TRUNC_KEEP), truncMarker(skipped), ...body.slice(body.length - TRUNC_KEEP));
    } else {
      out.push(...body);
    }
    i = j;
  }
  return truncateLines(out.join('\n'));
}

function truncateInputObject(input) {
  const out = {};
  for (const [k, v] of Object.entries(input))
    out[k] = typeof v === 'string' ? truncateLines(v) : v;
  return out;
}

function docText(text, settings) {
  return settings.truncateDocs ? truncateLines(text) : text;
}

// Splits text at the first Claudette export header. Returns null if none.
function splitChained(text) {
  const m = CHAIN_HEADER_RE.exec(text || '');
  if (!m) return null;
  return {
    before:     text.slice(0, m.index).trim(),
    transcript: text.slice(m.index).trim(),
  };
}

// Applies truncation to the fenced blocks of an already-rendered transcript.
// Only pasted/uploaded file blocks (*<Pasted>*, *<File: ...>*) and tool call
// input/output blocks are touched; code in prose and artifacts are left alone.
function truncateTranscript(text, settings) {
  if (!settings.truncateDocs && !settings.truncateEmbedded) return text;
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^(\*\*[^*\n]{1,40}:\*\* )?(`{3,})[^`\r]*\r?$/);
    if (!m) { out.push(line); i++; continue; }

    let prev = '';
    if (!m[1]) {
      for (let k = out.length - 1; k >= 0; k--) {
        if (out[k].trim()) { prev = out[k].trim(); break; }
      }
    }
    let kind = null;
    if (/^\*<(Pasted|File: .*)>\*$/.test(prev)) kind = 'doc';
    else if (prev.startsWith('> **')) kind = 'input';
    else if (prev === '*<Output>*') kind = 'output';

    let j = i + 1;
    while (j < lines.length && lines[j].replace(/\r$/, '') !== m[2]
           && !CHAIN_FOOTER_RE.test(lines[j]) && !CHAIN_HEADER_LINE_RE.test(lines[j])
           && !CLAUDE_TURN_RE.test(lines[j])) j++;
    const closed = j < lines.length && lines[j].replace(/\r$/, '') === m[2];

    out.push(line);
    if (!closed || !kind) { i++; continue; }

    let body = lines.slice(i + 1, j).join('\n');
    if (kind === 'doc' && settings.truncateDocs) body = truncateLines(body);
    else if (kind === 'input' && settings.truncateEmbedded) body = truncateToolInput(body);
    else if (kind === 'output' && settings.truncateEmbedded) body = truncateLines(body);
    out.push(...body.split('\n'), lines[j]);
    i = j + 1;
  }
  return out.join('\n');
}

// Parts are { text, chained }. A chained part is a prior transcript pasted into
// this message; it is emitted bare (no label, no file/paste wrapper) so the
// sessions read as one continuous transcript.
function chainedParts(chained, settings) {
  const parts = [];
  if (chained.before) parts.push({ text: chained.before });
  console.log('[exporter] chained transcript detected, weaving inline');
  parts.push({ text: truncateTranscript(chained.transcript, settings), chained: true });
  return parts;
}

function plainTextParts(text, isHuman, settings) {
  const chained = isHuman ? splitChained(text) : null;
  return chained ? chainedParts(chained, settings) : [{ text: text || '' }];
}

function pastedParts(content, isHuman, settings) {
  const chained = isHuman ? splitChained(content) : null;
  if (chained) return chainedParts(chained, settings);
  const body = docText(content, settings);
  const f = safeFence(body);
  return [{ text: `*<Pasted>*\n${f}\n${body}\n${f}` }];
}

function toolResultText(block) {
  const raw = (Array.isArray(block.content) ? block.content : [])
    .map(c => (c && typeof c.text === 'string' ? c.text : ''))
    .join('\n');
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'stdout' in parsed) {
      const out = [];
      if (parsed.stdout) out.push(parsed.stdout);
      if (parsed.stderr) out.push(`[stderr]\n${parsed.stderr}`);
      if (parsed.returncode) out.push(`[returncode ${parsed.returncode}]`);
      return out.join('\n').trim();
    }
  } catch (e) {
    console.log('[exporter] tool_result text is not JSON, rendering raw');
  }
  return raw;
}

// Returns a backtick fence string safe to wrap `content` in.
// Finds the longest run of backticks in the content and uses one more (min 3).
function safeFence(content) {
  const runs = content.match(/`+/g) || [];
  const max  = runs.reduce((m, r) => Math.max(m, r.length), 2);
  return '`'.repeat(max + 1);
}

function loadSettings() {
  return new Promise(resolve =>
    chrome.storage.sync.get(EXPORTER_DEFAULTS, resolve)
  );
}

// --- Progress reporting ---
// Calls window.cceProgress(phase, current, total, label) if defined.
// content.js installs that hook; exporter works fine without it.

function reportProgress(phase, current, total, label) {
  try {
    if (typeof window !== 'undefined' && typeof window.cceProgress === 'function')
      window.cceProgress(phase, current, total, label);
  } catch(e) { /* never block export on progress errors */ }
}

// --- Message chain builder ---

function buildMessageChain(conv) {
  const msgMap = {};
  const messages = conv.chat_messages || [];
  messages.forEach(m => { msgMap[m.uuid] = m; });

  const leafUuid = conv.current_leaf_message_uuid;
  if (!leafUuid || !msgMap[leafUuid]) {
    console.log('[exporter] no leaf uuid, falling back to flat order');
    return messages;
  }

  const chain = [];
  let cur = msgMap[leafUuid];
  while (cur) {
    chain.unshift(cur);
    cur = cur.parent_message_uuid ? msgMap[cur.parent_message_uuid] : null;
  }
  console.log(`[exporter] built chain: ${chain.length} messages from leaf`);
  return chain;
}

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9_\-. ]/gi, '_').trim().slice(0, 80);
}

function inferLang(filename, content) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const langMap = {
    js: 'js', ts: 'ts', py: 'python', rb: 'ruby', go: 'go',
    rs: 'rust', java: 'java', cpp: 'cpp', c: 'c', cs: 'csharp',
    html: 'html', css: 'css', json: 'json', yaml: 'yaml', yml: 'yaml',
    sh: 'bash', bash: 'bash', md: 'md', sql: 'sql', swift: 'swift',
    kt: 'kotlin', php: 'php', r: 'r', scala: 'scala',
  };
  return langMap[ext] || '';
}

// --- Image routing ---

async function classifyAndRouteFile(file, images, settings, imageIndex, imageTotal) {
  // Support both live API response (preview_asset.url) and slimmed library cache (preview_path)
  const rawUrl = file.preview_asset?.url || file.preview_url || file.preview_path || null;
  const previewUrl = rawUrl
    ? (rawUrl.startsWith('http') ? rawUrl : `https://claude.ai${rawUrl}`)
    : null;

  const fname = file.file_name || 'image';
  const imgLabel = settings.ocr ? `OCR: ${fname}` : `Image: ${fname}`;

  reportProgress('image', imageIndex, imageTotal, imgLabel);

  if (!previewUrl)
    return `*<Screenshot: ${fname}>*\n\`\`\`\nno preview available\n\`\`\``;

  // Dimensions may come from preview_asset (live) or from stored image_width/height (library cache)
  const width  = file.preview_asset?.image_width  || file.image_width  || null;
  const height = file.preview_asset?.image_height || file.image_height || null;

  const result = await ImageClassifier.classify(
    previewUrl, width, height, images.length, settings
  );

  if (result.tier === 'skip') return '';

  if (result.tier === 'photo-nozip')
    return `*<Photo: ${fname}>*`;

  if (result.tier === 'screenshot-text') {
    const f = safeFence(result.text);
    return `*<Screenshot: ${fname}>*\n${f}\n${result.text}\n${f}`;
  }

  if (result.tier === 'screenshot-notext')
    return `*<Screenshot: ${fname}>*\n\`\`\`\nno extractable text\n\`\`\``;

  // 'save' — write blob to ZIP root
  if (result.tier === 'save' && result.blob) {
    const ext   = result.blob.type.split('/')[1] || 'webp';
    const iname = file.file_name || `image_${images.length + 1}.${ext}`;
    images.push({ filename: iname, blob: result.blob });
    const isPhoto = result.isPhoto;
    return `*<${isPhoto ? 'Photo' : 'Screenshot'}: ${iname}>*\n![${iname}](./${iname})`;
  }

  return `*<Screenshot: ${fname}>*\n\`\`\`\nfetch failed\n\`\`\``;
}

// --- Content block renderer ---

async function contentBlocksToParts(blocks, images, nonImageFiles, settings, imgCounters, isHuman) {
  if (!Array.isArray(blocks)) return [];
  const parts = [];
  const add = text => parts.push({ text });

  for (const block of blocks) {

    if (block.type === 'thinking') {
      if (settings.thinking) {
        const thought = (block.thinking || block.text || '').trim();
        if (thought) {
          add(`> *${thought}*`);
        } else if (Array.isArray(block.summaries)) {
          for (const s of block.summaries) {
            const t = ((s && s.summary) || '').trim();
            if (t) add(`> *${t}*`);
          }
        }
      }
      continue;
    }

    if (block.type === 'text') {
      if (block.is_paste || block.paste_id) {
        parts.push(...pastedParts((block.text || '').trim(), isHuman, settings));
      } else {
        parts.push(...plainTextParts(block.text || '', isHuman, settings));
      }
      continue;
    }

    if (block.type === 'tool_use') {
      if (!settings.toolSummaries) continue;
      const name = block.name || 'tool';
      if (!settings.includeBash && name.toLowerCase().includes('bash')) continue;
      const title = block.title || name;
      add(`> **${title}**`);
      if (settings.toolContent) {
        const input = capText(toolInputText(block.input, settings).trim());
        if (input) { const f = safeFence(input); add(`${f}\n${input}\n${f}`); }
      }
      continue;
    }

    if (block.type === 'tool_result') {
      if (!settings.toolSummaries || !settings.toolContent) continue;
      if (!settings.includeBash && (block.name || '').toLowerCase().includes('bash')) continue;
      let output = toolResultText(block).trim();
      if (settings.truncateEmbedded) output = truncateLines(output);
      output = capText(output);
      if (output) { const f = safeFence(output); add(`*<Output>*\n${f}\n${output}\n${f}`); }
      continue;
    }

    if (block.type === 'image') {
      if (!settings.images) continue;
      console.log('[exporter] inline image block — skipping, handled via files[]');
      continue;
    }

    if (block.type === 'artifact') {
      const fname   = block.title || `artifact_${parts.length}`;
      const lang    = block.language || inferLang(fname, block.content);
      const content = block.content || '';
      const comment = lang === 'python' ? `# ${fname}` : `// ${fname}`;
      const f3 = safeFence(content);
      add(`${f3}${lang}\n${comment}\n${content}\n${f3}`);
      continue;
    }

    if (block.type === 'document') {
      const name = block.name || block.document?.name || 'file';
      const text = block.text || block.document?.text || block.document?.content || '';
      const chained = isHuman ? splitChained(text) : null;
      if (chained) { parts.push(...chainedParts(chained, settings)); continue; }
      const lang  = inferLang(name, text);
      const comment = lang === 'python' ? `# ${name}` : `// ${name}`;
      const shown = docText(text.trim(), settings);
      const f4 = safeFence(shown);
      const entry = `*<File: ${name}>*\n${f4}${lang}\n${comment}\n${shown}\n${f4}`;
      if (settings.zipFiles) nonImageFiles.push({ filename: name, content: text.trim() });
      add(entry);
      continue;
    }

    if (block.type === 'context') {
      const content = block.body || block.content || block.text || '';
      parts.push(...pastedParts(content.trim(), isHuman, settings));
      continue;
    }

    console.warn('[exporter] unknown block type:', block.type, block);
  }

  return parts;
}

// --- Message renderer ---

async function messageToText(msg, images, nonImageFiles, settings, imgCounters) {
  const userLabel = (settings.userName || 'User').trim() || 'User';
  const isHuman = msg.sender === 'human';
  const role = isHuman ? `**${userLabel}:**` : '**Claude:**';
  const parts = [];

  if (Array.isArray(msg.content)) {
    parts.push(...await contentBlocksToParts(msg.content, images, nonImageFiles, settings, imgCounters, isHuman));
  } else if (typeof msg.content === 'string') {
    parts.push(...plainTextParts(msg.content, isHuman, settings));
  } else if (msg.text) {
    parts.push(...plainTextParts(msg.text, isHuman, settings));
  }

  const allFiles = [...(msg.attachments || []), ...(msg.files || [])];
  for (const file of allFiles) {
    if (file.success === false) continue;
    const rawName = file.file_name || file.name;
    const name    = rawName || 'untitled';

    if (file.file_kind === 'image') {
      if (!settings.images) {
        imgCounters.omitted = (imgCounters.omitted || 0) + 1;
        parts.push({ text: `*<Image not exported: ${name}>*` });
        continue;
      }
      const idx   = imgCounters.current++;
      const total = imgCounters.total;
      let rendered;
      try {
        rendered = await classifyAndRouteFile(file, images, settings, idx, total);
      } catch(e) {
        console.error('[exporter] classifyAndRouteFile threw:', e);
        rendered = `*<Screenshot: ${name}>*\n\`\`\`\nprocessing failed\n\`\`\``;
      }
      if (rendered) parts.push({ text: rendered });
    } else {
      const content = file.extracted_content || file.text || file.content || '';
      if (!content.trim()) continue;

      const chained = isHuman ? splitChained(content) : null;
      if (chained) { parts.push(...chainedParts(chained, settings)); continue; }

      const hasExt = rawName && rawName.includes('.');
      const lang   = inferLang(name, content);
      const shown  = docText(content.trim(), settings);
      const f      = safeFence(shown);

      if (!hasExt) {
        parts.push({ text: `${f}${lang}\n${shown}\n${f}` });
      } else {
        const comment = lang === 'python' ? `# ${name}` : `// ${name}`;
        parts.push({ text: `*<File: ${name}>*\n${f}${lang}\n${comment}\n${shown}\n${f}` });
        if (settings.zipFiles) nonImageFiles.push({ filename: name, content: content.trim() });
      }
    }
  }

  // Consecutive normal parts share one role label; chained transcripts break
  // the run and are emitted bare, in order.
  const segments = [];
  let group = [];
  const flush = () => {
    const text = group.map(p => p.text).join('\n\n').trim();
    if (text) segments.push(`${role} ${text}`);
    group = [];
  };
  for (const part of parts) {
    if (part.chained) { flush(); segments.push(part.text); }
    else group.push(part);
  }
  flush();

  return segments.length ? segments.join('\n\n') : `${role} `;
}

// --- Conversation renderer ---

const FRAME_FOOTER = '[End of Claudette Chat Export]';

function frameHeader(conv, settings, imgCounters) {
  const lines = [`[Claudette Chat Export: "${conv.name || conv.uuid}"]`];
  if (settings.images && settings.ocr && imgCounters.total > 0)
    lines.push("Note: OCR is enabled; treat OCR'd text as a guide, not verbatim — it is error-prone.");
  if (!settings.images && imgCounters.omitted > 0)
    lines.push('Note: image export was disabled; attachments are listed by name only.');
  return lines.join('\n');
}

async function conversationToText(conv, settings) {
  const images        = [];
  const nonImageFiles = [];
  const chain         = buildMessageChain(conv);

  // Count total images upfront so progress bar has a denominator
  let totalImages = 0;
  if (settings.images) {
    for (const m of chain) {
      const all = [...(m.attachments || []), ...(m.files || [])];
      totalImages += all.filter(f => f.file_kind === 'image' && f.success !== false).length;
    }
  }
  const imgCounters = { current: 0, total: totalImages, omitted: 0 };

  reportProgress('start', 0, chain.length, conv.name || conv.uuid);

  const lines = [];
  for (let i = 0; i < chain.length; i++) {
    reportProgress('message', i, chain.length, conv.name || conv.uuid);
    lines.push(await messageToText(chain[i], images, nonImageFiles, settings, imgCounters));
  }

  const body = lines.join('\n\n');
  const text = settings.exportFraming ? `${frameHeader(conv, settings, imgCounters)}\n\n${body}\n\n${FRAME_FOOTER}` : body;
  console.log(`[exporter] rendered ${chain.length} messages, ${images.length} images, ${nonImageFiles.length} files`);
  reportProgress('done', chain.length, chain.length, conv.name || conv.uuid);
  return { text, images, nonImageFiles };
}

// --- ZIP builder ---

function buildZip(title, text, ext, images, nonImageFiles, settings) {
  const zip = new JSZip();
  zip.file(`${title}.${ext}`, text);
  if (settings.zip && images.length > 0)
    images.forEach(img => zip.file(img.filename, img.blob));
  if (settings.zipFiles && nonImageFiles.length > 0)
    nonImageFiles.forEach(f => zip.file(f.filename, f.content));
  return zip;
}

async function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// --- Export entry points ---

async function exportSingle(conv, settingsOverride) {
  const settings = settingsOverride || await loadSettings();
  const format   = settings.format || 'md';
  const ext      = format === 'txt' ? 'txt' : 'md';
  const title    = sanitizeFilename(conv.name || conv.uuid);
  console.log(`[exporter] exporting single: ${conv.uuid}`);

  const { text, images, nonImageFiles } = await conversationToText(conv, settings);
  const needsZip = (images.length > 0 && settings.zip) || (nonImageFiles.length > 0 && settings.zipFiles);

  if (!needsZip) {
    await triggerDownload(new Blob([text], { type: 'text/plain' }), `${title}.${ext}`);
    console.log(`[exporter] single done (no zip): ${title}.${ext}`);
    return;
  }

  const zip  = buildZip(title, text, ext, images, nonImageFiles, settings);
  const blob = await zip.generateAsync({ type: 'blob' });
  await triggerDownload(blob, `${title}.zip`);
  console.log(`[exporter] single done (zip): ${title}.zip`);
}

async function exportBulk(results, settingsOverride) {
  const settings = settingsOverride || await loadSettings();
  const format   = settings.format || 'md';

  if (results.length === 1 && results[0].success && results[0].data)
    return exportSingle(results[0].data, settings);

  console.log(`[exporter] bulk export: ${results.length} results`);
  const ext = format === 'txt' ? 'txt' : 'md';
  const zip = new JSZip();
  let ok = 0, fail = 0;

  for (let ri = 0; ri < results.length; ri++) {
    const result = results[ri];
    reportProgress('conv', ri, results.length, result.data?.name || result.uuid || '');
    if (!result.success || !result.data) {
      console.warn('[exporter] skipping failed result:', result.error || result.uuid);
      fail++;
      continue;
    }
    const conv   = result.data;
    const title  = sanitizeFilename(conv.name || conv.uuid);
    let { text, images, nonImageFiles } = await conversationToText(conv, settings);
    // Prefix image/file names with conv title to avoid collisions in flat ZIP root
    images = images.map(img => {
      const prefixed = `${title}_${img.filename}`;
      text = text.replaceAll(`./${img.filename}`, `./${prefixed}`);
      return { ...img, filename: prefixed };
    });
    nonImageFiles = nonImageFiles.map(f => ({ ...f, filename: `${title}_${f.filename}` }));
    zip.file(`${title}.${ext}`, text);
    if (settings.zip && images.length > 0)
      images.forEach(img => zip.file(img.filename, img.blob));
    if (settings.zipFiles && nonImageFiles.length > 0)
      nonImageFiles.forEach(f => zip.file(f.filename, f.content));
    ok++;
  }

  console.log(`[exporter] bulk: ${ok} ok, ${fail} failed`);
  reportProgress('zipping', ok + fail, results.length, 'Packaging ZIP…');
  const blob = await zip.generateAsync({ type: 'blob' });
  await triggerDownload(blob, `claude_export_${Date.now()}.zip`);
  reportProgress('done', results.length, results.length, 'Done');
  console.log('[exporter] bulk zip downloaded');
}

// --- Clipboard export ---

// Expose conversationToText for content.js inline fallback
window._cceConversationToText = conversationToText;

// copyChatText: same rendering pipeline as exportSingle, but writes to clipboard.
// Respects all extension settings (format, thinking, tools, images, ocr).
// Images and files are NOT included in the clipboard text (only their labels/text).
async function copyChatText(conv, settingsOverride) {
  const settings = settingsOverride || await loadSettings();
  console.log(`[exporter] clipboard copy: ${conv.uuid}`);
  const { text } = await conversationToText(conv, settings);
  await navigator.clipboard.writeText(text);
  reportProgress('done', 1, 1, 'Copied to clipboard');
  console.log('[exporter] copied to clipboard');
}

// Expose for content.js
window.copyChatText = copyChatText;
