// stt_patch.js — document_start injection
// Keeps Claude.ai's STT mic active when the user switches tabs.
//
// Root cause: Chrome throttles ScriptProcessorNode.onaudioprocess when
// document.visibilityState === 'hidden', starving the audio pipeline.
// Claude.ai also fires a visibility listener that tears down the mic.
//
// Fix: spoof document.visibilityState / document.hidden so the page and
// Chrome both believe the tab is always visible. This prevents both the
// JS-level tear-down and the ScriptProcessorNode throttle.
//
// Only active when devMode + sttPersist are both on (bridged from content.js
// via CustomEvent, since chrome.storage is unavailable at document_start).

(function () {
  let persist = false;

  // Bridge from content.js (fires once on load, then on setting changes)
  window.addEventListener('_cce_stt_persist', (e) => {
    persist = !!e.detail;
    applyVisibilitySpoofing();
  });

  // Track real visibility state for cleanup
  let spoofing = false;
  const realHiddenDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
  const realVisibilityDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');

  function applyVisibilitySpoofing() {
    if (persist && !spoofing) {
      // Override document.hidden → always false
      Object.defineProperty(document, 'hidden', {
        get: () => false,
        configurable: true,
      });
      // Override document.visibilityState → always 'visible'
      Object.defineProperty(document, 'visibilityState', {
        get: () => 'visible',
        configurable: true,
      });
      // Swallow visibilitychange events so Claude.ai's listener never fires
      document.addEventListener('visibilitychange', suppressVisibilityChange, true);
      spoofing = true;
      console.debug('[Claudette] sttPersist: visibility spoofing active');
    } else if (!persist && spoofing) {
      // Restore real behavior
      Object.defineProperty(document, 'hidden', realHiddenDescriptor);
      Object.defineProperty(document, 'visibilityState', realVisibilityDescriptor);
      document.removeEventListener('visibilitychange', suppressVisibilityChange, true);
      spoofing = false;
      console.debug('[Claudette] sttPersist: visibility spoofing removed');
    }
  }

  function suppressVisibilityChange(e) {
    e.stopImmediatePropagation();
  }

  // Also suppress CloseStream on voice_stream WebSockets as belt-and-suspenders
  const NativeWebSocket = window.WebSocket;

  class PatchedWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      this._isVoiceStream = typeof url === 'string' && url.includes('voice_stream');
    }

    send(data) {
      if (this._isVoiceStream && persist && typeof data === 'string') {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'CloseStream') {
            console.debug('[Claudette] sttPersist: suppressed CloseStream');
            return;
          }
        } catch (_) {}
      }
      super.send(data);
    }
  }

  window.WebSocket = PatchedWebSocket;
})();
