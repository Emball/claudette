// popup.js — settings + progress mirror

const DEFAULTS = {
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

const LOCAL_DEFAULTS = {
  devMode: false,
};

const SYNC_EXTRA_DEFAULTS = {
  sttPersist: false,
};

const btnMd       = document.getElementById('btn-md');
const btnTxt      = document.getElementById('btn-txt');
const togThink    = document.getElementById('tog-thinking');
const togTools    = document.getElementById('tog-tools');
const togBash     = document.getElementById('tog-bash');
const togImages   = document.getElementById('tog-images');
const togOcr      = document.getElementById('tog-ocr');
const togZip      = document.getElementById('tog-zip');
const togZipFiles = document.getElementById('tog-zip-files');
const subOcr      = document.getElementById('sub-ocr');
const subZip      = document.getElementById('sub-zip');
const subBash     = document.getElementById('sub-bash');
const inpUserName = document.getElementById('inp-username');
const status      = document.getElementById('status');
const progLabel   = document.getElementById('prog-label');
const progFill    = document.getElementById('prog-fill');

function flash(msg) {
  status.textContent = msg;
  setTimeout(() => { status.textContent = ''; }, 1000);
}

function updateSubRows(imagesOn) {
  subOcr.classList.toggle('disabled', !imagesOn);
  subZip.classList.toggle('disabled', !imagesOn);
}

function updateBashRow(toolsOn) {
  subBash.classList.toggle('disabled', !toolsOn);
}

function applySettings(s) {
  btnMd.classList.toggle('active', s.format === 'md');
  btnTxt.classList.toggle('active', s.format === 'txt');
  togThink.checked     = s.thinking;
  togTools.checked     = s.toolSummaries;
  togBash.checked      = s.includeBash;
  togImages.checked    = s.images;
  togOcr.checked        = s.ocr;
  togZip.checked        = s.zip;
  togZipFiles.checked   = s.zipFiles;
  inpUserName.value     = s.userName === 'User' ? '' : s.userName;
  updateSubRows(s.images);
  updateBashRow(s.toolSummaries);
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
makeToggle(togTools,    'toolSummaries', updateBashRow);
makeToggle(togBash,     'includeBash');
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
      chrome.runtime.sendMessage({ action: 'clearLibrary', orgId }, () => refreshLibraryUI());
    });
  });
}

function refreshLibraryUI() {
  chrome.runtime.sendMessage({ action: 'getLibraryStats' }, resp => {
    if (resp?.success) renderAccountsList(resp.stats);
  });
}

function setSweepRunning(running) {
  sweepRunning = running;
  btnSweep.disabled = running;
  btnSweep.textContent = running ? '⏳ Sweeping…' : '⬇ Sweep this account';
  sweepProgressSec.style.display = running ? 'block' : 'none';
}

// Detect current account on popup open
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

btnSweep.addEventListener('click', () => {
  if (sweepRunning) return;
  setSweepRunning(true);
  sweepProgLabel.textContent = 'Starting sweep…';
  sweepProgFill.style.width = '0%';

  chrome.runtime.sendMessage({ action: 'sweepAccount' }, resp => {
    setSweepRunning(false);
    if (resp?.success) {
      flash(`Swept ${resp.fetched} chats`);
      sweepProgLabel.textContent = `Done — ${resp.fetched} chats`;
      sweepProgFill.style.width = '100%';
    } else {
      flash('Sweep failed');
      sweepProgLabel.textContent = 'Sweep failed';
      sweepProgFill.style.width = '0%';
    }
    refreshLibraryUI();
  });
});

// Listen for live sweep progress from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action !== 'sweepProgress') return;
  const pct = msg.total > 0 ? ((msg.done / msg.total) * 100).toFixed(1) : 0;
  sweepProgFill.style.width = pct + '%';
  sweepProgLabel.textContent = msg.phase === 'done'
    ? `Done — ${msg.done} chats`
    : `${msg.done} / ${msg.total} conversations`;
});

btnExportLib.addEventListener('click', () => {
  btnExportLib.textContent = '…exporting';
  btnExportLib.disabled = true;
  chrome.runtime.sendMessage({ action: 'exportLibrary' }, resp => {
    btnExportLib.textContent = '↓ Export full library (JSONL)';
    btnExportLib.disabled = false;
    if (resp?.success) flash(`Exported ${resp.lineCount} chats`);
    else flash('Export failed');
  });
});

// ── Dev mode ──────────────────────────────────────────────────────────────────

const devSection   = document.getElementById('dev-section');
const togSttPersist = document.getElementById('tog-stt-persist');
const versionBadge = document.getElementById('version-badge');

function applyDevMode(enabled) {
  devSection.style.display = enabled ? 'block' : 'none';
  versionBadge.style.color = enabled ? '#c8902a' : '#333';
}

chrome.storage.local.get(LOCAL_DEFAULTS, local => {
  applyDevMode(local.devMode);
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
