// popup.js — settings + progress mirror

const DEFAULTS = {
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
  truncateCode:  true,
  dedupDocs:     true,
  keepFirstDoc:  false,
  filterBashReads: true,
  dedupSessions: true,
  trimNoise:     true,
};

const LOCAL_DEFAULTS = {
  devMode: false,
  autoSync: false,
};

const SYNC_EXTRA_DEFAULTS = {
  sttPersist: false,
};

const btnMd       = document.getElementById('btn-md');
const btnTxt      = document.getElementById('btn-txt');
const togThink    = document.getElementById('tog-thinking');
const togTools    = document.getElementById('tog-tools');
const togBash     = document.getElementById('tog-bash');
const togFraming  = document.getElementById('tog-framing');
const togToolContent = document.getElementById('tog-toolcontent');
const togTruncDocs = document.getElementById('tog-truncdocs');
const togTruncEmbedded = document.getElementById('tog-truncembedded');
const subTruncEmbedded = document.getElementById('sub-truncembedded');
const togDedupDocs = document.getElementById('tog-dedupdocs');
const togKeepFirst = document.getElementById('tog-keepfirst');
const subKeepFirst = document.getElementById('sub-keepfirst');
const togBashReads = document.getElementById('tog-bashreads');
const subBashReads = document.getElementById('sub-bashreads');
const togDedupSessions = document.getElementById('tog-dedupsessions');
const togTrimNoise = document.getElementById('tog-trimnoise');
const btnImport = document.getElementById('btn-import');
const togTruncCode = document.getElementById('tog-trunccode');
const togImages   = document.getElementById('tog-images');
const togOcr      = document.getElementById('tog-ocr');
const togZip      = document.getElementById('tog-zip');
const togZipFiles = document.getElementById('tog-zip-files');
const subOcr      = document.getElementById('sub-ocr');
const subZip      = document.getElementById('sub-zip');
const subBash     = document.getElementById('sub-bash');
const subToolContent = document.getElementById('sub-toolcontent');
const inpUserName = document.getElementById('inp-username');
const status      = document.getElementById('status');
const progLabel   = document.getElementById('prog-label');
const progFill    = document.getElementById('prog-fill');
const togSttPersist = document.getElementById('tog-stt-persist');

function flash(msg) {
  status.textContent = msg;
  setTimeout(() => { status.textContent = ''; }, 1000);
}

function updateSubRows(imagesOn) {
  subOcr.classList.toggle('disabled', !imagesOn);
  subZip.classList.toggle('disabled', !imagesOn);
}

function updateToolRows(toolsOn) {
  subBash.classList.toggle('disabled', !toolsOn);
  subToolContent.classList.toggle('disabled', !toolsOn);
  subTruncEmbedded.classList.toggle('disabled', !toolsOn);
  subBashReads.classList.toggle('disabled', !toolsOn);
}

function applySettings(s) {
  btnMd.classList.toggle('active', s.format === 'md');
  btnTxt.classList.toggle('active', s.format === 'txt');
  togThink.checked     = s.thinking;
  togTools.checked     = s.toolSummaries;
  togBash.checked      = s.includeBash;
  togFraming.checked   = s.exportFraming;
  togToolContent.checked = s.toolContent;
  togTruncDocs.checked  = s.truncateDocs;
  togTruncEmbedded.checked = s.truncateEmbedded;
  togTruncCode.checked = s.truncateCode;
  togDedupDocs.checked = s.dedupDocs;
  togKeepFirst.checked = s.keepFirstDoc;
  togBashReads.checked = s.filterBashReads;
  togDedupSessions.checked = s.dedupSessions;
  togTrimNoise.checked = s.trimNoise;
  subKeepFirst.classList.toggle('disabled', !s.dedupDocs);
  togImages.checked    = s.images;
  togOcr.checked        = s.ocr;
  togZip.checked        = s.zip;
  togZipFiles.checked   = s.zipFiles;
  inpUserName.value     = s.userName === 'User' ? '' : s.userName;
  updateSubRows(s.images);
  updateToolRows(s.toolSummaries);
}

chrome.storage.sync.get({ ...DEFAULTS, ...SYNC_EXTRA_DEFAULTS }, (s) => {
  applySettings(s);
  togSttPersist.checked = s.sttPersist;
});

btnMd.addEventListener('click', () => {
  chrome.storage.sync.set({ format: 'md' }, () => {
    btnMd.classList.add('active');
    btnTxt.classList.remove('active');
    flash('Saved');
  });
});
btnTxt.addEventListener('click', () => {
  chrome.storage.sync.set({ format: 'txt' }, () => {
    btnTxt.classList.add('active');
    btnMd.classList.remove('active');
    flash('Saved');
  });
});

function makeToggle(el, key, onChange) {
  el.addEventListener('change', () => {
    const val = el.checked;
    chrome.storage.sync.set({ [key]: val }, () => {
      flash('Saved');
      if (onChange) onChange(val);
    });
  });
}

makeToggle(togThink,    'thinking');
makeToggle(togTools,    'toolSummaries', updateToolRows);
makeToggle(togBash,     'includeBash');
makeToggle(togFraming,  'exportFraming');
makeToggle(togToolContent, 'toolContent');
makeToggle(togTruncDocs, 'truncateDocs');
makeToggle(togTruncEmbedded, 'truncateEmbedded');
makeToggle(togTruncCode, 'truncateCode');
makeToggle(togDedupDocs, 'dedupDocs', on => subKeepFirst.classList.toggle('disabled', !on));
makeToggle(togKeepFirst, 'keepFirstDoc');
makeToggle(togBashReads, 'filterBashReads');
makeToggle(togDedupSessions, 'dedupSessions');
makeToggle(togTrimNoise, 'trimNoise');
btnImport.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('transcript.html') }));
makeToggle(togImages,   'images', updateSubRows);
makeToggle(togOcr,      'ocr');
makeToggle(togZip,      'zip');
makeToggle(togZipFiles, 'zipFiles');

inpUserName.addEventListener('change', () => {
  const val = inpUserName.value.trim() || 'User';
  chrome.storage.sync.set({ userName: val }, () => flash('Saved'));
});

// ── Progress mirror ───────────────────────────────────────────────────────────
// Polls chrome.storage.local for cce_progress written by content.js

function updateProgress(data) {
  if (!data || !data.cce_progress) return;
  const { pct, label } = data.cce_progress;
  progFill.style.width  = ((pct || 0) * 100).toFixed(1) + '%';
  progLabel.textContent = label || 'Idle';
}

chrome.storage.local.get(['cce_progress'], updateProgress);
const pollTimer = setInterval(() => {
  chrome.storage.local.get(['cce_progress'], updateProgress);
}, 300);

window.addEventListener('unload', () => clearInterval(pollTimer));

// ── Library / multi-account sweep ─────────────────────────────────────────────

const libAccountLabel   = document.getElementById('lib-account-label');
const btnSweep          = document.getElementById('btn-sweep');
const sweepProgressSec  = document.getElementById('sweep-progress-section');
const sweepProgLabel    = document.getElementById('sweep-prog-label');
const sweepProgFill     = document.getElementById('sweep-prog-fill');
const libAccountsList   = document.getElementById('lib-accounts-list');
const btnExportLib      = document.getElementById('btn-export-lib');
const togAutoSync       = document.getElementById('tog-autosync');

let currentOrgId = null;
let sweepRunning = false;

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
}

function renderAccountsList(stats) {
  if (!stats || !stats.length) {
    libAccountsList.innerHTML = '<div style="color:#444;font-size:10px;padding:2px 0;">No accounts swept yet</div>';
    return;
  }
  libAccountsList.innerHTML = stats.map(a => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:3px 0;border-bottom:1px solid #1e1e1e;">
      <div style="flex:1;min-width:0;">
        <div style="font-size:10px;color:#bbb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${a.email || a.orgName || a.orgId.slice(0, 12) + '…'}
        </div>
        <div style="font-size:9px;color:#555;">
          ${a.convCount} chats · ${a.sweepDone ? '✓ ' + fmtDate(a.sweepCompletedAt) : 'incomplete'}
          ${a.orgId === currentOrgId ? ' · <span style="color:#7a9a7a;">active</span>' : ''}
        </div>
      </div>
      <button data-orgid="${a.orgId}" class="btn-clear-acct" style="
        margin-left:6px;padding:2px 5px;background:#2a1a1a;border:1px solid #4a2a2a;
        color:#8a5a5a;border-radius:3px;cursor:pointer;font-size:9px;flex-shrink:0;
      ">✕</button>
    </div>
  `).join('');

  libAccountsList.querySelectorAll('.btn-clear-acct').forEach(btn => {
    btn.addEventListener('click', () => {
      const orgId = btn.dataset.orgid;
      if (!confirm(`Clear cached data for this account?`)) return;
      chrome.runtime.sendMessage({ action: 'clearLibrary', orgId }, resp => {
        if (!resp?.success) {
          console.warn('[popup] clear refused:', resp?.error);
          flash('Sync running — try later');
        }
        refreshLibraryUI();
      });
    });
  });
}

function refreshLibraryUI() {
  chrome.runtime.sendMessage({ action: 'getLibraryStats' }, resp => {
    if (resp?.success) renderAccountsList(resp.stats);
  });
}

const STATUS_STALE_MS = 60000;
let lastStatus = null;

function sweepLabel(st) {
  const failed = st.failed ? ` · ${st.failed} failed` : '';
  if (st.phase === 'error') return `Sync failed: ${st.error || 'unknown error'}`;
  if (st.phase === 'listing') return 'Listing chats…';
  if (st.phase === 'done') return `Up to date — ${st.done} chats${failed}`;
  const stale = Date.now() - (st.updatedAt || 0) > STATUS_STALE_MS;
  return `${stale ? 'Resuming… ' : ''}${st.done} / ${st.total} conversations${failed}`;
}

function renderSweepStatus(st) {
  lastStatus = st || null;
  sweepRunning = !!(st && st.running);
  btnSweep.disabled = sweepRunning;
  btnSweep.textContent = sweepRunning ? '⏳ Syncing…' : '⬇ Sync this account now';

  const recent = st && (st.running || Date.now() - (st.updatedAt || 0) < STATUS_STALE_MS);
  sweepProgressSec.style.display = recent ? 'block' : 'none';
  if (!recent) return;

  const pct = st.phase === 'done' ? 100 : (st.total > 0 ? Math.min(st.done / st.total, 1) * 100 : 0);
  sweepProgFill.style.width = pct.toFixed(1) + '%';
  sweepProgLabel.textContent = sweepLabel(st);
}

// Library UI is dev-mode only; account detection runs once when it is first revealed.
let libraryInited = false;
function initLibraryUI() {
  if (libraryInited) return;
  libraryInited = true;
  console.log('[popup] library UI init');
  chrome.runtime.sendMessage({ action: 'detectOrgAndAccount' }, resp => {
    if (resp?.success) {
      currentOrgId = resp.orgId;
      const label = resp.email || resp.orgName || resp.orgId.slice(0, 16) + '…';
      libAccountLabel.textContent = label;
      libAccountLabel.style.color = '#aaa';
    } else {
      libAccountLabel.textContent = 'Not on claude.ai';
    }
    refreshLibraryUI();
  });
}

btnSweep.addEventListener('click', () => {
  if (sweepRunning) return;
  console.log('[popup] manual sync requested');
  sweepProgressSec.style.display = 'block';
  sweepProgLabel.textContent = 'Starting…';
  sweepProgFill.style.width = '0%';
  chrome.runtime.sendMessage({ action: 'sweepAccount' }, resp => {
    if (chrome.runtime.lastError || !resp?.success) {
      console.error('[popup] sync request failed:', chrome.runtime.lastError?.message || resp?.error);
      flash('Sync failed to start');
      return;
    }
    if (resp.alreadyRunning) flash('Already syncing');
  });
});

togAutoSync.addEventListener('change', () => {
  const val = togAutoSync.checked;
  chrome.storage.local.set({ autoSync: val }, () => {
    console.log('[popup] autoSync =', val);
    flash(val ? 'Auto-sync on' : 'Auto-sync off');
  });
});

// Live status comes from chrome.storage.local, written by the background sync, so the popup
// can be closed and reopened mid-sync without losing anything.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.sweepStatus) {
    const wasRunning = !!(lastStatus && lastStatus.running);
    const next = changes.sweepStatus.newValue || null;
    renderSweepStatus(next);
    if (wasRunning && !(next && next.running)) refreshLibraryUI();
  }
  if (changes.autoSync) togAutoSync.checked = !!changes.autoSync.newValue;
});

document.getElementById('btn-search-lib').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('search.html') });
});

btnExportLib.addEventListener('click', () => {
  btnExportLib.textContent = '…exporting';
  btnExportLib.disabled = true;
  // Export runs in content script context (needs DOM + URL.createObjectURL)
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tabId = tabs[0]?.id;
    if (!tabId) { flash('No active tab'); btnExportLib.disabled = false; btnExportLib.textContent = '↓ Export full library (ZIP)'; return; }
    chrome.tabs.sendMessage(tabId, { action: 'exportLibraryZip' }, resp => {
      btnExportLib.textContent = '↓ Export full library (ZIP)';
      btnExportLib.disabled = false;
      if (resp?.success) flash(`Exported ${resp.total} chats`);
      else flash('Export failed — open a claude.ai tab first');
    });
  });
});

// ── Dev mode ──────────────────────────────────────────────────────────────────

const devSection   = document.getElementById('dev-section');
const versionBadge = document.getElementById('version-badge');

function applyDevMode(enabled) {
  devSection.style.display = enabled ? 'block' : 'none';
  versionBadge.style.color = enabled ? '#c8902a' : '#333';
  if (enabled) initLibraryUI();
}

chrome.storage.local.get({ ...LOCAL_DEFAULTS, sweepStatus: null }, local => {
  console.log('[popup] devMode =', local.devMode, 'autoSync =', local.autoSync);
  applyDevMode(local.devMode);
  togAutoSync.checked = !!local.autoSync;
  renderSweepStatus(local.sweepStatus);
});

togSttPersist.addEventListener('change', () => {
  const val = togSttPersist.checked;
  chrome.storage.sync.set({ sttPersist: val }, () => flash(val ? 'Mic persist on' : 'Mic persist off'));
});

// Tap version badge 4 times within 2s to toggle dev mode
let _tapCount = 0;
let _tapTimer = null;

versionBadge.addEventListener('click', () => {
  _tapCount++;
  clearTimeout(_tapTimer);
  _tapTimer = setTimeout(() => { _tapCount = 0; }, 2000);

  if (_tapCount >= 4) {
    _tapCount = 0;
    clearTimeout(_tapTimer);
    chrome.storage.local.get(LOCAL_DEFAULTS, local => {
      const next = !local.devMode;
      chrome.storage.local.set({ devMode: next }, () => {
        applyDevMode(next);
        flash(next ? 'Dev mode on' : 'Dev mode off');
      });
    });
  }
});
