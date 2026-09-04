// background.js — service worker

const API_BASE       = 'https://claude.ai/api';
const FETCH_CONCURRENCY = 3;    // parallel conversation fetches
const FETCH_DELAY_MS    = 200;  // ms between starting each fetch slot (rate limit buffer)
const MEM_CEILING_MB    = 200;  // pause queue if estimated heap exceeds this

async function apiFetch(path) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { 'Accept': 'application/json' },
  });
  if (!response.ok) throw new Error(`API ${response.status}: ${path}`);
  return response.json();
}

async function detectOrgAndAccount() {
  const orgs = await apiFetch('/organizations');
  if (!Array.isArray(orgs) || orgs.length === 0) throw new Error('No organizations found');
  const chatOrg = orgs.find(o => o.capabilities?.includes('chat')) || orgs[0];
  const orgId = chatOrg.uuid;

  // Try to resolve a human-readable account identity
  let email = null;
  try {
    const acct = await apiFetch('/account');
    email = acct?.email_address || acct?.email || null;
  } catch (_) {}

  return { orgId, email, orgName: chatOrg.name || null };
}

async function detectOrgId() {
  const { orgId } = await detectOrgAndAccount();
  return orgId;
}

async function fetchConversation(orgId, convId) {
  return apiFetch(
    `/organizations/${orgId}/chat_conversations/${convId}` +
    `?tree=True&rendering_mode=messages&render_all_tools=true`
  );
}

async function fetchAllConversations(orgId) {
  return apiFetch(`/organizations/${orgId}/chat_conversations`);
}

async function fetchProjects(orgId) {
  return apiFetch(`/organizations/${orgId}/projects`);
}

// --- Concurrency queue ---
// Fetches up to FETCH_CONCURRENCY conversations in parallel.
// Pauses when estimated memory use crosses MEM_CEILING_MB.
// Reports per-item progress back via chrome.tabs.sendMessage.

function estimatedHeapMB() {
  if (performance?.memory) return performance.memory.usedJSHeapSize / 1_048_576;
  return 0; // unavailable in service worker on some platforms
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function concurrentFetch(orgId, convIds, tabId) {
  const results = new Array(convIds.length);
  let nextIdx = 0;
  const total = convIds.length;

  async function worker() {
    while (nextIdx < total) {
      // Memory ceiling — pause this slot until heap settles
      while (estimatedHeapMB() > MEM_CEILING_MB) {
        console.warn(`[bg] heap ~${estimatedHeapMB().toFixed(0)}MB — pausing`);
        await delay(1000);
      }

      const i = nextIdx++;
      const convId = convIds[i];
      try {
        const data = await fetchConversation(orgId, convId);
        results[i] = { success: true, data };
        console.log(`[bg] fetched ${i + 1}/${total}: ${convId}`);
      } catch (err) {
        console.error(`[bg] failed ${convId}:`, err.message);
        results[i] = { success: false, uuid: convId, error: err.message };
      }

      // Report progress to the content script
      if (tabId) {
        chrome.tabs.sendMessage(tabId, {
          action: 'exportProgress',
          done: i + 1,
          total,
        }).catch(() => {}); // tab may have navigated
      }

      // Small stagger between slot starts to spread API load
      await delay(FETCH_DELAY_MS);
    }
  }

  // Launch N parallel workers
  const slots = Array.from({ length: Math.min(FETCH_CONCURRENCY, total) }, () => worker());
  await Promise.all(slots);

  return results;
}

// --- OCR iframe bridge ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[bg] message:', request.action);

  if (request.action === 'ocr') {
    (async () => {
      try {
        const tabId = sender.tab
          ? sender.tab.id
          : (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;

        const engineUrl = chrome.runtime.getURL('ocr_engine.html');
        const result = await new Promise((resolve, reject) => {
          const id = Math.random().toString(36).slice(2);
          const timer = setTimeout(() => {
            chrome.runtime.onMessage.removeListener(listener);
            reject(new Error('OCR timeout'));
          }, 120_000);

          function listener(msg) {
            if (msg.action === 'ocr_result' && msg.id === id) {
              clearTimeout(timer);
              chrome.runtime.onMessage.removeListener(listener);
              resolve(msg.result);
              return true;
            }
          }
          chrome.runtime.onMessage.addListener(listener);

          chrome.scripting.executeScript({
            target: { tabId },
            func: (engineUrl, id, dataUrl) => {
              let frame = document.getElementById('cce-ocr-engine-' + id);
              if (!frame) {
                frame = document.createElement('iframe');
                frame.id = 'cce-ocr-engine-' + id;
                frame.style.cssText =
                  'display:none!important;width:0;height:0;border:0;position:fixed;';
                frame.src = engineUrl;
                frame.onload = () => {
                  frame.contentWindow.postMessage(
                    { __cce_engine_run: { id, dataUrl } }, '*'
                  );
                };
                document.documentElement.appendChild(frame);
              }
              window.addEventListener('message', function handler(e) {
                if (!e.data?.__cce_engine_result) return;
                if (e.data.__cce_engine_result.id !== id) return;
                window.removeEventListener('message', handler);
                frame.remove();
                chrome.runtime.sendMessage({
                  action:  'ocr_result',
                  id:      e.data.__cce_engine_result.id,
                  result:  e.data.__cce_engine_result.result,
                });
              });
            },
            args: [engineUrl, id, request.dataUrl],
          });
        });

        sendResponse(result);
      } catch (err) {
        console.error('[bg] OCR error:', err);
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'detectOrgId') {
    detectOrgId()
      .then(orgId => sendResponse({ success: true, orgId }))
      .catch(err  => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'detectOrgAndAccount') {
    detectOrgAndAccount()
      .then(info => sendResponse({ success: true, ...info }))
      .catch(err  => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'sweepAccount') {
    (async () => {
      try {
        const { orgId, email, orgName } = await detectOrgAndAccount();

        // Load account registry
        const stored = await chrome.storage.local.get(['accountRegistry', 'sweepCursor']);
        const registry = stored.accountRegistry || {};
        const cursor   = stored.sweepCursor || {};

        // Fetch full conversation list
        const allConvs = await fetchAllConversations(orgId);
        const convIndex = {};
        for (const c of allConvs) {
          convIndex[c.uuid] = { uuid: c.uuid, name: c.name, created_at: c.created_at, updated_at: c.updated_at };
        }

        // Register / update account entry
        if (!registry[orgId]) {
          registry[orgId] = { orgId, email, orgName, firstSeen: Date.now() };
        }
        registry[orgId].email    = email || registry[orgId].email;
        registry[orgId].orgName  = orgName || registry[orgId].orgName;
        registry[orgId].convCount = allConvs.length;
        registry[orgId].sweepStarted = Date.now();
        registry[orgId].sweepDone = false;
        await chrome.storage.local.set({ accountRegistry: registry });

        // Resumable cursor: skip already-fetched UUIDs for this org
        const prevFetched = new Set(cursor[orgId] || []);
        const pending = allConvs.map(c => c.uuid).filter(id => !prevFetched.has(id));

        console.log(`[bg] sweep ${orgId}: ${allConvs.length} total, ${pending.length} to fetch`);

        // Notify popup of sweep start
        chrome.runtime.sendMessage({
          action: 'sweepProgress', orgId,
          done: prevFetched.size, total: allConvs.length, phase: 'fetching'
        }).catch(() => {});

        // Fetch in batches; write to library as we go
        const stored2 = await chrome.storage.local.get('library');
        const library = stored2.library || {};
        if (!library[orgId]) library[orgId] = {};

        const BATCH = 20;
        let fetched = prevFetched.size;

        for (let bStart = 0; bStart < pending.length; bStart += BATCH) {
          const batch = pending.slice(bStart, bStart + BATCH);

          // Pause if memory is high
          while (estimatedHeapMB() > MEM_CEILING_MB) {
            console.warn(`[bg] sweep heap ~${estimatedHeapMB().toFixed(0)}MB — pausing`);
            await delay(1500);
          }

          const batchResults = await Promise.all(
            batch.map(async (convId, bi) => {
              await delay(bi * FETCH_DELAY_MS);
              try {
                const data = await fetchConversation(orgId, convId);
                return { convId, success: true, data };
              } catch (err) {
                console.error(`[bg] sweep failed ${convId}:`, err.message);
                return { convId, success: false };
              }
            })
          );

          for (const r of batchResults) {
            if (r.success) {
              const meta = convIndex[r.convId] || {};
              library[orgId][r.convId] = {
                uuid: r.convId,
                name: meta.name || '',
                created_at: meta.created_at || null,
                updated_at: meta.updated_at || null,
                messages: r.data.chat_messages || r.data.messages || [],
                fetchedAt: Date.now(),
              };
              prevFetched.add(r.convId);
            }
            fetched++;
          }

          // Persist library + cursor after each batch
          cursor[orgId] = [...prevFetched];
          await chrome.storage.local.set({ library, sweepCursor: cursor });

          chrome.runtime.sendMessage({
            action: 'sweepProgress', orgId,
            done: fetched, total: allConvs.length, phase: 'fetching'
          }).catch(() => {});
        }

        // Mark sweep complete
        const reg2 = (await chrome.storage.local.get('accountRegistry')).accountRegistry || registry;
        reg2[orgId].sweepDone = true;
        reg2[orgId].sweepCompletedAt = Date.now();
        reg2[orgId].convCount = Object.keys(library[orgId] || {}).length;
        await chrome.storage.local.set({ accountRegistry: reg2 });

        chrome.runtime.sendMessage({
          action: 'sweepProgress', orgId,
          done: fetched, total: allConvs.length, phase: 'done'
        }).catch(() => {});

        sendResponse({ success: true, orgId, fetched, total: allConvs.length });
      } catch (err) {
        console.error('[bg] sweep error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'exportLibrary') {
    (async () => {
      try {
        const stored = await chrome.storage.local.get(['library', 'accountRegistry']);
        const library  = stored.library  || {};
        const registry = stored.accountRegistry || {};

        // Build JSONL: one line per conversation, with account metadata embedded
        const lines = [];
        for (const [orgId, convMap] of Object.entries(library)) {
          const acct = registry[orgId] || { orgId };
          for (const conv of Object.values(convMap)) {
            lines.push(JSON.stringify({
              orgId,
              accountEmail: acct.email || null,
              accountName:  acct.orgName || null,
              ...conv,
            }));
          }
        }

        const blob = new Blob([lines.join('\n')], { type: 'application/jsonl' });
        const url  = URL.createObjectURL(blob);
        const ts   = new Date().toISOString().slice(0, 10);
        await chrome.downloads.download({
          url,
          filename: `claudette-library-${ts}.jsonl`,
          saveAs: false,
        });
        URL.revokeObjectURL(url);

        sendResponse({ success: true, lineCount: lines.length });
      } catch (err) {
        console.error('[bg] exportLibrary error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'getLibraryStats') {
    (async () => {
      try {
        const stored = await chrome.storage.local.get(['library', 'accountRegistry']);
        const library  = stored.library  || {};
        const registry = stored.accountRegistry || {};
        const stats = Object.entries(registry).map(([orgId, acct]) => ({
          orgId,
          email:     acct.email || null,
          orgName:   acct.orgName || null,
          firstSeen: acct.firstSeen || null,
          sweepDone: acct.sweepDone || false,
          sweepCompletedAt: acct.sweepCompletedAt || null,
          convCount: Object.keys(library[orgId] || {}).length,
        }));
        sendResponse({ success: true, stats });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'clearLibrary') {
    (async () => {
      try {
        const { orgId } = request;
        if (orgId) {
          // Clear single account
          const stored = await chrome.storage.local.get(['library', 'sweepCursor', 'accountRegistry']);
          const lib = stored.library || {};
          const cur = stored.sweepCursor || {};
          const reg = stored.accountRegistry || {};
          delete lib[orgId];
          delete cur[orgId];
          if (reg[orgId]) { reg[orgId].sweepDone = false; delete reg[orgId].sweepCompletedAt; }
          await chrome.storage.local.set({ library: lib, sweepCursor: cur, accountRegistry: reg });
        } else {
          await chrome.storage.local.remove(['library', 'sweepCursor']);
        }
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'fetchConversation') {
    fetchConversation(request.orgId, request.convId)
      .then(data => sendResponse({ success: true, data }))
      .catch(err  => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'fetchAllConversations') {
    fetchAllConversations(request.orgId)
      .then(data => sendResponse({ success: true, data }))
      .catch(err  => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'fetchProjects') {
    fetchProjects(request.orgId)
      .then(data => sendResponse({ success: true, data }))
      .catch(err  => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'selectedExport') {
    (async () => {
      try {
        const { orgId, convIds } = request;
        const tabId = sender.tab?.id;
        console.log(`[bg] selected export: ${convIds.length} conversations, concurrency=${FETCH_CONCURRENCY}`);
        const results = await concurrentFetch(orgId, convIds, tabId);
        sendResponse({ success: true, results });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'bulkExport') {
    (async () => {
      try {
        const conversations = await fetchAllConversations(request.orgId);
        const convIds = conversations.map(c => c.uuid);
        const tabId = sender.tab?.id;
        console.log(`[bg] bulk export: ${convIds.length} conversations, concurrency=${FETCH_CONCURRENCY}`);
        const results = await concurrentFetch(request.orgId, convIds, tabId);
        sendResponse({ success: true, results });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
});
