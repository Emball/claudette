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
  devMode:    false,
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

chrome.storage.sync.get(DEFAULTS, applySettings);

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
  togSttPersist.checked = local.sttPersist;
});

togSttPersist.addEventListener('change', () => {
  const val = togSttPersist.checked;
  chrome.storage.local.set({ sttPersist: val }, () => flash(val ? 'Mic persist on' : 'Mic persist off'));
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
