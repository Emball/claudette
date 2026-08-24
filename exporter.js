// exporter.js — converts raw Claude API conversation data to MD and packages ZIP

const EXPORTER_DEFAULTS = {
  format:        'md',
  thinking:      false,
  toolSummaries: true,
  includeBash:   false,
  images:        true,
  ocr:           false,
  zip:           true,
  zipFiles:      true,
  userName:      'User',
};

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
  const rawUrl = file.preview_asset?.url || file.preview_url || null;
  const previewUrl = rawUrl
    ? (rawUrl.startsWith('http') ? rawUrl : `https://claude.ai${rawUrl}`)
    : null;

  const fname = file.file_name || 'image';

  reportProgress('image', imageIndex, imageTotal, fname);

  if (!previewUrl)
    return `*<Screenshot: ${fname}>*\n\`\`\`\nno preview available\n\`\`\``;

  const width  = file.preview_asset?.image_width;
  const height = file.preview_asset?.image_height;

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

async function contentBlocksToText(blocks, images, nonImageFiles, settings, imgCounters) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];

  for (const block of blocks) {

    if (block.type === 'thinking') {
      if (settings.thinking) {
        const thought = (block.thinking || block.text || '').trim();
        if (thought) parts.push(`> *${thought}*`);
      }
      continue;
    }

    if (block.type === 'text') {
      if (block.is_paste || block.paste_id) {
        const content = (block.text || '').trim();
        const f0 = safeFence(content);
        parts.push(`*<Pasted>*\n${f0}\n${content}\n${f0}`);
      } else {
        parts.push(block.text || '');
      }
      continue;
    }

    if (block.type === 'tool_use') {
      if (!settings.toolSummaries) continue;
      const name = block.name || 'tool';
      if (!settings.includeBash && name.toLowerCase().includes('bash')) continue;
      const title = block.title || name;
      parts.push(`> **${title}**`);
      continue;
    }

    if (block.type === 'tool_result') {
      // Full tool_result content is never rendered — summaries only include the tool_use title.
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
      parts.push(`${f3}${lang}\n${comment}\n${content}\n${f3}`);
      continue;
    }

    if (block.type === 'document') {
      const name = block.name || block.document?.name || 'file';
      const text = block.text || block.document?.text || block.document?.content || '';
      const lang  = inferLang(name, text);
      const comment = lang === 'python' ? `# ${name}` : `// ${name}`;
      const f4 = safeFence(text);
      const entry = `*<File: ${name}>*\n${f4}${lang}\n${comment}\n${text.trim()}\n${f4}`;
      if (settings.zipFiles) nonImageFiles.push({ filename: name, content: text.trim() });
      parts.push(entry);
      continue;
    }

    if (block.type === 'context') {
      const content = block.body || block.content || block.text || '';
      const f5 = safeFence(content);
      parts.push(`*<Pasted>*\n${f5}\n${content.trim()}\n${f5}`);
      continue;
    }

    console.warn('[exporter] unknown block type:', block.type, block);
  }

  return parts.join('\n\n');
}

// --- Message renderer ---

async function messageToText(msg, images, nonImageFiles, settings, imgCounters) {
  const userLabel = (settings.userName || 'User').trim() || 'User';
  const role = msg.sender === 'human' ? `**${userLabel}:**` : '**Claude:**';
  let body = '';

  if (Array.isArray(msg.content)) {
    body = await contentBlocksToText(msg.content, images, nonImageFiles, settings, imgCounters);
  } else if (typeof msg.content === 'string') {
    body = msg.content;
  } else if (msg.text) {
    body = msg.text;
  }

  const fileParts = [];
  const allFiles = [...(msg.attachments || []), ...(msg.files || [])];
  for (const file of allFiles) {
    if (file.success === false) continue;
    const rawName = file.file_name || file.name;
    const name    = rawName || 'untitled';

    if (file.file_kind === 'image') {
      if (!settings.images) continue;
      const idx   = imgCounters.current++;
      const total = imgCounters.total;
      let rendered;
      try {
        rendered = await classifyAndRouteFile(file, images, settings, idx, total);
      } catch(e) {
        console.error('[exporter] classifyAndRouteFile threw:', e);
        rendered = '';
      }
      if (rendered) fileParts.push(rendered);
    } else {
      const content = file.extracted_content || file.text || file.content || '';
      if (!content.trim()) continue;

      const hasExt = rawName && rawName.includes('.');
      const lang   = inferLang(name, content);

      if (!hasExt) {
        fileParts.push(`\`\`\`${lang}\n${content.trim()}\n\`\`\``);
      } else {
        const comment = lang === 'python' ? `# ${name}` : `// ${name}`;
        fileParts.push(`*<File: ${name}>*\n\`\`\`${lang}\n${comment}\n${content.trim()}\n\`\`\``);
        if (settings.zipFiles) nonImageFiles.push({ filename: name, content: content.trim() });
      }
    }
  }

  const allParts = [body.trim(), ...fileParts].filter(Boolean);
  return `${role} ${allParts.join('\n\n')}`;
}

// --- Conversation renderer ---

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
  const imgCounters = { current: 0, total: totalImages };

  reportProgress('start', 0, chain.length, conv.name || conv.uuid);

  const lines = [];
  for (let i = 0; i < chain.length; i++) {
    reportProgress('message', i, chain.length, conv.name || conv.uuid);
    lines.push(await messageToText(chain[i], images, nonImageFiles, settings, imgCounters));
  }

  const text = lines.join('\n\n');
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
