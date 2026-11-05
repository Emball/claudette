// transcript_import.js — import page: applies current settings to an old transcript.

const IMPORT_OPTS = [
  ['truncateDocs', 'Truncate large documents'],
  ['truncateEmbedded', 'Truncate long bash content'],
  ['truncateCode', 'Truncate long code blocks'],
  ['dedupDocs', 'Tag repeated documents'],
  ['keepFirstDoc', 'Keep first copy in full'],
  ['filterBashReads', 'Skip repeat file reads'],
  ['dedupSessions', 'Drop repeated session turns'],
  ['trimNoise', 'Trim noise'],
];

const $ = id => document.getElementById(id);
let current = { ...TRANSCRIPT_DEFAULTS };

function renderOpts() {
  $('opts').innerHTML = '';
  for (const [key, label] of IMPORT_OPTS) {
    const l = document.createElement('label');
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = !!current[key];
    c.addEventListener('change', () => { current[key] = c.checked; });
    l.append(c, ` ${label}`);
    $('opts').append(l);
  }
}

chrome.storage.sync.get(TRANSCRIPT_DEFAULTS, s => {
  current = { ...TRANSCRIPT_DEFAULTS, ...s };
  console.log('[import] loaded settings', current);
  renderOpts();
});

$('file').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  $('input').value = await f.text();
  console.log(`[import] loaded file ${f.name} (${f.size} bytes)`);
});

$('run').addEventListener('click', () => {
  const src = $('input').value;
  if (!src.trim()) { $('stats').textContent = 'Nothing to process.'; return; }
  try {
    const out = retrofitTranscript(src, current);
    $('output').value = out;
    $('stats').textContent = `${src.length.toLocaleString()} → ${out.length.toLocaleString()} characters (${Math.round(100 - 100 * out.length / src.length)}% smaller)`;
    $('download').disabled = $('copy').disabled = false;
    console.log('[import] processed', src.length, '→', out.length);
  } catch (err) {
    console.error('[import] failed', err);
    $('stats').textContent = `Failed: ${err.message}`;
  }
});

$('download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([$('output').value], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'transcript_cleaned.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('output').value);
    $('stats').textContent += ' — copied';
  } catch (err) {
    console.error('[import] copy failed', err);
    $('stats').textContent = `Copy failed: ${err.message}`;
  }
});
