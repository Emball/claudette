// stt_patch.js — document_start injection
// Patches WebSocket to suppress CloseStream on voice_stream sockets when
// sttPersist is active, keeping the Deepgram stream alive across tab switches.
// Must run at document_start so the patch is in place before Claude.ai's code runs.

(function () {
  const NativeWebSocket = window.WebSocket;

  // sttPersist state — bootstrapped via a custom event fired by content.js
  // (chrome.storage is unavailable at document_start in the page world)
  let persist = false;

  window.addEventListener('_cce_stt_persist', (e) => {
    persist = !!e.detail;
  });

  class PatchedWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      this._isVoiceStream = typeof url === 'string' && url.includes('voice_stream');
    }

    send(data) {
      if (this._isVoiceStream && persist) {
        // Suppress CloseStream so the mic keeps running on tab switch
        if (typeof data === 'string') {
          try {
            const msg = JSON.parse(data);
            if (msg.type === 'CloseStream') {
              console.debug('[Claudette] sttPersist: suppressed CloseStream');
              return;
            }
          } catch (_) {}
        }
      }
      super.send(data);
    }
  }

  window.WebSocket = PatchedWebSocket;
})();
