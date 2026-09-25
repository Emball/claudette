// image_classifier.js — content script
// Three-tier image classification with a parallel OCR worker pool.
//
// Tier 1: screenshot with extractable text  → [screenshot: "text"]
// Tier 2: screenshot, no extractable text   → [screenshot: no extractable text]
// Tier 3: photo / diagram                   → saved as image file in ZIP

// --- Photo fingerprint ---

const CAMERA_RATIOS = [
  [4, 3], [3, 4],
  [3, 2], [2, 3],
  [16, 9], [9, 16],
  [1, 1],
  [5, 4], [4, 5],
  [5, 3], [3, 5],
  [7, 5], [5, 7],
  [16, 10], [10, 16],
];

function matchesCameraRatio(w, h) {
  for (const [rw, rh] of CAMERA_RATIOS) {
    const diff = Math.abs(w * rh - h * rw);
    if (diff === 0) return true;
    if (Math.abs((w - 1) * rh - h * rw) === 0) return true;
    if (Math.abs((w + 1) * rh - h * rw) === 0) return true;
    if (Math.abs(w * rh - (h - 1) * rw) === 0) return true;
    if (Math.abs(w * rh - (h + 1) * rw) === 0) return true;
  }
  return false;
}

function photoScore(width, height, fileSize, mimeType) {
  let score = 0;
  const mp = (width || 0) * (height || 0);

  if      (mp >= 12_000_000) score += 3;
  else if (mp >=  9_000_000) score += 2;
  else if (mp <   4_000_000) score -= 1;

  if (width && height && matchesCameraRatio(width, height)) score += 2;
  else score -= 1;

  if      (mimeType === 'image/png')                               score -= 2;
  else if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') score += 1;

  if      (fileSize >= 500_000) score += 1;
  else if (fileSize < 100_000)  score -= 1;

  return score;
}

// --- OCR worker pool ---
// Multiple concurrent OCR jobs via the background iframe bridge.
// Each job is a separate sendMessage call; background.js spawns one iframe per job.
// Pool size matches background.js FETCH_CONCURRENCY (3) by default.

const OCR_POOL_SIZE = 3; // concurrent OCR jobs

// Semaphore — limits parallel OCR calls so we don't spin up dozens of iframes at once
class Semaphore {
  constructor(n) {
    this._slots = n;
    this._queue = [];
  }
  acquire() {
    if (this._slots > 0) {
      this._slots--;
      return Promise.resolve();
    }
    return new Promise(res => this._queue.push(res));
  }
  release() {
    if (this._queue.length > 0) {
      this._queue.shift()();
    } else {
      this._slots++;
    }
  }
}

const ocrSem = new Semaphore(OCR_POOL_SIZE);

async function ocrDataUrl(dataUrl) {
  await ocrSem.acquire();
  try {
    return await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'ocr', dataUrl }, result => {
        if (chrome.runtime.lastError)
          return reject(new Error(chrome.runtime.lastError.message));
        if (!result)
          return reject(new Error('no response from background'));
        if (result.error)
          return reject(new Error(result.error));
        resolve(result);
      });
    });
  } finally {
    ocrSem.release();
  }
}

// --- Classifier ---
//
// Decision matrix:
//
//  fingerprint=photo,      zip=on  → save to ZIP
//  fingerprint=photo,      zip=off → [User posted a photo: filename]
//
//  fingerprint=screenshot, ocr=on,  text found                          → [screenshot: "text"]
//  fingerprint=screenshot, ocr=on,  no text / error / timeout, zip=on  → save to ZIP
//  fingerprint=screenshot, ocr=on,  no text / error / timeout, zip=off → [screenshot: no extractable text]
//  fingerprint=screenshot, ocr=off, zip=on  → save to ZIP
//  fingerprint=screenshot, ocr=off, zip=off → [screenshot: no extractable text]

async function classifyFromUrl(url, width, height, index, settings) {
  if (!settings.images) {
    console.log(`[classifier] image ${index}: skipped (images disabled)`);
    return { tier: 'skip' };
  }

  let blob, mimeType, fileSize;
  try {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`fetch ${resp.status}`);
    blob     = await resp.blob();
    mimeType = blob.type;
    fileSize = blob.size;
  } catch (err) {
    console.error(`[classifier] image ${index}: fetch error:`, err.message);
    return { tier: 'screenshot-notext' };
  }

  const score = photoScore(width, height, fileSize, mimeType);
  const isPhoto = score >= 2;
  console.log(
    `[classifier] image ${index}: ${width}x${height}, ` +
    `${(fileSize / 1024).toFixed(0)}KB, ${mimeType}, score=${score} → ${isPhoto ? 'photo' : 'screenshot'}`
  );

  // --- Photo path ---
  if (isPhoto) {
    if (settings.zip) {
      console.log(`[classifier] image ${index}: photo, zip=on → save to ZIP`);
      return { tier: 'save', blob, isPhoto: true };
    }
    console.log(`[classifier] image ${index}: photo, zip=off → placeholder`);
    return { tier: 'photo-nozip' };
  }

  // --- Screenshot path ---
  if (!settings.ocr) {
    if (settings.zip) {
      console.log(`[classifier] image ${index}: screenshot, ocr=off, zip=on → save to ZIP`);
      return { tier: 'save', blob };
    }
    console.log(`[classifier] image ${index}: screenshot, ocr=off, zip=off → notext`);
    return { tier: 'screenshot-notext' };
  }

  // OCR enabled — run it
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

  try {
    const { text, confidence } = await ocrDataUrl(dataUrl);
    console.log(`[classifier] image ${index}: OCR confidence=${confidence}, chars=${text?.length ?? 0}`);

    if (confidence >= 35 && text?.length >= 20) {
      console.log(`[classifier] image ${index}: screenshot with text → inline`);
      return { tier: 'screenshot-text', text };
    }

    // OCR ran but found nothing useful
    if (settings.zip) {
      console.log(`[classifier] image ${index}: screenshot, no text, zip=on → save to ZIP`);
      return { tier: 'save', blob };
    }
    console.log(`[classifier] image ${index}: screenshot, no text, zip=off → notext`);
    return { tier: 'screenshot-notext' };

  } catch (err) {
    // OCR errored or timed out — treat same as no text
    console.error(`[classifier] image ${index}: OCR error (${err.message})`);
    if (settings.zip) {
      console.log(`[classifier] image ${index}: OCR error, zip=on → save to ZIP`);
      return { tier: 'save', blob };
    }
    console.log(`[classifier] image ${index}: OCR error, zip=off → notext`);
    return { tier: 'screenshot-notext' };
  }
}

// --- Public API ---

const ImageClassifier = {
  // Classify a single image. Settings object from chrome.storage.sync.
  async classify(previewUrl, width, height, index, settings = {}) {
    const s = {
      images: settings.images ?? true,
      ocr:    settings.ocr   ?? false,
      zip:    settings.zip   ?? true,
    };
    return classifyFromUrl(previewUrl, width, height, index, s);
  },

  // Classify many images in parallel (up to OCR_POOL_SIZE concurrent OCR jobs).
  async classifyAll(imageList, settings = {}) {
    const s = {
      images: settings.images ?? true,
      ocr:    settings.ocr   ?? false,
      zip:    settings.zip   ?? true,
    };
    console.log(`[classifier] classifyAll: ${imageList.length} images, pool=${OCR_POOL_SIZE}`);
    return Promise.all(
      imageList.map(({ url, width, height, index }) =>
        classifyFromUrl(url, width, height, index, s)
      )
    );
  },

  async terminate() {
    console.log('[classifier] pool terminated');
  },
};
