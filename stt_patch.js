// stt_patch.js — document_start injection
// Wraps SpeechRecognition so it survives tab switches when sttPersist is enabled.
// Runs before Claude.ai's own scripts so the patched class is what they bind to.

(function () {
  const Native = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Native) return;

  class PersistentSpeechRecognition extends Native {
    constructor() {
      super();
      this._persisting = false;
      this._userStopped = false;

      this.addEventListener('end', () => {
        if (this._persisting && !this._userStopped && document.visibilityState === 'hidden') {
          try { this.start(); } catch (_) {}
        }
      });

      this.addEventListener('error', (e) => {
        if (this._persisting && !this._userStopped && e.error === 'not-allowed') {
          // Mic permission revoked — don't loop
          this._persisting = false;
        }
      });
    }

    start() {
      this._userStopped = false;
      super.start();
    }

    stop() {
      this._userStopped = true;
      super.stop();
    }

    abort() {
      this._userStopped = true;
      super.abort();
    }
  }

  // Poll chrome.storage.local for sttPersist flag and update all active instances
  function syncPersist(instances) {
    chrome.storage.local.get({ devMode: false, sttPersist: false }, (data) => {
      const active = data.devMode && data.sttPersist;
      instances.forEach(inst => { inst._persisting = active; });
    });
  }

  const instances = [];

  const OrigClass = window.SpeechRecognition ? 'SpeechRecognition' : 'webkitSpeechRecognition';
  window[OrigClass] = function (...args) {
    const inst = new PersistentSpeechRecognition(...args);
    instances.push(inst);
    syncPersist(instances);
    return inst;
  };
  window[OrigClass].prototype = PersistentSpeechRecognition.prototype;

  // Re-sync on storage changes (user toggles the dev switch while a session is live)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && ('devMode' in changes || 'sttPersist' in changes)) {
      syncPersist(instances);
    }
  });
})();
