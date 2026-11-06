// search.js — full-text search over the local library. Extension page, no network.

const PAGE_SIZE = 50;
const INDEX_BATCH = 16;
const SEARCH_DEBOUNCE_MS = 200;

const $ = id => document.getElementById(id);
const qEl = $('q'), accountEl = $('account'), senderEl = $('sender');
const statusEl = $('status'), resultsEl = $('results'), moreEl = $('more');

let library = {};
let registry = {};
let index = [];
let failedCount = 0;
let ready = false;
let matches = [];
let shown = 0;
let activeTerms = [];

async function decompress(b64) {
  const bytes  = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const ds     = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const out = await new Response(ds.readable).arrayBuffer();
  return JSON.parse(new TextDecoder().decode(out));
}

function inputText(input) {
  return Object.values(input).map(v => typeof v === 'string' ? v : JSON.stringify(v)).join('\n');
}

// Flattens everything searchable in a message into one string. Must stay deterministic:
// snippets re-extract the same message by index.
function messageText(msg) {
  const parts = [];
  for (const b of msg.content || []) {
    if (b.type === 'text' && b.text) parts.push(b.text);
    else if (b.type === 'thinking') {
      if (b.thinking) parts.push(b.thinking);
      for (const s of b.summaries || []) if (s && s.summary) parts.push(s.summary);
    }
    else if (b.type === 'tool_use') {
      parts.push(b.title || b.name || '');
      if (b.input) parts.push(inputText(b.input));
    }
    else if (b.type === 'artifact') {
      if (b.title) parts.push(b.title);
      if (b.content) parts.push(b.content);
    }
    else if (b.type === 'document' && b.name) parts.push(b.name);
    else if (b.type === 'context' && b.body) parts.push(b.body);
  }
  for (const a of msg.attachments || []) {
    if (a.file_name) parts.push(a.file_name);
    if (a.extracted_content) parts.push(a.extracted_content);
  }
  return parts.join('\n');
}

function accountLabel(orgId) {
  const a = registry[orgId];
  return (a && (a.email || a.orgName)) || orgId.slice(0, 12) + '…';
}

async function indexOne({ orgId, conv }) {
  try {
    const msgs = conv.messages_z ? await decompress(conv.messages_z) : [];
    const entries = [];
    msgs.forEach((m, i) => {
      const t = messageText(m).toLowerCase();
      if (t) entries.push({ i, s: m.sender, t });
    });
    const title = conv.name || conv.uuid;
    return { orgId, uuid: conv.uuid, title, titleLower: title.toLowerCase(), updated: conv.updated_at || conv.created_at || '', msgs: entries };
  } catch (err) {
    failedCount++;
    console.error('[search] failed to decode', orgId, conv.uuid, err);
    return null;
  }
}

async function buildIndex() {
  ready = false;
  index = [];
  failedCount = 0;
  statusEl.textContent = 'Loading library…';
  const stored = await chrome.storage.local.get(['library', 'accountRegistry']);
  library = stored.library || {};
  registry = stored.accountRegistry || {};

  const jobs = [];
  for (const [orgId, convs] of Object.entries(library)) {
    for (const conv of Object.values(convs)) jobs.push({ orgId, conv });
  }
  console.log(`[search] indexing ${jobs.length} conversations`);

  for (let i = 0; i < jobs.length; i += INDEX_BATCH) {
    const done = await Promise.all(jobs.slice(i, i + INDEX_BATCH).map(indexOne));
    for (const e of done) if (e) index.push(e);
    statusEl.textContent = `Indexing… ${Math.min(i + INDEX_BATCH, jobs.length)} / ${jobs.length}`;
  }

  populateAccounts();
  ready = true;
  const accounts = Object.keys(library).length;
  statusEl.textContent = jobs.length === 0
    ? 'Library is empty. In the popup, open the dev section and sweep an account first.'
    : `Indexed ${index.length} chats across ${accounts} account${accounts === 1 ? '' : 's'}` +
      (failedCount ? ` (${failedCount} could not be read)` : '') + '.';
  console.log(`[search] index ready: ${index.length} ok, ${failedCount} failed`);
  runSearch();
}

function populateAccounts() {
  const prev = accountEl.value;
  accountEl.replaceChildren(new Option('All accounts', ''));
  for (const orgId of Object.keys(library)) {
    const count = Object.keys(library[orgId]).length;
    accountEl.add(new Option(`${accountLabel(orgId)} (${count})`, orgId));
  }
  accountEl.value = [...accountEl.options].some(o => o.value === prev) ? prev : '';
}

function parseQuery(q) {
  const terms = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(q))) {
    const t = (m[1] || m[2]).toLowerCase().trim();
    if (t) terms.push(t);
  }
  return terms;
}

function runSearch() {
  if (!ready) return;
  const terms = parseQuery(qEl.value);
  activeTerms = terms;
  resultsEl.replaceChildren();
  moreEl.hidden = true;
  matches = [];
  shown = 0;
  if (!terms.length) return;

  const org = accountEl.value;
  const sender = senderEl.value;
  for (const e of index) {
    if (org && e.orgId !== org) continue;
    const pool = sender === 'any' ? e.msgs : e.msgs.filter(m => m.s === sender);
    const titleHits = terms.filter(t => e.titleLower.includes(t)).length;
    if (!terms.every(t => e.titleLower.includes(t) || pool.some(m => m.t.includes(t)))) continue;

    let best = null, bestHits = 0, fullMatches = 0;
    for (const m of pool) {
      const hits = terms.filter(t => m.t.includes(t)).length;
      if (hits === terms.length) fullMatches++;
      if (hits > bestHits) { bestHits = hits; best = m; }
    }
    const score = titleHits * 50 + (titleHits === terms.length ? 100 : 0) + fullMatches * 10 + bestHits;
    matches.push({ e, best, score });
  }
  matches.sort((a, b) => b.score - a.score || (a.e.updated < b.e.updated ? 1 : -1));
  statusEl.textContent = `${matches.length} chat${matches.length === 1 ? '' : 's'} match` +
    (org ? ` in ${accountLabel(org)}` : '') + '.';
  showMore();
}

function showMore() {
  const next = matches.slice(shown, shown + PAGE_SIZE);
  next.forEach(renderResult);
  shown += next.length;
  moreEl.hidden = shown >= matches.length;
}

function renderResult({ e, best }) {
  const box = document.createElement('div');
  box.className = 'result';

  const link = document.createElement('a');
  link.href = `https://claude.ai/chat/${e.uuid}`;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = e.title;

  const meta = document.createElement('div');
  meta.className = 'meta';
  const date = e.updated ? new Date(e.updated).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
  const who = best ? (best.s === 'human' ? 'you' : 'Claude') : null;
  meta.textContent = `${accountLabel(e.orgId)} · ${date}` + (who ? ` · match in ${who}` : ' · title match');

  const snip = document.createElement('div');
  snip.className = 'snippet';

  box.append(link, meta, snip);
  resultsEl.append(box);
  if (best) fillSnippet(snip, e, best).catch(err => console.error('[search] snippet failed', e.uuid, err));
}

async function fillSnippet(el, e, best) {
  const msgs = await decompress(library[e.orgId][e.uuid].messages_z);
  const msg = msgs[best.i];
  if (!msg) return;
  el.replaceChildren(...buildSnippet(messageText(msg), activeTerms));
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function buildSnippet(text, terms) {
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const p = lower.indexOf(t);
    if (p !== -1 && (pos === -1 || p < pos)) pos = p;
  }
  if (pos === -1) pos = 0;
  const start = Math.max(0, pos - 120);
  const end = Math.min(text.length, pos + 280);
  let snip = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snip = '…' + snip;
  if (end < text.length) snip += '…';

  const re = new RegExp('(' + terms.map(escapeRe).join('|') + ')', 'gi');
  const nodes = [];
  snip.split(re).forEach((part, i) => {
    if (!part) return;
    if (i % 2) {
      const mk = document.createElement('mark');
      mk.textContent = part;
      nodes.push(mk);
    } else {
      nodes.push(document.createTextNode(part));
    }
  });
  return nodes;
}

let debounce = null;
qEl.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(runSearch, SEARCH_DEBOUNCE_MS); });
qEl.addEventListener('keydown', ev => { if (ev.key === 'Enter') { clearTimeout(debounce); runSearch(); } });
accountEl.addEventListener('change', runSearch);
senderEl.addEventListener('change', runSearch);
moreEl.addEventListener('click', showMore);
$('reload').addEventListener('click', () => buildIndex().catch(err => {
  console.error('[search] reload failed', err);
  statusEl.textContent = `Reload failed: ${err.message}`;
}));

buildIndex().catch(err => {
  console.error('[search] index failed', err);
  statusEl.textContent = `Could not load the library: ${err.message}`;
});
