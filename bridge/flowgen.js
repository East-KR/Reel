#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');

// --- Config ---

const BRIDGE = 'http://127.0.0.1:9999';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

const args = process.argv.slice(2);

function getFlag(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

const goal = getFlag('--goal') || 'Generate e2e test flows for this page';
const model = getFlag('--model') || 'claude-sonnet-4-6';
const journeyMode = args.includes('--journey');
const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  console.error('ANTHROPIC_API_KEY environment variable required');
  process.exit(1);
}

// --- HTTP helpers ---

function httpRequest(url, method, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const bodyStr = body != null ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + (u.search || ''),
        method,
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: null, raw: data });
          }
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function bridgeGet(path) {
  const { status, body, raw } = await httpRequest(`${BRIDGE}${path}`, 'GET', null);
  if (status >= 400) throw new Error(`Bridge error ${status}: ${raw || JSON.stringify(body)}`);
  return body;
}

async function bridgePost(path, body) {
  const { status, body: resBody, raw } = await httpRequest(`${BRIDGE}${path}`, 'POST', body);
  if (status >= 400) throw new Error(`Bridge error ${status}: ${raw || JSON.stringify(resBody)}`);
  return resBody;
}

// Enqueue a command and wait for its result (retries on timeout up to 3x).
async function bridgeCmd(action, extra = {}) {
  const enqueueRes = await bridgePost('/enqueue', { action, ...extra });
  const id = enqueueRes.id;
  if (!id) throw new Error(`/enqueue did not return an id: ${JSON.stringify(enqueueRes)}`);

  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await bridgeGet(`/wait-result/${id}`);
    // bridge returns {id, ok:false, error:'timeout'} if extension didn't respond in 10s
    if (!(result.error === 'timeout')) return result;
    console.log('  Extension slow to respond, retrying...');
  }
  return { ok: false, error: 'timeout after 3 attempts' };
}

// --- Claude API ---

async function callClaude(messages, system) {
  const body = { model, max_tokens: 4096, messages };
  if (system) body.system = system;
  const { status, body: resBody, raw } = await httpRequest(
    ANTHROPIC_API,
    'POST',
    body,
    {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    }
  );
  if (status >= 400) {
    const msg = resBody?.error?.message || raw || `HTTP ${status}`;
    throw new Error(`Claude API error (${status}): ${msg}`);
  }
  const text = resBody?.content?.[0]?.text;
  if (!text) throw new Error(`Unexpected Claude response: ${JSON.stringify(resBody)}`);
  return text;
}

function parseJSON(text, arrayFallback = false) {
  try {
    return JSON.parse(text);
  } catch {
    const pattern = arrayFallback ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
    const match = text.match(pattern);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Could not parse JSON from response:\n${text.slice(0, 300)}`);
  }
}

// --- Single-page mode ---

const SINGLE_PAGE_SYSTEM = `You are a QA engineer generating e2e test flows for a web automation tool.

Given a DOM snapshot of a page (URL, title, interactive elements with CSS selectors), generate test flows as JSON. Each flow tests one coherent user scenario on this page.

Rules:
- First step must always be {"action":"navigate","url":"<page url>"}
- Use exact selector values from the snapshot
- For fill steps with sensitive data (passwords, API keys), use {{variableName}} and declare it in variables
- For select steps, use one of the provided option values
- Flow name: short, descriptive, snake_case
- Generate 1–4 flows depending on how many distinct scenarios the page supports

Return a JSON array of flow objects:
[{
  "name": "...",
  "domain": "...",
  "description": "...",
  "version": 1,
  "steps": [{"action":"...","selector":"...","url":"...","value":"..."}],
  "variables": {"varName":{"source":"user","description":"..."}}
}]

Return only the JSON array. No markdown fences, no explanation.`;

async function singlePageMode(snap) {
  const userMsg = `Goal: ${goal}

Page: ${snap.url}
Title: ${snap.title}

Interactive elements (${snap.elements.length}):
${JSON.stringify(snap.elements, null, 2)}`;

  console.log('Calling Claude API (single-page mode)...');
  const text = await callClaude([{ role: 'user', content: userMsg }], SINGLE_PAGE_SYSTEM);
  return parseJSON(text, true);
}

// --- Multi-page journey mode ---

const JOURNEY_SYSTEM = `You are a QA engineer building an e2e test flow by navigating a web application one step at a time.

You receive the current page state and accumulated steps so far. Respond with exactly one of:
- {"next":{"action":"...","selector":"...","url":"...","value":"..."}} — execute this step next
- {"done":true} — the journey goal is complete

Keep the response minimal. Only JSON. No explanation.`;

async function runJourneyMode(snap) {
  const steps = [];
  let currentSnap = snap;
  let journeyDone = false;

  for (let i = 0; i < 20; i++) {
    const userMsg = `Goal: ${goal}

Current page: ${currentSnap.url}
Title: ${currentSnap.title}

Interactive elements (${currentSnap.elements.length}):
${JSON.stringify(currentSnap.elements, null, 2)}

Steps accumulated so far (${steps.length}):
${JSON.stringify(steps, null, 2)}`;

    console.log(`  Iteration ${i + 1}: asking Claude for next step...`);
    const text = await callClaude([{ role: 'user', content: userMsg }], JOURNEY_SYSTEM);
    const decision = parseJSON(text, false);

    if (decision.done) {
      console.log('  Claude signaled journey complete.');
      journeyDone = true;
      break;
    }

    const step = decision.next;
    if (!step || !step.action) {
      throw new Error(`Unexpected Claude response shape: ${JSON.stringify(decision)}`);
    }

    console.log(`  Executing: ${step.action} ${step.selector || step.url || ''}`);
    const execResult = await bridgeCmd(step.action, step);
    if (!execResult.ok) {
      console.error(`  Step failed: ${execResult.error}. Saving accumulated steps.`);
      break;
    }

    steps.push(step);

    // Re-scan after actions that change the page
    if (step.action === 'navigate' || step.action === 'click') {
      await new Promise((r) => setTimeout(r, 1200)); // let page settle
      const scanResult = await bridgeCmd('scan_page');
      if (scanResult.ok) currentSnap = scanResult;
    }
  }

  if (!journeyDone && steps.length > 0) {
    console.warn('Warning: journey reached 20-iteration limit without completing. Flow may be incomplete.');
  }

  if (steps.length === 0) {
    console.error('No steps accumulated in journey mode.');
    return null;
  }

  const domain = (() => { try { return new URL(snap.url).hostname; } catch { return 'unknown'; } })();
  const flowName = goal.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 50);

  return [{
    name: flowName,
    domain,
    description: goal,
    version: 1,
    steps,
    variables: {},
  }];
}

// --- Main ---

async function main() {
  // 1. Check bridge
  let status;
  try {
    status = await bridgeGet('/status');
  } catch {
    console.error('Bridge server not running on :9999 — start with: node bridge/server.js');
    process.exit(1);
  }

  if (!status.connected) {
    console.error('Extension not connected — open a tab and enable Bridge ON in the extension popup');
    process.exit(1);
  }

  // 2. Scan current page
  console.log('Scanning page...');
  const snap = await bridgeCmd('scan_page');
  if (!snap.ok) {
    console.error(`scan_page failed: ${snap.error}`);
    process.exit(1);
  }

  if (!snap.elements || snap.elements.length === 0) {
    console.warn('No interactive elements found. Nothing to generate.');
    process.exit(0);
  }

  console.log(`Found ${snap.elements.length} interactive element(s) on ${snap.url}`);

  // 3. Generate flows
  let flows;
  try {
    flows = journeyMode ? await runJourneyMode(snap) : await singlePageMode(snap);
  } catch (e) {
    console.error(`Flow generation failed: ${e.message}`);
    process.exit(1);
  }

  if (!flows || flows.length === 0) {
    console.warn('No flows generated.');
    process.exit(0);
  }

  // 4. Save each flow
  let saved = 0;
  for (const flow of flows) {
    process.stdout.write(`Saving "${flow.name}" → ${flow.domain}... `);
    const result = await bridgeCmd('save_flow', {
      domain: flow.domain,
      name: flow.name,
      flow,
    });
    if (result.ok) {
      console.log(`✓  (~/.flows/${flow.domain}/${flow.name}.flow.json)`);
      saved++;
    } else {
      console.error(`✗  ${result.error}`);
    }
  }

  console.log(`\nDone. ${saved}/${flows.length} flow(s) saved.`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
