// transcript.js — pure text pipeline for rendered transcripts. No chrome/DOM dependencies,
// so the exporter, the import page and Node tests all share it.

const TRANSCRIPT_DEFAULTS = {
  truncateDocs:     true,
  truncateEmbedded: true,
  truncateCode:     true,
  dedupDocs:        true,
  keepFirstDoc:     false,
  filterBashReads:  true,
  dedupSessions:    true,
  trimNoise:        true,
};

const TRUNC_KEEP      = 16;
const TRUNC_SLACK     = 8;
const CODE_MAX_LINES  = 20;
const CODE_HEAD       = 10;
const CODE_TAIL       = 5;
const LONG_LINE_MAX   = 1500;
const LONG_LINE_KEEP  = 400;
const TRUNC_MAX_CHARS = 3000;
const TRUNC_HEAD_CHARS = 1400;
const TRUNC_TAIL_CHARS = 1000;
const DEDUP_MIN_LINES = 8;
const DEDUP_NEAR      = 0.9;
const READ_COVER      = 0.9;
const READ_MIN_LINES  = 5;
const SIG_MIN_LEN     = 6;
const TURN_RUN_MIN    = 3;
const THINK_RUN_MIN   = 4;

const TRUNC_MARKER_RE      = /^\.\.\. \[truncated \d+ lines \/ ~\d+ KB[^\]]*\] \.\.\.\s*$/m;
const CHAIN_HEADER_RE      = /^\[Claudette Chat Export: .*\]\s*$/m;
const CHAIN_FOOTER_RE      = /^\[End of Claudette Chat Export\]\s*$/;
const CHAIN_HEADER_LINE_RE = /^\[Claudette Chat Export: /;
const CLAUDE_TURN_RE       = /^\*\*Claude:\*\* /;
const TURN_RE              = /^\*\*[^*\n]{1,40}:\*\* /;
const FENCE_OPEN_RE        = /^(\*\*[^*\n]{1,40}:\*\* )?(`{3,})[^`\r]*\r?$/;
const THINK_LINE_RE        = /^> \*(?!\*)[^\n]*\*\s*$/;
const READ_STUB            = '[repeat read of already-shown content omitted]';

// --- Truncation ---

function truncMarker(skipped) {
  const kb = Math.max(1, Math.round(skipped.join('\n').length / 1024));
  return `... [truncated ${skipped.length} lines / ~${kb} KB] ...`;
}

function capLongLines(text) {
  if (text.length <= LONG_LINE_MAX) return text;
  return text.split('\n').map(l =>
    l.length > LONG_LINE_MAX
      ? `${l.slice(0, LONG_LINE_KEEP)} … [truncated ${l.length - LONG_LINE_KEEP} chars]`
      : l
  ).join('\n');
}

function truncateLines(text) {
  if (TRUNC_MARKER_RE.test(text)) return text;
  text = capLongLines(text);
  const lines = text.split('\n');
  let head = TRUNC_KEEP, tail = TRUNC_KEEP;
  if (lines.length <= TRUNC_KEEP * 2 + TRUNC_SLACK) {
    if (text.length <= TRUNC_MAX_CHARS || lines.length < 6) return text;
    head = 0; tail = 0;
    for (let c = 0; head < lines.length - 2 && c + lines[head].length < TRUNC_HEAD_CHARS; head++) c += lines[head].length + 1;
    for (let c = 0; tail < lines.length - head - 1 && c + lines[lines.length - 1 - tail].length < TRUNC_TAIL_CHARS; tail++) c += lines[lines.length - 1 - tail].length + 1;
    head = Math.max(head, 1); tail = Math.max(tail, 1);
    if (head + tail >= lines.length - 1) return text;
  }
  const skipped = lines.slice(head, lines.length - tail);
  console.log(`[transcript] truncated ${skipped.length} lines (~${skipped.join('\n').length} chars)`);
  return [
    ...lines.slice(0, head),
    truncMarker(skipped),
    ...lines.slice(lines.length - tail),
  ].join('\n');
}

// Shell command text: heredoc bodies (embedded file content) first, then plain truncation.
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
      console.log(`[transcript] truncated heredoc '${m[2]}': ${skipped.length} lines`);
      out.push(...body.slice(0, TRUNC_KEEP), truncMarker(skipped), ...body.slice(body.length - TRUNC_KEEP));
    } else {
      out.push(...body);
    }
    i = j;
  }
  return truncateLines(out.join('\n'));
}

function truncateCode(text) {
  if (TRUNC_MARKER_RE.test(text)) return text;
  text = capLongLines(text);
  const lines = text.split('\n');
  if (lines.length <= CODE_MAX_LINES) return text;
  const skipped = lines.slice(CODE_HEAD, lines.length - CODE_TAIL);
  console.log(`[transcript] truncated code block: ${skipped.length} lines`);
  return [...lines.slice(0, CODE_HEAD), truncMarker(skipped), ...lines.slice(lines.length - CODE_TAIL)].join('\n');
}

function truncateInputObject(input) {
  const out = {};
  for (const [k, v] of Object.entries(input))
    out[k] = typeof v === 'string' ? truncateLines(v) : v;
  return out;
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

// --- Content fingerprints (filename-independent) ---

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

function sigLines(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    if (TRUNC_MARKER_RE.test(raw)) continue;
    const t = raw.replace(/\s+/g, ' ').trim();
    if (t.length >= SIG_MIN_LEN) out.push(t);
  }
  return out;
}

function makeFp(text, dropNameComment) {
  let body = text;
  if (dropNameComment) {
    const nl = body.indexOf('\n');
    const first = nl < 0 ? body : body.slice(0, nl);
    if (/^(\/\/|#) \S.*$/.test(first)) body = nl < 0 ? '' : body.slice(nl + 1);
  }
  const lines = sigLines(body);
  return { lines, set: new Set(lines), count: lines.length, hash: hashStr(lines.join('\n')) };
}

function sharedCount(a, b) {
  let n = 0;
  for (const l of a) if (b.has(l)) n++;
  return n;
}

// Finds the earlier document that covers this one: identical, a subset (including
// truncated copies), or a near-duplicate (>= DEDUP_NEAR line overlap).
function matchSeen(fp, seen) {
  let best = null;
  for (const e of seen) {
    if (e.src !== 'doc') continue;
    if (e.hash === fp.hash) return { e, kind: 'same' };
    const shared = sharedCount(fp.set, e.set);
    if (shared === fp.set.size) return { e, kind: 'same' };
    const sym = shared / Math.max(fp.set.size, e.set.size);
    if (sym >= DEDUP_NEAR && (!best || sym > best.score)) best = { e, kind: 'near', score: sym };
  }
  return best;
}

function clip(s, n) { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

function docTag(name, hit, fp) {
  const alias = hit.e.name !== name ? ` (same as ${hit.e.name})` : '';
  if (hit.kind === 'same') return `[${name} attached, truncated${alias}]`;
  const added = fp.lines.filter(l => !hit.e.set.has(l));
  const snippet = added.slice(0, 3).map(l => clip(l, 70)).join(' | ');
  const more = added.length > 3 ? ` (+${added.length - 3} more lines)` : '';
  return `[${name} truncated, altered content: ${snippet}${more}]`;
}

function registerSeen(seen, shownAll, fp, name, src, displayed) {
  seen.push({ name, src, hash: fp.hash, set: fp.set });
  for (const l of sigLines(displayed)) shownAll.add(l);
}

function containment(lines, shownAll) {
  if (!lines.length) return 0;
  let n = 0;
  for (const l of lines) if (shownAll.has(l)) n++;
  return n / lines.length;
}

// --- Pure-read bash detection ---

const READ_CMDS  = new Set(['cat', 'head', 'tail', 'nl', 'less', 'more', 'bat', 'sed', 'grep', 'rg']);
const AUX_CMDS   = new Set(['cd', 'ls', 'wc', 'file', 'stat', 'pwd', 'echo', 'printf', 'cut', 'sort', 'uniq', 'tr']);

function isPureRead(cmd) {
  const c = (cmd || '').trim();
  if (!c || c.length > 400) return false;
  if (/<<|`|\$\(/.test(c)) return false;
  const stripped = c.replace(/2>&1|2>\s*\/dev\/null|&>\s*\/dev\/null/g, '');
  if (/[<>]/.test(stripped)) return false;
  const segs = stripped.split(/&&|\|\||;|\|/).map(x => x.trim()).filter(Boolean);
  let hasRead = false;
  for (const seg of segs) {
    const w = seg.split(/\s+/)[0];
    if (w === 'sed' && /\s-[a-zA-Z]*i/.test(seg)) return false;
    if (READ_CMDS.has(w)) hasRead = true;
    else if (!AUX_CMDS.has(w)) return false;
  }
  return hasRead;
}

// --- Fence tracking ---

// 1 for every line inside a fenced block (open and close lines included).
function fenceMask(lines) {
  const mask = new Uint8Array(lines.length);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, '');
    if (fence && (CHAIN_HEADER_LINE_RE.test(l) || CHAIN_FOOTER_RE.test(l) || CLAUDE_TURN_RE.test(l))) fence = null;
    if (fence) {
      mask[i] = 1;
      if (l === fence) fence = null;
      continue;
    }
    const m = l.match(FENCE_OPEN_RE);
    if (m) { fence = m[2]; mask[i] = 1; }
  }
  return mask;
}

// --- Repeated sessions: runs of turns already shown above ---

function turnKey(lines, start, end) {
  const t = lines.slice(start, end).join('\n').replace(/\s+/g, ' ').trim().toLowerCase();
  return t.slice(0, 160);
}

function dedupTurnRuns(text) {
  const lines = text.split('\n');
  const mask = fenceMask(lines);
  const turns = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, '');
    const boundary = !mask[i] && (CHAIN_HEADER_LINE_RE.test(l) || CHAIN_FOOTER_RE.test(l));
    const opener = TURN_RE.test(l) && FENCE_OPEN_RE.test(l) && (i === 0 || !mask[i - 1]);
    const turnStart = TURN_RE.test(l) && (!mask[i] || opener);
    if (boundary) { if (cur) { cur.end = i; turns.push(cur); cur = null; } continue; }
    if (turnStart) {
      if (cur) { cur.end = i; turns.push(cur); }
      cur = { start: i, end: null };
    }
  }
  if (cur) { cur.end = lines.length; turns.push(cur); }
  if (turns.length < TURN_RUN_MIN) return text;

  const seen = new Set();
  const drops = [];
  let run = [];
  const flush = () => {
    if (run.length >= TURN_RUN_MIN)
      drops.push({ start: run[0].start, end: run[run.length - 1].end, n: run.length });
    run = [];
  };
  for (const t of turns) {
    t.key = turnKey(lines, t.start, t.end);
    const dup = seen.has(t.key);
    if (dup && (!run.length || run[run.length - 1].end === t.start)) run.push(t);
    else { flush(); if (dup) run = [t]; }
    if (!dup) seen.add(t.key);
  }
  flush();
  if (!drops.length) return text;

  const out = [];
  let pos = 0;
  for (const d of drops) {
    out.push(...lines.slice(pos, d.start));
    out.push(`[${d.n} turns already included above — omitted]`, '');
    console.log(`[transcript] dropped ${d.n} repeated turns (lines ${d.start}-${d.end})`);
    pos = d.end;
  }
  out.push(...lines.slice(pos));
  return out.join('\n');
}

// --- Block pass: documents, tool input/output ---

function onlyBlank(arr, from, to) {
  for (let k = from; k < to; k++) if (arr[k].trim()) return false;
  return true;
}

function blockPass(text, s) {
  const lines = text.split('\n');
  const out = [];
  const seen = [];
  const shownAll = new Set();
  let lastInput = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(FENCE_OPEN_RE);
    if (!m) { out.push(line); i++; continue; }

    let prev = '', prevIdx = -1, label = '';
    if (!m[1]) {
      for (let k = out.length - 1; k >= 0; k--) {
        if (out[k].trim()) { prev = out[k].trim(); prevIdx = k; break; }
      }
      const lm = prev.match(/^(\*\*[^*\n]{1,40}:\*\* )(.+)$/);
      if (lm) { label = lm[1]; prev = lm[2]; }
    }
    let kind = null;
    if (/^\*<(Pasted|File: .*)>\*$/.test(prev)) kind = 'doc';
    else if (prev.startsWith('> **')) kind = 'input';
    else if (prev === '*<Output>*') kind = 'output';
    else if (m[1] && !CLAUDE_TURN_RE.test(m[1])) kind = 'paste';
    else kind = 'code';

    let j = i + 1;
    while (j < lines.length && lines[j].replace(/\r$/, '') !== m[2]
           && !CHAIN_FOOTER_RE.test(lines[j]) && !CHAIN_HEADER_LINE_RE.test(lines[j])
           && !CLAUDE_TURN_RE.test(lines[j])) j++;
    const closed = j < lines.length && lines[j].replace(/\r$/, '') === m[2];
    if (!closed || !kind) { out.push(line); i++; continue; }

    const body = lines.slice(i + 1, j).join('\n');
    const close = lines[j];

    if (kind === 'doc' || kind === 'paste' || kind === 'code') {
      const isFile = kind === 'doc' && prev.startsWith('*<File: ');
      const name = isFile ? prev.slice(8, -2) : kind === 'code' ? 'code block' : 'pasted text';
      const lead = kind === 'doc' ? label : (m[1] || '');
      const hasMarker = TRUNC_MARKER_RE.test(body);
      const fp = makeFp(body, isFile);
      const eligible = fp.count >= DEDUP_MIN_LINES;
      if (s.dedupDocs && eligible) {
        const hit = matchSeen(fp, seen);
        if (hit) {
          if (kind === 'doc') out.splice(prevIdx);
          out.push(lead + docTag(name, hit, fp));
          console.log(`[transcript] repeated document '${name}' → ${hit.kind}`);
          i = j + 1;
          lastInput = null;
          continue;
        }
      }
      const keepFull = s.dedupDocs && s.keepFirstDoc && !hasMarker;
      const shown = kind === 'code'
        ? (s.truncateCode ? truncateCode(body) : body)
        : (s.truncateDocs && !keepFull ? truncateLines(body) : body);
      if (eligible) registerSeen(seen, shownAll, fp, name, 'doc', shown);
      out.push(line, ...shown.split('\n'), close);
      i = j + 1;
      lastInput = null;
      continue;
    }

    if (kind === 'input') {
      const shown = s.truncateEmbedded ? truncateToolInput(body) : body;
      out.push(line, ...shown.split('\n'), close);
      lastInput = { hdrIdx: prevIdx, label, endOut: out.length, cmd: body };
      i = j + 1;
      continue;
    }

    const shown = s.truncateEmbedded ? truncateLines(body) : body;
    if (s.filterBashReads && lastInput && prevIdx >= lastInput.endOut
        && onlyBlank(out, lastInput.endOut, prevIdx) && isPureRead(lastInput.cmd)) {
      const ol = sigLines(shown);
      if (ol.length >= READ_MIN_LINES && containment(ol, shownAll) >= READ_COVER) {
        console.log(`[transcript] dropped repeat read: ${clip(lastInput.cmd, 80)}`);
        out.splice(lastInput.hdrIdx);
        out.push(lastInput.label + READ_STUB);
        lastInput = null;
        i = j + 1;
        continue;
      }
    }
    const fp = makeFp(body, false);
    if (fp.count >= DEDUP_MIN_LINES) registerSeen(seen, shownAll, fp, 'output', 'out', shown);
    out.push(line, ...shown.split('\n'), close);
    lastInput = null;
    i = j + 1;
  }
  return out.join('\n');
}

// --- Noise trimming ---

function collapseThinking(text) {
  const lines = text.split('\n');
  const mask = fenceMask(lines);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (mask[i] || !THINK_LINE_RE.test(lines[i])) { out.push(lines[i]); i++; continue; }
    const idxs = [i];
    let k = i + 1;
    while (k < lines.length) {
      if (!lines[k].trim()) { k++; continue; }
      if (!mask[k] && THINK_LINE_RE.test(lines[k])) { idxs.push(k); k++; continue; }
      break;
    }
    if (idxs.length >= THINK_RUN_MIN) {
      const first = lines[idxs[0]], last = lines[idxs[idxs.length - 1]];
      out.push(first, '', `> *[${idxs.length - 2} thinking steps omitted]*`, '', last);
      i = idxs[idxs.length - 1] + 1;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join('\n');
}

function trimNoise(text) {
  let t = text.split('\n').filter(l => !/^Shell cwd was reset to \S+\s*$/.test(l)).join('\n');
  t = collapseThinking(t);
  return t.replace(/\n{4,}/g, '\n\n\n');
}

// --- Entry points ---

function processTranscript(text, settings) {
  const s = { ...TRANSCRIPT_DEFAULTS, ...settings };
  let t = String(text || '').replace(/\r\n/g, '\n');
  if (s.dedupSessions) t = dedupTurnRuns(t);
  if (s.truncateDocs || s.truncateEmbedded || s.truncateCode || s.dedupDocs || s.filterBashReads) t = blockPass(t, s);
  if (s.trimNoise) t = trimNoise(t);
  return t;
}

// Old exports wrapped pasted prior transcripts in fences (and *<Pasted>*/*<File>* labels).
// Removes those wrappers so sessions read as one continuous transcript.
function unwrapTranscripts(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let pendingLabel = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(FENCE_OPEN_RE);
    if (m) {
      let k = i + 1;
      while (k < lines.length && !lines[k].trim()) k++;
      if (k < lines.length && CHAIN_HEADER_LINE_RE.test(lines[k])) {
        let j = k;
        while (j < lines.length && lines[j].replace(/\r$/, '') !== m[2]) j++;
        let f = j - 1;
        while (f > k && !lines[f].trim()) f--;
        if (j < lines.length && CHAIN_FOOTER_RE.test(lines[f])) {
          let pl = out.length - 1;
          while (pl >= 0 && !out[pl].trim()) pl--;
          if (!m[1] && pl >= 0 && /^\*<(Pasted|File: .*)>\*$/.test(out[pl].trim())) out.splice(pl);
          out.push(...lines.slice(k, j));
          pendingLabel = m[1] || null;
          console.log(`[transcript] unwrapped pasted transcript (${j - k} lines)`);
          i = j + 1;
          continue;
        }
      }
    }
    if (pendingLabel && line.trim()) {
      if (TURN_RE.test(line) || CHAIN_HEADER_LINE_RE.test(line) || CHAIN_FOOTER_RE.test(line)) {
        pendingLabel = null;
      } else {
        out.push(pendingLabel + line);
        pendingLabel = null;
        i++;
        continue;
      }
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

function retrofitTranscript(text, settings) {
  return processTranscript(unwrapTranscripts(text), settings);
}
