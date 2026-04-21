// popup.js — Flow Recorder popup (redesigned)

// --- Inline utilities (no require() in MV3) ---

function extractVariables(steps) {
  const found = new Set();
  for (const step of steps) {
    for (const val of Object.values(step)) {
      if (typeof val === 'string') {
        for (const m of val.matchAll(/\{\{(\w+)\}\}/g)) found.add(m[1]);
      }
    }
  }
  return [...found];
}

function buildFlow(name, domain, steps, description = '') {
  const varNames = extractVariables(steps);
  const variables = {};
  for (const v of varNames) variables[v] = { source: 'user', description: '' };
  const url = steps.find(s => s.action === 'navigate')?.url || '';
  const domainFromUrl = url ? (() => { try { return new URL(url).hostname; } catch { return domain; } })() : domain;
  return { name, domain: domainFromUrl || domain, description, version: 1, steps, variables };
}

function validateFlow(flow) {
  const errors = [];
  if (!flow.name || !flow.name.trim()) errors.push('Flow name is required.');
  if (!flow.domain || !flow.domain.trim()) errors.push('Flow domain is required.');
  if (!flow.steps || flow.steps.length === 0) {
    errors.push('Flow must have at least one step.');
  } else {
    const used = extractVariables(flow.steps);
    const declared = Object.keys(flow.variables || {});
    for (const v of used) {
      if (!declared.includes(v)) errors.push(`Variable "{{${v}}}" used but not declared.`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// --- State ---

const state = {
  view: 'browser',      // 'browser' | 'recording'
  flows: {},            // { domain: [name, ...] }
  selectedDomain: null,
  selectedName: null,
  currentFlow: null,    // full flow JSON for selected flow
  expandedDomains: new Set(),
  varValues: {},        // { varName: value } for current flow
  recordedSteps: [],
  originalValues: new Map(),
  isRecording: false,
  runStepCount: 0,
  selectSeq: 0,
  isRunning: false,
  varInputOpenIdx: null,
};

let saveVarValuesTimer = null;

// --- Background message helpers ---

function bgSend(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || { ok: false, error: 'No response' });
    });
  });
}

// --- DOM refs ---

const flowTree = document.getElementById('flow-tree');
const detailEmpty = document.getElementById('detail-empty');
const detailFlow = document.getElementById('detail-flow');
const recordingPanel = document.getElementById('recording-panel');
const flowNameDisplay = document.getElementById('flow-name-display');
const flowMeta = document.getElementById('flow-meta');
const stepList = document.getElementById('step-list');
const variablesPanel = document.getElementById('variables-panel');
const varRows = document.getElementById('var-rows');
const btnRun = document.getElementById('btn-run');
const btnStopRun = document.getElementById('btn-stop-run');
const btnDeleteFlow = document.getElementById('btn-delete-flow');
const runStatus = document.getElementById('run-status');
const btnRecord = document.getElementById('btn-record');
const btnBack = document.getElementById('btn-back');
const recordingStatus = document.getElementById('recording-status');
const recordingStepList = document.getElementById('recording-step-list');
const saveSection = document.getElementById('save-section');
const flowNameInput = document.getElementById('flow-name-input');
const btnSave = document.getElementById('btn-save');
const saveStatus = document.getElementById('save-status');
const flowDescInput = document.getElementById('flow-desc-input');
const btnStartRec = document.getElementById('btn-start-rec');
const btnStopRec = document.getElementById('btn-stop-rec');

// --- View switching ---

function showView(view) {
  state.view = view;
  const isRecording = view === 'recording';

  detailEmpty.style.display = 'none';
  detailFlow.style.display = 'none';
  recordingPanel.style.display = 'none';
  btnRecord.disabled = isRecording;

  if (isRecording) {
    recordingPanel.style.display = 'flex';
  } else if (state.currentFlow) {
    detailFlow.style.display = 'flex';
  } else {
    detailEmpty.style.display = 'flex';
  }
}

// --- Sidebar ---

async function loadFlows() {
  const result = await bgSend({ type: 'LIST_FLOWS' });
  if (!result.ok) { state.flows = {}; }
  else { state.flows = result.flows || {}; }
  renderSidebar();
}

function renderSidebar() {
  flowTree.innerHTML = '';
  const domains = Object.keys(state.flows).sort();
  if (domains.length === 0) {
    flowTree.innerHTML = '<div style="padding:8px 10px;color:#45475a;font-size:10px">No flows yet.<br>Click ● New Recording.</div>';
    return;
  }
  for (const domain of domains) {
    if (!state.expandedDomains.has(domain)) state.expandedDomains.add(domain); // expand by default

    const group = document.createElement('div');
    group.className = 'domain-group' + (state.expandedDomains.has(domain) ? '' : ' collapsed');

    const label = document.createElement('div');
    label.className = 'domain-label';
    const arrow = document.createElement('span');
    arrow.className = 'domain-arrow';
    arrow.textContent = '▼';
    const domainText = document.createElement('span');
    domainText.textContent = domain;
    label.appendChild(arrow);
    label.appendChild(domainText);
    label.addEventListener('click', () => {
      if (state.expandedDomains.has(domain)) state.expandedDomains.delete(domain);
      else state.expandedDomains.add(domain);
      renderSidebar();
    });
    group.appendChild(label);

    const list = document.createElement('div');
    list.className = 'flow-list';
    const flowItems = state.flows[domain]; // [{name, description, variables}]
    for (const flowItem of flowItems) {
      const item = document.createElement('div');
      item.className = 'flow-item' + (state.selectedDomain === domain && state.selectedName === flowItem.name ? ' selected' : '');
      item.textContent = flowItem.name;
      item.title = flowItem.name;
      item.addEventListener('click', () => selectFlow(domain, flowItem.name));
      list.appendChild(item);
    }
    group.appendChild(list);
    flowTree.appendChild(group);
  }
}

// --- Flow detail ---

async function selectFlow(domain, name) {
  if (state.isRunning) return; // don't switch flow mid-run
  state.selectedDomain = domain;
  state.selectedName = name;
  renderSidebar();

  const seq = ++state.selectSeq;
  const result = await bgSend({ type: 'READ_FLOW', domain, name });
  if (seq !== state.selectSeq) return; // superseded by a newer click

  if (!result.ok) {
    state.currentFlow = null;
    showView('browser');
    return;
  }
  state.currentFlow = result.flow;

  // Restore saved variable values from local storage
  chrome.storage.local.get('varValues', ({ varValues }) => {
    if (seq !== state.selectSeq) return; // superseded
    const saved = (varValues || {})[`${domain}/${name}`] || {};
    state.varValues = saved;
    renderDetail();
    showView('browser');
  });
}

function renderDetail() {
  const flow = state.currentFlow;
  if (!flow) return;

  flowNameDisplay.textContent = flow.name;
  const varCount = Object.keys(flow.variables || {}).length;
  flowMeta.textContent = `${flow.domain} · ${flow.steps.length} steps${varCount ? ` · ${varCount} variable${varCount > 1 ? 's' : ''}` : ''}`;

  const descEl = document.getElementById('flow-description');
  descEl.innerHTML = '';
  if (flow.description) {
    descEl.textContent = flow.description;
    descEl.classList.remove('empty');
  } else {
    descEl.textContent = 'Add a description…';
    descEl.classList.add('empty');
  }
  descEl.onclick = () => startEditDescription();

  renderDetailSteps(flow.steps, null);
  renderVariableInputs(flow);
  updateRunButton();
}

function startEditDescription() {
  const flow = state.currentFlow;
  if (!flow) return;
  const descEl = document.getElementById('flow-description');
  const original = flow.description || '';
  descEl.onclick = null;
  descEl.innerHTML = '';
  const ta = document.createElement('textarea');
  ta.className = 'flow-desc-edit';
  ta.value = original;
  ta.rows = 2;
  descEl.appendChild(ta);
  ta.focus();
  ta.select();

  async function commit() {
    const newDesc = ta.value.trim();
    if (newDesc === original) { renderDetail(); return; }
    const updatedFlow = { ...flow, description: newDesc };
    const result = await bgSend({
      type: 'SAVE_FLOW',
      domain: state.selectedDomain,
      name: state.selectedName,
      flow: updatedFlow,
    });
    if (result.ok) state.currentFlow = updatedFlow;
    renderDetail();
  }

  ta.addEventListener('blur', commit);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); }
    if (e.key === 'Escape') { ta.value = original; ta.blur(); }
  });
}

function renderDetailSteps(steps, runningIdx) {
  stepList.innerHTML = '';
  steps.forEach((step, i) => {
    const card = document.createElement('div');
    card.className = `step-card action-${step.action}`;
    if (runningIdx !== null) {
      if (i < runningIdx) card.classList.add('step-done');
      else if (i === runningIdx) card.classList.add('step-running');
      else card.classList.add('step-pending');
    }

    const action = document.createElement('div');
    action.className = 'step-action';
    action.textContent = step.action;

    const statusSpan = document.createElement('span');
    statusSpan.className = 'step-status';
    if (runningIdx !== null) {
      if (i < runningIdx) statusSpan.textContent = '✓';
      else if (i === runningIdx) statusSpan.textContent = '⟳';
    }
    action.appendChild(statusSpan);

    const desc = document.createElement('div');
    desc.className = 'step-desc';
    // Use textContent for XSS safety — values come from user-recorded flows
    if (step.url) desc.textContent = step.url;
    else if (step.selector && step.value) desc.textContent = `${step.selector} = ${step.value}`;
    else if (step.selector) desc.textContent = step.selector;
    else if (step.ms) desc.textContent = `${step.ms}ms`;

    card.appendChild(action);
    card.appendChild(desc);
    stepList.appendChild(card);
  });
}

function renderVariableInputs(flow) {
  const varNames = Object.keys(flow.variables || {});
  if (varNames.length === 0) {
    variablesPanel.style.display = 'none';
    return;
  }
  variablesPanel.style.display = 'block';
  varRows.innerHTML = '';
  for (const name of varNames) {
    const row = document.createElement('div');
    row.className = 'var-row';
    const label = document.createElement('span');
    label.className = 'var-name';
    label.textContent = `{{${name}}}`;
    const input = document.createElement('input');
    input.className = 'var-input';
    input.placeholder = 'value...';
    input.value = state.varValues[name] || '';
    input.addEventListener('input', () => {
      state.varValues[name] = input.value;
      saveVarValues();
      updateRunButton();
    });
    row.appendChild(label);
    row.appendChild(input);
    varRows.appendChild(row);
  }
}

function saveVarValues() {
  clearTimeout(saveVarValuesTimer);
  saveVarValuesTimer = setTimeout(() => {
    const key = `${state.selectedDomain}/${state.selectedName}`;
    chrome.storage.local.get('varValues', ({ varValues }) => {
      const all = varValues || {};
      all[key] = state.varValues;
      chrome.storage.local.set({ varValues: all });
    });
  }, 300);
}

function updateRunButton() {
  if (!state.currentFlow) { btnRun.disabled = true; return; }
  const varNames = Object.keys(state.currentFlow.variables || {});
  const allFilled = varNames.every(v => (state.varValues[v] || '').trim() !== '');
  btnRun.disabled = !allFilled;
}

// --- Run flow ---

function substituteVars(steps, vars) {
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

btnRun.addEventListener('click', async () => {
  if (!state.currentFlow) return;
  const steps = substituteVars(state.currentFlow.steps, state.varValues);
  state.runStepCount = steps.length;

  btnRun.style.display = 'none';
  btnStopRun.style.display = 'flex';
  btnRecord.disabled = true;
  runStatus.textContent = '● Running...';
  runStatus.style.color = '#a6e3a1';
  renderDetailSteps(steps, 0);

  const ack = await bgSend({ type: 'RUN_FLOW', steps });
  if (!ack.ok) {
    finishRun(`Error: ${ack.error}`, '#f38ba8');
    return;
  }
  state.isRunning = true;
});

btnStopRun.addEventListener('click', () => {
  bgSend({ type: 'STOP_RUN' });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'RUN_PROGRESS') return;

  const flow = state.currentFlow;
  if (!flow) return;
  const steps = substituteVars(flow.steps, state.varValues);

  if (msg.status === 'running') {
    renderDetailSteps(steps, msg.stepIndex);
    runStatus.textContent = `● Step ${msg.stepIndex + 1} / ${state.runStepCount}`;
    runStatus.style.color = '#f9e2af';
  } else if (msg.status === 'done') {
    renderDetailSteps(steps, steps.length);
    finishRun('✓ Done', '#a6e3a1');
  } else if (msg.status === 'error') {
    finishRun(`✗ Step ${msg.stepIndex + 1} failed: ${msg.error}`, '#f38ba8');
  } else if (msg.status === 'stopped') {
    finishRun('Stopped', '#6c7086');
  }
});

function finishRun(message, color) {
  state.isRunning = false;
  btnRun.style.display = 'flex';
  btnStopRun.style.display = 'none';
  btnRecord.disabled = false;
  runStatus.textContent = message;
  runStatus.style.color = color;
  showView('browser');
}

// --- Delete flow ---

btnDeleteFlow.addEventListener('click', async () => {
  if (!state.selectedDomain || !state.selectedName) return;
  if (!confirm(`Delete "${state.selectedName}"?`)) return;
  const result = await bgSend({ type: 'DELETE_FLOW', domain: state.selectedDomain, name: state.selectedName });
  if (result.ok) {
    state.selectedDomain = null;
    state.selectedName = null;
    state.currentFlow = null;
    await loadFlows();
    showView('browser');
  }
});

// --- Recording view ---

btnRecord.addEventListener('click', () => {
  state.recordedSteps = [];
  state.originalValues.clear();
  state.varInputOpenIdx = null;
  renderRecordingSteps([]);
  saveSection.style.display = 'none';
  saveStatus.textContent = '';
  flowNameInput.value = '';
  flowDescInput.value = '';
  recordingStatus.textContent = 'Not recording';
  recordingStatus.className = '';
  btnStartRec.disabled = false;
  btnStopRec.disabled = true;
  showView('recording');
});

btnBack.addEventListener('click', () => {
  if (state.isRecording) {
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
    state.isRecording = false;
  }
  showView('browser');
});

btnStartRec.addEventListener('click', () => {
  state.recordedSteps = [];
  state.originalValues.clear();
  state.varInputOpenIdx = null;
  renderRecordingSteps([]);
  saveSection.style.display = 'none';
  chrome.runtime.sendMessage({ type: 'START_RECORDING' }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) {
      recordingStatus.textContent = res?.error || 'Failed to start';
      return;
    }
    state.isRecording = true;
    recordingStatus.textContent = '● Recording…';
    recordingStatus.className = 'active';
    btnStartRec.disabled = true;
    btnStopRec.disabled = false;
  });
});

btnStopRec.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    state.isRecording = false;
    state.recordedSteps = res.steps || [];
    state.originalValues.clear();
    recordingStatus.textContent = `Recorded ${state.recordedSteps.length} steps`;
    recordingStatus.className = '';
    btnStartRec.disabled = false;
    btnStopRec.disabled = true;
    renderRecordingSteps(state.recordedSteps);
    if (state.recordedSteps.length > 0) saveSection.style.display = 'block';
  });
});

// Recording step list (with var toggle)

function renderRecordingSteps(steps) {
  recordingStepList.innerHTML = '';
  steps.forEach((step, i) => {
    const div = document.createElement('div');
    div.className = 'recording-step';
    const label = document.createElement('span');
    label.className = 'recording-step-label';
    label.textContent = `${i + 1}. ${step.action}${step.selector ? ' ' + step.selector : ''}${step.url ? ' → ' + step.url : ''}`;
    div.appendChild(label);

    if (step.action === 'fill' || step.action === 'select') {
      const isVar = typeof step.value === 'string' && /^\{\{\w+\}\}$/.test(step.value);

      if (state.varInputOpenIdx === i) {
        const row = document.createElement('div');
        row.className = 'var-inline-row';
        const prefix = document.createElement('span');
        prefix.className = 'var-inline-prefix';
        prefix.textContent = '{{';
        const input = document.createElement('input');
        input.className = 'var-inline-input';
        input.placeholder = 'variable name';
        if (isVar) input.value = step.value.slice(2, -2);
        const suffix = document.createElement('span');
        suffix.className = 'var-inline-suffix';
        suffix.textContent = '}}';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'var-inline-cancel';
        cancelBtn.textContent = '✕';
        cancelBtn.addEventListener('click', () => {
          state.varInputOpenIdx = null;
          renderRecordingSteps(state.recordedSteps);
        });

        function tryCommit() {
          const name = input.value.trim();
          if (name === '') {
            if (isVar) {
              state.recordedSteps[i] = { ...step, value: state.originalValues.get(i) ?? '' };
              state.originalValues.delete(i);
            }
            state.varInputOpenIdx = null;
            renderRecordingSteps(state.recordedSteps);
            return;
          }
          if (!/^[A-Za-z_]\w*$/.test(name)) {
            input.classList.add('input-error');
            setTimeout(() => input.classList.remove('input-error'), 600);
            return;
          }
          if (!isVar) state.originalValues.set(i, step.value);
          state.recordedSteps[i] = { ...step, value: `{{${name}}}` };
          state.varInputOpenIdx = null;
          renderRecordingSteps(state.recordedSteps);
        }

        input.addEventListener('blur', tryCommit);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
          if (e.key === 'Escape') { state.varInputOpenIdx = null; renderRecordingSteps(state.recordedSteps); }
        });

        row.appendChild(prefix);
        row.appendChild(input);
        row.appendChild(suffix);
        row.appendChild(cancelBtn);
        recordingStepList.appendChild(div);
        recordingStepList.appendChild(row);
        setTimeout(() => { input.focus(); if (isVar) input.select(); }, 0);
        return;
      }

      const btn = document.createElement('button');
      btn.className = 'var-toggle' + (isVar ? ' active' : '');
      btn.textContent = isVar ? `🤖 ${step.value}` : '🤖 var';
      btn.addEventListener('click', () => toggleRecordingVar(i));
      div.appendChild(btn);
    }

    recordingStepList.appendChild(div);
  });
}

function toggleRecordingVar(index) {
  state.varInputOpenIdx = state.varInputOpenIdx === index ? null : index;
  renderRecordingSteps(state.recordedSteps);
}

// Live step updates during recording
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || state.view !== 'recording') return;
  if (changes.steps) {
    state.recordedSteps = changes.steps.newValue || [];
    state.originalValues.clear();
    renderRecordingSteps(state.recordedSteps);
  }
  if (changes.recording) {
    const rec = Boolean(changes.recording.newValue);
    if (rec) {
      recordingStatus.textContent = '● Recording…';
      recordingStatus.className = 'active';
    }
  }
});

// Save flow via native host
btnSave.addEventListener('click', async () => {
  const name = flowNameInput.value.trim();
  if (!name) { flowNameInput.style.borderColor = '#f38ba8'; flowNameInput.focus(); return; }
  flowNameInput.style.borderColor = '';

  const flow = buildFlow(name, '', state.recordedSteps, flowDescInput.value.trim());
  const validation = validateFlow(flow);
  if (!validation.ok) { saveStatus.textContent = validation.errors[0]; saveStatus.style.color = '#f38ba8'; return; }

  btnSave.disabled = true;
  saveStatus.textContent = 'Saving...';
  saveStatus.style.color = '#6c7086';

  const result = await bgSend({ type: 'SAVE_FLOW', domain: flow.domain, name: flow.name, flow });
  btnSave.disabled = false;

  if (!result.ok) {
    saveStatus.textContent = `Error: ${result.error}`;
    saveStatus.style.color = '#f38ba8';
    return;
  }

  saveStatus.textContent = `✓ Saved to ~/.flows/${flow.domain}/`;
  saveStatus.style.color = '#a6e3a1';
  await loadFlows();
  // Switch back to browser view and select the saved flow after a brief delay
  setTimeout(async () => {
    showView('browser');
    await selectFlow(flow.domain, flow.name);
  }, 800);
});

// GET_STATE for recording sync — restore recording view if background is still recording
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
  if (chrome.runtime.lastError || !res) return;
  if (res.recording) {
    state.isRecording = true;
    state.recordedSteps = res.steps || [];
    state.originalValues.clear();
    renderRecordingSteps(state.recordedSteps);
    recordingStatus.textContent = '● Recording…';
    recordingStatus.className = 'active';
    btnStartRec.disabled = true;
    btnStopRec.disabled = false;
    saveSection.style.display = 'none';
    saveStatus.textContent = '';
    flowNameInput.value = '';
    showView('recording');
  }
});

// --- Agent Bridge ---

const bridgeBtn = document.getElementById('bridge-btn');
const bridgeStatus = document.getElementById('bridge-status');
let bridgeEnabled = false;
let bridgeStatusInterval = null;

function updateBridgeUI() {
  if (bridgeEnabled) {
    bridgeBtn.textContent = '● ON';
    bridgeBtn.className = 'on';
    if (!bridgeStatusInterval) {
      checkBridgeStatus();
      bridgeStatusInterval = setInterval(checkBridgeStatus, 1500);
    }
  } else {
    bridgeBtn.textContent = '○ OFF';
    bridgeBtn.className = '';
    clearInterval(bridgeStatusInterval);
    bridgeStatusInterval = null;
    bridgeStatus.textContent = '';
    bridgeStatus.className = '';
  }
}

async function checkBridgeStatus() {
  try {
    const res = await fetch('http://localhost:9999/status');
    const { connected } = await res.json();
    bridgeStatus.textContent = connected ? '● Connected' : '○ Server running';
    bridgeStatus.className = connected ? 'connected' : '';
  } catch (_) {
    bridgeStatus.textContent = 'No server on :9999';
    bridgeStatus.className = '';
  }
}

bridgeBtn.addEventListener('click', () => {
  const type = bridgeEnabled ? 'BRIDGE_OFF' : 'BRIDGE_ON';
  bgSend({ type }).then((res) => {
    if (res?.ok) {
      bridgeEnabled = !bridgeEnabled;
      updateBridgeUI();
    } else if (res?.error) {
      bridgeStatus.textContent = res.error;
      bridgeStatus.className = '';
    }
  });
});

bgSend({ type: 'GET_BRIDGE_STATE' }).then((res) => {
  bridgeEnabled = res?.bridgeEnabled || false;
  updateBridgeUI();
});

// --- Init ---

loadFlows();
showView('browser');
