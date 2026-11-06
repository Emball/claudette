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
  // Confirmed via probe 2026-09-04: offset-based, 50/page, no total-count header.
  // Stop condition: page returns fewer than 50 items.
  const PAGE_SIZE = 50;
  const all = [];
  let offset = 0;
  while (true) {
    const page = await apiFetch(
      `/organizations/${orgId}/chat_conversations?limit=${PAGE_SIZE}&offset=${offset}`
    );
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

async function fetchProjects(orgId) {
  return apiFetch(`/organizations/${orgId}/projects`);
}

const MAX_TOOL_INPUT_CHARS = 100000;

// Keep tool input (commands, file contents) so it is searchable; cap oversized fields.
function slimToolInput(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const [key, val] of Object.entries(input)) {
    if (typeof val === 'string') {
      if (val.length > MAX_TOOL_INPUT_CHARS) console.warn(`[bg] tool input '${key}' capped at ${MAX_TOOL_INPUT_CHARS} chars (was ${val.length})`);
      out[key] = val.slice(0, MAX_TOOL_INPUT_CHARS);
    } else if (val !== null && typeof val === 'object') {
      if (JSON.stringify(val).length <= MAX_TOOL_INPUT_CHARS) out[key] = val;
      else console.warn(`[bg] tool input '${key}' dropped (object over ${MAX_TOOL_INPUT_CHARS} chars)`);
    } else if (val !== null && val !== undefined) {
      out[key] = val;
    }
  }
  return out;
}

// Strip a raw API conversation down to only what the library needs.
// Drops: extracted_content blobs, tool_result blocks, thumbnail fields, unused metadata.
// Keeps: text, tool titles and inputs, artifact content, image URL paths (query string stripped — signed params expire).
function slimMessage(msg) {
  const slimContent = (msg.content || []).map(block => {
    if (block.type === 'text')     return { type: 'text', text: block.text || '' };
    if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking || '', summaries: block.summaries || [] };
    if (block.type === 'tool_use') {
      const slim = { type: 'tool_use', name: block.name, title: block.title || block.name };
      const input = slimToolInput(block.input);
      if (input) slim.input = input;
      return slim;
    }
    if (block.type === 'tool_result') return null;
    if (block.type === 'artifact')
      return { type: 'artifact', title: block.title, language: block.language || null, content: block.content || '' };
    if (block.type === 'document')
      return { type: 'document', name: block.name || block.document?.name || null };
    if (block.type === 'context')
      return { type: 'context', body: block.body || block.content || block.text || '' };
    return null;
  }).filter(Boolean);

  const slimAttachment = a => {
    if (!a || a.success === false) return null;
    const rawUrl = a.preview_asset?.url || a.preview_url || null;
    const previewPath = rawUrl ? rawUrl.replace(/\?.*$/, '') : null;
    const slim = {
      file_name:    a.file_name || null,
      file_kind:    a.file_kind || null,
      file_type:    a.file_type || null,
      preview_path: previewPath,
    };
    // Preserve image dimensions for classifier (no blob stored, just metadata)
    if (a.preview_asset?.image_width)  slim.image_width  = a.preview_asset.image_width;
    if (a.preview_asset?.image_height) slim.image_height = a.preview_asset.image_height;
    // Preserve extracted text for non-image attachments (documents, code files, etc.)
    if (a.file_kind !== 'image') {
      const text = a.extracted_content || a.text || a.content || '';
      if (text) slim.extracted_content = text;
    }
    return slim;
  };

  const attachments = [
    ...(msg.attachments || []).map(slimAttachment),
    ...(msg.files       || []).map(slimAttachment),
  ].filter(Boolean);

  return {
    uuid:                msg.uuid,
    sender:              msg.sender,
    parent_message_uuid: msg.parent_message_uuid || null,
    created_at:          msg.created_at,
    content:             slimContent,
    attachments,
  };
}

// Compress a JS value to a base64 string using DEFLATE-raw (best text ratio).
async function compress(value) {
  const json   = JSON.stringify(value);
  const bytes  = new TextEncoder().encode(json);
  const cs     = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const compressed = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  // Chunk the btoa conversion — spreading large typed arrays blows the call stack.
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < compressed.length; i += CHUNK) {
    binary += String.fromCharCode(...compressed.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function decompress(b64) {
  const bytes  = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const ds     = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const out = await new Response(ds.readable).arrayBuffer();
  return JSON.parse(new TextDecoder().decode(out));
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

// --- Library sync ---
// Brings the library for the logged-in account in line with claude.ai: fetches chats that are
// missing or whose updated_at changed, and never deletes archived chats. Runs detached from any
// message channel so closing the popup cannot interrupt it; progress is published to
// chrome.storage.local (sweepStatus). A heartbeat keeps the worker alive, and an interrupted
// sync resumes on the next worker start (see resumeInterruptedSync).

const SWEEP_BATCH = 20;
const SYNC_HEARTBEAT_MS = 20000;
let activeSync = null;

function startSync(reason) {
  if (activeSync) {
    console.log(`[bg] sync (${reason}) requested while one is running — ignored`);
    return false;
  }
  activeSync = syncAccount(reason)
    .catch(err => console.error('[bg] sync crashed:', err))
    .finally(() => { activeSync = null; });
  return true;
}

async function syncAccount(reason) {
  const status = {
    running: true, reason, orgId: null, phase: 'listing',
    done: 0, total: 0, failed: 0, error: null, startedAt: Date.now(), updatedAt: Date.now(),
  };
  const publish = async patch => {
    Object.assign(status, patch, { updatedAt: Date.now() });
    try { await chrome.storage.local.set({ sweepStatus: status }); }
    catch (err) { console.error('[bg] sweepStatus write failed:', err.message); }
  };
  const heartbeat = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
    publish({});
  }, SYNC_HEARTBEAT_MS);

  try {
    console.log(`[bg] sync (${reason}) starting`);
    await publish({});
    const { orgId, email, orgName } = await detectOrgAndAccount();
    status.orgId = orgId;
    const allConvs = await fetchAllConversations(orgId);

    const stored   = await chrome.storage.local.get(['accountRegistry', 'library']);
    const registry = stored.accountRegistry || {};
    const library  = stored.library || {};
    const have     = library[orgId] || (library[orgId] = {});

    if (!registry[orgId]) registry[orgId] = { orgId, email, orgName, firstSeen: Date.now() };
    registry[orgId].email     = email || registry[orgId].email;
    registry[orgId].orgName   = orgName || registry[orgId].orgName;
    registry[orgId].convCount = Object.keys(have).length;

    const meta = {};
    for (const c of allConvs) meta[c.uuid] = c;
    const pending = allConvs
      .filter(c => !have[c.uuid] || (have[c.uuid].updated_at || null) !== (c.updated_at || null))
      .map(c => c.uuid);

    if (pending.length) registry[orgId].sweepDone = false;
    await chrome.storage.local.set({ accountRegistry: registry });

    let done = allConvs.length - pending.length;
    let failed = 0;
    console.log(`[bg] sync ${orgId}: ${allConvs.length} on claude.ai, ${pending.length} new or changed, ${done} up to date`);
    await publish({ orgId, phase: 'fetching', done, total: allConvs.length, failed });

    for (let bStart = 0; bStart < pending.length; bStart += SWEEP_BATCH) {
      const batch = pending.slice(bStart, bStart + SWEEP_BATCH);

      while (estimatedHeapMB() > MEM_CEILING_MB) {
        console.warn(`[bg] sync heap ~${estimatedHeapMB().toFixed(0)}MB — pausing`);
        await delay(1500);
      }

      const batchResults = await Promise.all(
        batch.map(async (convId, bi) => {
          await delay(bi * FETCH_DELAY_MS);
          try {
            return { convId, success: true, data: await fetchConversation(orgId, convId) };
          } catch (err) {
            console.error(`[bg] sync failed ${convId}:`, err.message);
            return { convId, success: false };
          }
        })
      );

      for (const r of batchResults) {
        if (!r.success) { failed++; continue; }
        const c = meta[r.convId] || {};
        const rawMsgs = r.data.chat_messages || r.data.messages || [];
        have[r.convId] = {
          uuid:        r.convId,
          name:        c.name || '',
          created_at:  c.created_at || null,
          updated_at:  c.updated_at || null,
          messages_z:  await compress(rawMsgs.map(slimMessage)),
          fetchedAt:   Date.now(),
        };
        done++;
      }

      try {
        await chrome.storage.local.set({ library });
      } catch (storageErr) {
        console.error('[bg] sync storage write failed (quota?):', storageErr.message);
        throw storageErr;
      }
      await publish({ done, failed });
    }

    const reg2 = (await chrome.storage.local.get('accountRegistry')).accountRegistry || registry;
    if (!reg2[orgId]) reg2[orgId] = registry[orgId];
    reg2[orgId].sweepDone        = failed === 0;
    reg2[orgId].sweepCompletedAt = Date.now();
    reg2[orgId].convCount        = Object.keys(have).length;
    await chrome.storage.local.set({ accountRegistry: reg2 });

    console.log(`[bg] sync ${orgId} complete: ${done} stored, ${failed} failed`);
    await publish({ running: false, phase: 'done', done, failed });
  } catch (err) {
    console.error('[bg] sync error:', err);
    await publish({ running: false, phase: 'error', error: err.message });
  } finally {
    clearInterval(heartbeat);
  }
}

// A worker that was killed mid-sync leaves sweepStatus.running set. Whenever the worker
// starts again (browser start, popup open, any message), pick the sync back up.
async function resumeInterruptedSync() {
  const { sweepStatus } = await chrome.storage.local.get('sweepStatus');
  if (sweepStatus && sweepStatus.running && !activeSync) {
    console.log('[bg] resuming interrupted sync');
    startSync('resume');
  }
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
    const started = startSync(request.auto ? 'auto' : 'manual');
    sendResponse({ success: true, started, alreadyRunning: !started });
    return false;
  }

  // Returns all library conversations decompressed, ready for exportBulk in content script.
  if (request.action === 'exportLibrary') {
    (async () => {
      try {
        const stored = await chrome.storage.local.get(['library', 'accountRegistry']);
        const library  = stored.library  || {};
        const registry = stored.accountRegistry || {};

        const results = [];
        for (const [orgId, convMap] of Object.entries(library)) {
          const acct = registry[orgId] || { orgId };
          for (const conv of Object.values(convMap)) {
            let messages = [];
            if (conv.messages_z) {
              try { messages = await decompress(conv.messages_z); } catch (_) {}
            }
            // Reconstruct a conv shape compatible with exportBulk / conversationToText
            results.push({
              success: true,
              data: {
                uuid:          conv.uuid,
                name:          conv.name || conv.uuid,
                created_at:    conv.created_at || null,
                updated_at:    conv.updated_at || null,
                chat_messages: messages,
                // No current_leaf_message_uuid stored — exporter falls back to flat order
                _accountEmail: acct.email || null,
                _accountName:  acct.orgName || null,
                _orgId:        orgId,
              },
            });
          }
        }

        // Sort by created_at ascending so the ZIP is in chronological order
        results.sort((a, b) => {
          const ta = a.data.created_at || '';
          const tb = b.data.created_at || '';
          return ta < tb ? -1 : ta > tb ? 1 : 0;
        });

        sendResponse({ success: true, results, total: results.length });
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
    if (activeSync) {
      sendResponse({ success: false, error: 'A sync is running — try again when it finishes' });
      return false;
    }
    (async () => {
      try {
        const { orgId } = request;
        if (orgId) {
          const stored = await chrome.storage.local.get(['library', 'accountRegistry']);
          const lib = stored.library || {};
          const reg = stored.accountRegistry || {};
          delete lib[orgId];
          if (reg[orgId]) { reg[orgId].sweepDone = false; delete reg[orgId].sweepCompletedAt; }
          await chrome.storage.local.set({ library: lib, accountRegistry: reg });
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

resumeInterruptedSync();
chrome.runtime.onStartup.addListener(resumeInterruptedSync);
