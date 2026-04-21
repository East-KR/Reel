// Flow Recorder background service worker

const DEFAULT_STATE = {
  recording: false,
  recordingTabId: null,
  steps: [],
  bridgeEnabled: false,
  flowsGroupId: null
};

// In-memory steps array — authoritative source during a recording session.
// Avoids the read-modify-write race in chrome.storage.session.
let memSteps = [];

// In-memory cache of the Flows tab group ID (session storage is source of truth)
let flowsGroupId = null;
let recordingTabId = null;
let recorderStateLoadPromise = null;

// Keep-alive: hold references to port connections from Flows tabs
const keepalivePorts = new Set();

// --- Flow Storage (chrome.storage.local) ---

async function flowList() {
  const { flows } = await chrome.storage.local.get('flows');
  const data = flows || {};
  const result = {};
  for (const [domain, byName] of Object.entries(data)) {
    result[domain] = Object.values(byName).map(({ name, description, variables }) => ({
      name,
      description: description || '',
      variables: variables || {},
    }));
  }
  return { ok: true, flows: result };
}

async function flowRead(domain, name) {
  const { flows } = await chrome.storage.local.get('flows');
  const flow = (flows || {})[domain]?.[name];
  if (!flow) return { ok: false, error: `Flow not found: ${domain}/${name}` };
  return { ok: true, flow };
}

async function flowSave(domain, name, flow) {
  const { flows } = await chrome.storage.local.get('flows');
  const data = flows || {};
  if (!data[domain]) data[domain] = {};
  data[domain][name] = flow;
  await chrome.storage.local.set({ flows: data });
  return { ok: true };
}

async function flowDelete(domain, name) {
  const { flows } = await chrome.storage.local.get('flows');
  const data = flows || {};
  if (data[domain]) {
    delete data[domain][name];
    if (Object.keys(data[domain]).length === 0) delete data[domain];
  }
  await chrome.storage.local.set({ flows: data });
  return { ok: true };
}

async function varsSave(domain, name, vars) {
  const { varValues } = await chrome.storage.local.get('varValues');
  const data = varValues || {};
  data[`${domain}/${name}`] = vars;
  await chrome.storage.local.set({ varValues: data });
  return { ok: true };
}

async function varsLoad(domain, name) {
  const { varValues } = await chrome.storage.local.get('varValues');
  const vars = (varValues || {})[`${domain}/${name}`] || {};
  return { ok: true, vars };
}

let runAbortFlag = false;
let runActive = false;

// Send EXECUTE_CMD to a specific frame. Returns { ok, ... } or { ok: false, error }.
function sendToFrame(tabId, frameId, step) {
  return new Promise((resolve) => {
    const opts = { frameId };
    chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_CMD', cmd: step }, opts, (result) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(result || { ok: false, error: 'No response from content script' });
      }
    });
  });
}

async function executeStepOnTab(tabId, step) {
  // 1. Try main frame first
  let result = await sendToFrame(tabId, 0, step);

  if (!result.ok && result.error && result.error.includes('Receiving end does not exist')) {
    // Content script missing in main frame — inject and retry
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content-script.js'] });
      await new Promise(r => setTimeout(r, 150));
      result = await sendToFrame(tabId, 0, step);
    } catch (e) {
      result = { ok: false, error: `Inject failed: ${e.message}` };
    }
  }

  // 2. If element not found in main frame, try every sub-frame.
  //    This handles pages where the compose/editor area lives in an iframe
  //    (e.g. Naver Mail, Gmail legacy).
  if (!result.ok && result.error && result.error.startsWith('Element not found')) {
    let frames = [];
    try {
      const injections = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => null
      });
      frames = injections.filter(f => f.frameId !== 0);
    } catch (_) {}

    for (const frame of frames) {
      const fr = await sendToFrame(tabId, frame.frameId, step);
      if (fr.ok) return fr;
    }
  }

  return result;
}

function waitForTabLoad(tabId, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let resolved = false;
    let seenLoading = false;

    function done() {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    const timer = setTimeout(done, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'loading') seenLoading = true;
      if (changeInfo.status === 'complete' && seenLoading) done();
    }
    chrome.tabs.onUpdated.addListener(listener);

    // Race condition guard: navigation may have already started before the listener
    // was attached. Check the current tab status and seed seenLoading if needed.
    chrome.tabs.get(tabId).then((tab) => {
      if (resolved) return;
      if (tab.status === 'loading') seenLoading = true;
      else if (tab.status === 'complete' && seenLoading) done();
    }).catch(() => {});
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'flows-keepalive') return;
  keepalivePorts.add(port);
  port.onDisconnect.addListener(() => keepalivePorts.delete(port));
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.set(DEFAULT_STATE);
  chrome.contextMenus.create({
    id: 'mark-as-variable',
    title: 'Mark as {{variable}}',
    contexts: ['editable']
  });
});

async function ensureRecorderStateLoaded() {
  if (!recorderStateLoadPromise) {
    recorderStateLoadPromise = chrome.storage.session
      .get(['steps', 'flowsGroupId', 'recordingTabId'])
      .then(({ steps, flowsGroupId: savedGroupId, recordingTabId: savedTabId }) => {
        memSteps = Array.isArray(steps) ? steps : [];
        flowsGroupId = savedGroupId ?? null;
        recordingTabId = savedTabId ?? null;
      })
      .catch(() => {
        memSteps = [];
        flowsGroupId = null;
        recordingTabId = null;
      });
  }
  await recorderStateLoadPromise;
}

async function sendMessageToTab(tabId, msg) {
  if (tabId == null) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (_) {
    return null;
  }
}

async function persistSteps() {
  await chrome.storage.session.set({ steps: memSteps });
}

async function updateLastRecordedValue(selector, value) {
  await ensureRecorderStateLoaded();
  for (let i = memSteps.length - 1; i >= 0; i--) {
    const step = memSteps[i];
    if ((step.action === 'fill' || step.action === 'select') && step.selector === selector) {
      step.value = value;
      await persistSteps();
      return { ok: true };
    }
  }
  return { ok: false, error: `No recorded editable step found for ${selector}` };
}

// --- Flows tab group management ---

async function injectKeepalive(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (window.__flowsKeepalivePort) return;
        window.__flowsKeepalivePort = chrome.runtime.connect({ name: 'flows-keepalive' });
        window.__flowsKeepalivePort.onDisconnect.addListener(() => {
          delete window.__flowsKeepalivePort;
        });
      }
    });
  } catch (_) {
    // Restricted tab (e.g. chrome://) — alarms serve as backup keep-alive
  }
}

async function createOrGetFlowsGroup(tabId) {
  // Re-use existing group if still valid
  if (flowsGroupId !== null) {
    try {
      await chrome.tabGroups.get(flowsGroupId);
      await chrome.tabs.group({ tabIds: [tabId], groupId: flowsGroupId });
      await chrome.storage.session.set({ flowsGroupId });
      await injectKeepalive(tabId);
      return;
    } catch (_) {
      // Group was deleted externally — fall through to create new one
      flowsGroupId = null;
    }
  }

  // Create new group with current tab
  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  await chrome.tabGroups.update(groupId, { title: 'Flows', color: 'blue' });
  flowsGroupId = groupId;
  await chrome.storage.session.set({ flowsGroupId: groupId });
  await injectKeepalive(tabId);
}

async function dissolveFlowsGroup() {
  if (flowsGroupId === null) return;
  try {
    const tabs = await chrome.tabs.query({ groupId: flowsGroupId });
    if (tabs.length > 0) {
      await chrome.tabs.ungroup(tabs.map(t => t.id));
    }
  } catch (_) {
    // Group may already be gone
  }
  flowsGroupId = null;
  await chrome.storage.session.set({ flowsGroupId: null });
}

// --- Bridge polling ---

let bridgePollTimer = null;

function substituteStepVars(steps, vars) {
  return steps.map(step => {
    const s = { ...step };
    for (const [k, v] of Object.entries(s)) {
      if (typeof v === 'string') {
        s[k] = v.replace(/\{\{(\w+)\}\}/g, (_, name) => vars[name] ?? `{{${name}}}`);
      }
    }
    return s;
  });
}

async function postResult(result) {
  try {
    await fetch('http://localhost:9999/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result)
    });
  } catch (_) {
    // server not running — ignore
  }
}

async function pollBridge() {
  try {
    const res = await fetch('http://localhost:9999/next-cmd');
    if (res.status === 204) return; // no command queued
    const cmd = await res.json();

    // save_flow: write to local storage directly — no tab needed
    if (cmd.action === 'save_flow') {
      if (!cmd.domain || !cmd.name || !cmd.flow) {
        await postResult({ id: cmd.id, ok: false, error: 'save_flow requires domain, name, and flow' });
        return;
      }
      const result = await flowSave(cmd.domain, cmd.name, cmd.flow);
      await postResult({ id: cmd.id, ...result });
      return;
    }

    if (cmd.action === 'list_flows') {
      const result = await flowList();
      await postResult({ id: cmd.id, ...result });
      return;
    }

    if (cmd.action === 'run_flow') {
      if (!cmd.domain || !cmd.name) {
        await postResult({ id: cmd.id, ok: false, error: 'run_flow requires domain and name' });
        return;
      }

      const readResult = await flowRead(cmd.domain, cmd.name);
      if (!readResult.ok) {
        await postResult({ id: cmd.id, ok: false, error: readResult.error || 'Flow not found' });
        return;
      }

      const flow = readResult.flow;
      const savedVars = (await varsLoad(cmd.domain, cmd.name)).vars;
      const vars = { ...savedVars, ...(cmd.vars || {}) };
      const steps = substituteStepVars(flow.steps || [], vars);

      let target = null;
      if (flowsGroupId !== null) {
        const tabs = await chrome.tabs.query({ groupId: flowsGroupId });
        target = tabs.find(t => t.active) || tabs[0] || null;
      }
      if (!target) {
        await postResult({ id: cmd.id, ok: false, error: 'No Flows group tab available' });
        return;
      }

      const stepResults = [];
      let failed = false;
      let activeTabId = target.id;

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (failed) {
          stepResults.push({ stepIndex: i, action: step.action, ok: false, skipped: true });
          continue;
        }

        if (step.selector === '') continue;

        await new Promise(r => setTimeout(r, 300));

        let newTabId = null;
        function onTabCreated(tab) { newTabId = tab.id; }
        if (step.action === 'click') chrome.tabs.onCreated.addListener(onTabCreated);

        const execResult = await executeStepOnTab(activeTabId, step);

        if (step.action === 'click') {
          await new Promise(r => setTimeout(r, 400));
          chrome.tabs.onCreated.removeListener(onTabCreated);
          if (newTabId) {
            await new Promise((resolve) => {
              const poll = () => {
                chrome.tabs.get(newTabId).then((tab) => {
                  if (tab.status === 'complete') resolve();
                  else setTimeout(poll, 100);
                }).catch(resolve);
              };
              poll();
            });
            await new Promise(r => setTimeout(r, 600));
            activeTabId = newTabId;
          }
        }

        const entry = { stepIndex: i, action: step.action };
        if (step.selector) entry.selector = step.selector;

        if (execResult.ok) {
          entry.ok = true;
        } else {
          entry.ok = false;
          entry.error = execResult.error;
          failed = true;
        }
        stepResults.push(entry);

        if (step.action === 'navigate' && execResult.ok) {
          const currentTab = await chrome.tabs.get(activeTabId).catch(() => null);
          const currentUrl = currentTab?.url?.split('#')[0].replace(/\/$/, '');
          const targetUrl = step.url?.split('#')[0].replace(/\/$/, '');
          if (currentUrl && currentUrl === targetUrl) {
            await new Promise(r => setTimeout(r, 600));
          } else {
            await waitForTabLoad(activeTabId);
            await new Promise(r => setTimeout(r, 600));
          }
        }
      }

      // Save vars so they persist for next run
      if (Object.keys(vars).length > 0) {
        await varsSave(cmd.domain, cmd.name, vars);
      }

      // ok:true means the command was processed; step-level failures are in results[].ok
      await postResult({ id: cmd.id, ok: true, results: stepResults });
      return;
    }

    if (cmd.action === 'get_vars') {
      if (!cmd.domain || !cmd.name) {
        await postResult({ id: cmd.id, ok: false, error: 'get_vars requires domain and name' });
        return;
      }
      const result = await varsLoad(cmd.domain, cmd.name);
      await postResult({ id: cmd.id, ...result });
      return;
    }

    if (cmd.action === 'save_vars') {
      if (!cmd.domain || !cmd.name || !cmd.vars) {
        await postResult({ id: cmd.id, ok: false, error: 'save_vars requires domain, name, and vars' });
        return;
      }
      const result = await varsSave(cmd.domain, cmd.name, cmd.vars);
      await postResult({ id: cmd.id, ...result });
      return;
    }

    // Target the active tab inside the Flows group, or fall back to first tab in group
    let target = null;
    if (flowsGroupId !== null) {
      const tabs = await chrome.tabs.query({ groupId: flowsGroupId });
      target = tabs.find(t => t.active) || tabs[0] || null;
    }

    if (!target) {
      await postResult({ id: cmd.id, ok: false, error: 'No Flows group tab available' });
      return;
    }

    // scan_page: forward to content-script via executeStepOnTab (handles injection retry)
    if (cmd.action === 'scan_page') {
      const result = await executeStepOnTab(target.id, { action: 'scan_page' });
      await postResult({ id: cmd.id, ...result });
      return;
    }

    chrome.tabs.sendMessage(target.id, { type: 'EXECUTE_CMD', cmd }, async (result) => {
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message || '';
        if (errMsg.includes('Receiving end does not exist')) {
          // Content script missing (e.g. extension reloaded mid-session) — inject and retry once
          try {
            await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ['src/content-script.js'] });
            await new Promise(r => setTimeout(r, 100));
            chrome.tabs.sendMessage(target.id, { type: 'EXECUTE_CMD', cmd }, async (retryResult) => {
              if (chrome.runtime.lastError) {
                await postResult({ id: cmd.id, ok: false, error: chrome.runtime.lastError.message });
                return;
              }
              await postResult({ id: cmd.id, ...(retryResult || { ok: false, error: 'No response from content script' }) });
            });
          } catch (e) {
            await postResult({ id: cmd.id, ok: false, error: `Content script inject failed: ${e.message}` });
          }
          return;
        }
        await postResult({ id: cmd.id, ok: false, error: errMsg });
        return;
      }
      await postResult({ id: cmd.id, ...(result || { ok: false, error: 'No response from content script' }) });
    });
  } catch (_) {
    // server not running — fail silently, retry next poll
  }
}

function startBridgePolling() {
  if (bridgePollTimer) return;
  bridgePollTimer = setInterval(pollBridge, 500);
}

function stopBridgePolling() {
  if (bridgePollTimer) {
    clearInterval(bridgePollTimer);
    bridgePollTimer = null;
  }
}

// --- Alarms keep-alive ---
// Fires every ~24s (periodInMinutes: 0.4) to restart polling if SW was suspended
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'bridge-keepalive') return;
  chrome.storage.session.get(['bridgeEnabled', 'flowsGroupId']).then(({ bridgeEnabled, flowsGroupId: savedGroupId }) => {
    if (savedGroupId != null) flowsGroupId = savedGroupId;
    if (bridgeEnabled && !bridgePollTimer) startBridgePolling();
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender, sendResponse);
  return true; // keep channel open for async response
});

async function handleMessage(msg, sender, sendResponse) {
  await ensureRecorderStateLoaded();

  if (msg.type === 'START_RECORDING') {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) {
      sendResponse({ ok: false, error: 'No active tab' });
      return;
    }

    recordingTabId = tabs[0].id;
    memSteps = [];
    await chrome.storage.session.set({ recording: true, recordingTabId, steps: [] });
    const started = await sendMessageToTab(recordingTabId, { type: 'START_RECORDING' });
    if (started === null) {
      await chrome.storage.session.set({ recording: false, recordingTabId: null, steps: [] });
      recordingTabId = null;
      sendResponse({ ok: false, error: 'Cannot record on this tab type' });
      return;
    }
    sendResponse({ ok: true });

  } else if (msg.type === 'STOP_RECORDING') {
    await sendMessageToTab(recordingTabId, { type: 'STOP_RECORDING' });
    await chrome.storage.session.set({ recording: false, recordingTabId: null, steps: memSteps });
    recordingTabId = null;
    sendResponse({ ok: true, steps: memSteps });

  } else if (msg.type === 'RECORD_STEP') {
    const step = msg.step;
    // For fill/select, update the last occurrence of the same selector within the
    // current page (stop scanning back at a navigate boundary) instead of appending.
    if ((step.action === 'fill' || step.action === 'select') && step.selector) {
      let updateIdx = -1;
      for (let i = memSteps.length - 1; i >= 0; i--) {
        const s = memSteps[i];
        if (s.action === 'navigate') break;
        if ((s.action === 'fill' || s.action === 'select') && s.selector === step.selector) {
          updateIdx = i;
          break;
        }
      }
      if (updateIdx !== -1) {
        memSteps[updateIdx] = step;
        await persistSteps();
        sendResponse({ ok: true });
        return;
      }
    }
    memSteps.push(step);
    await persistSteps();
    sendResponse({ ok: true });

  } else if (msg.type === 'GET_STATE') {
    const { recording } = await chrome.storage.session.get('recording');
    sendResponse({ recording: Boolean(recording), steps: memSteps });

  } else if (msg.type === 'MARK_VARIABLE_FOR_SELECTOR') {
    const result = await updateLastRecordedValue(msg.selector, `{{${msg.variableName}}}`);
    sendResponse(result);

  } else if (msg.type === 'BRIDGE_ON') {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) {
      sendResponse({ ok: false, error: 'No active tab' });
      return;
    }
    try {
      await createOrGetFlowsGroup(tabs[0].id);
    } catch (e) {
      // Provide a user-friendly message for restricted tab types (chrome://, etc.)
      const msg = e.message && e.message.toLowerCase().includes('cannot')
        ? 'Cannot group this tab type'
        : e.message;
      sendResponse({ ok: false, error: msg });
      return;
    }
    await chrome.storage.session.set({ bridgeEnabled: true });
    startBridgePolling();
    chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.4 });
    sendResponse({ ok: true });

  } else if (msg.type === 'BRIDGE_OFF') {
    await chrome.storage.session.set({ bridgeEnabled: false });
    stopBridgePolling();
    await chrome.alarms.clear('bridge-keepalive');
    await dissolveFlowsGroup();
    sendResponse({ ok: true });

  } else if (msg.type === 'GET_BRIDGE_STATE') {
    const { bridgeEnabled } = await chrome.storage.session.get('bridgeEnabled');
    sendResponse({ bridgeEnabled: bridgeEnabled || false });

  } else if (msg.type === 'LIST_FLOWS') {
    const result = await flowList();
    sendResponse(result);

  } else if (msg.type === 'READ_FLOW') {
    const result = await flowRead(msg.domain, msg.name);
    sendResponse(result);

  } else if (msg.type === 'SAVE_FLOW') {
    const result = await flowSave(msg.domain, msg.name, msg.flow);
    sendResponse(result);

  } else if (msg.type === 'DELETE_FLOW') {
    const result = await flowDelete(msg.domain, msg.name);
    sendResponse(result);

  } else if (msg.type === 'RUN_FLOW') {
    if (!Array.isArray(msg.steps)) {
      sendResponse({ ok: false, error: 'steps must be an array' });
      return;
    }
    if (runActive) {
      sendResponse({ ok: false, error: 'A run is already in progress' });
      return;
    }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) {
      sendResponse({ ok: false, error: 'No active tab' });
      return;
    }
    let activeTabId = tabs[0].id;
    runAbortFlag = false;
    sendResponse({ ok: true });
    runActive = true;

    for (let i = 0; i < msg.steps.length; i++) {
      if (runAbortFlag) {
        chrome.runtime.sendMessage({ type: 'RUN_PROGRESS', status: 'stopped', stepIndex: i }).catch(() => {});
        runActive = false;
        return;
      }
      chrome.runtime.sendMessage({ type: 'RUN_PROGRESS', status: 'running', stepIndex: i }).catch(() => {});

      const step = msg.steps[i];

      // Skip steps with empty selectors (recording artifacts from non-identifiable clicks)
      if (step.selector === '') {
        continue;
      }

      // Small pacing delay between steps so prior DOM changes settle
      await new Promise(r => setTimeout(r, 300));

      // For click steps, watch for a new tab being opened by the click
      let newTabId = null;
      function onTabCreated(tab) { newTabId = tab.id; }
      if (step.action === 'click') chrome.tabs.onCreated.addListener(onTabCreated);

      const result = await executeStepOnTab(activeTabId, step);

      if (step.action === 'click') {
        // Wait briefly for the browser to open a new tab if the click triggers one
        await new Promise(r => setTimeout(r, 400));
        chrome.tabs.onCreated.removeListener(onTabCreated);
        if (newTabId) {
          // Poll tab status directly — avoids waitForTabLoad's seenLoading race
          // condition where the tab finishes loading before the listener attaches.
          await new Promise((resolve) => {
            const poll = () => {
              chrome.tabs.get(newTabId).then((tab) => {
                if (tab.status === 'complete') resolve();
                else setTimeout(poll, 100);
              }).catch(resolve); // tab removed — proceed anyway
            };
            poll();
          });
          await new Promise(r => setTimeout(r, 600));
          activeTabId = newTabId;
        }
      }

      if (!result.ok) {
        chrome.runtime.sendMessage({ type: 'RUN_PROGRESS', status: 'error', stepIndex: i, error: result.error }).catch(() => {});
        runActive = false;
        return;
      }
      if (step.action === 'navigate') {
        // Skip navigate if the tab is already on that URL (e.g. new tab opened by a click)
        const currentTab = await chrome.tabs.get(activeTabId).catch(() => null);
        const currentUrl = currentTab?.url?.split('#')[0].replace(/\/$/, '');
        const targetUrl = step.url?.split('#')[0].replace(/\/$/, '');
        if (currentUrl && currentUrl === targetUrl) {
          // Already there — just wait for page stability, no reload needed
          await new Promise(r => setTimeout(r, 600));
        } else {
          await waitForTabLoad(activeTabId);
          await new Promise(r => setTimeout(r, 600));
        }
      }
    }
    chrome.runtime.sendMessage({ type: 'RUN_PROGRESS', status: 'done', stepIndex: msg.steps.length }).catch(() => {});
    runActive = false;

  } else if (msg.type === 'STOP_RUN') {
    runAbortFlag = true;
    sendResponse({ ok: true });
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ensureRecorderStateLoaded();
  if (tabId !== recordingTabId) return;
  recordingTabId = null;
  await chrome.storage.session.set({ recording: false, recordingTabId: null });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'mark-as-variable') {
    chrome.tabs.sendMessage(tab.id, { type: 'MARK_AS_VARIABLE' }).catch(() => {});
  }
});

// Restore bridge state if it was active before service worker was suspended
chrome.storage.session.get(['bridgeEnabled', 'flowsGroupId']).then(({ bridgeEnabled, flowsGroupId: savedGroupId }) => {
  if (savedGroupId != null) flowsGroupId = savedGroupId;
  if (bridgeEnabled) {
    startBridgePolling();
    // Re-create alarm (alarms do not persist across SW restarts)
    chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.4 });
  }
});
