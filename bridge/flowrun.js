#!/usr/bin/env node
'use strict';

const http = require('http');

const BRIDGE = 'http://127.0.0.1:9999';
const args = process.argv.slice(2);
const subcmd = args[0];

function getFlag(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

function httpRequest(url, method, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const bodyStr = body != null ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method, headers },
      (res) => {
        let data = '';
        res.on('data', d => { data += d; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: null, raw: data }); }
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

async function bridgeCmd(action, extra = {}) {
  const enqueueRes = await bridgePost('/enqueue', { action, ...extra });
  const id = enqueueRes.id;
  if (!id) throw new Error(`/enqueue did not return an id: ${JSON.stringify(enqueueRes)}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await bridgeGet(`/wait-result/${id}`);
    if (result.error !== 'timeout') return result;
    process.stderr.write('Extension slow to respond, retrying...\n');
  }
  return { ok: false, error: 'timeout after 3 attempts' };
}

async function checkBridge() {
  let status;
  try {
    status = await bridgeGet('/status');
  } catch {
    process.stderr.write('Bridge server not running on :9999 — enable Bridge ON in the extension popup\n');
    process.exit(1);
  }
  if (!status.connected) {
    process.stderr.write('Extension not connected — open a Flows group tab and enable Bridge ON\n');
    process.exit(1);
  }
}

async function cmdList() {
  await checkBridge();
  const result = await bridgeCmd('list_flows');
  if (!result.ok) {
    process.stderr.write(`list_flows failed: ${result.error}\n`);
    process.exit(1);
  }
  const flows = [];
  for (const [domain, items] of Object.entries(result.flows || {})) {
    for (const item of items) {
      flows.push({ name: item.name, domain, description: item.description, variables: item.variables });
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, flows }, null, 2) + '\n');
}

async function cmdRun() {
  const domain = getFlag('--domain');
  const name = getFlag('--name');
  const varsRaw = getFlag('--vars');

  if (!domain || !name) {
    process.stderr.write('Usage: flowrun.js run --domain <domain> --name <name> [--vars \'{"key":"val"}\']\n');
    process.exit(1);
  }

  let vars = {};
  if (varsRaw) {
    try { vars = JSON.parse(varsRaw); }
    catch { process.stderr.write('--vars must be valid JSON\n'); process.exit(1); }
  }

  await checkBridge();

  const result = await bridgeCmd('run_flow', { domain, name, vars, waitTimeout: 120000 });

  if (!result.ok) {
    process.stderr.write(`run_flow failed: ${result.error}\n`);
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({ ok: result.ok, results: result.results }, null, 2) + '\n');
  const anyFailed = (result.results || []).some(r => !r.ok && !r.skipped);
  process.exit(anyFailed ? 1 : 0);
}

if (subcmd === 'list') {
  cmdList().catch(e => { process.stderr.write(e.message + '\n'); process.exit(1); });
} else if (subcmd === 'run') {
  cmdRun().catch(e => { process.stderr.write(e.message + '\n'); process.exit(1); });
} else {
  process.stderr.write('Usage: flowrun.js <list|run> [options]\n');
  process.stderr.write('  list                                         — list all flows\n');
  process.stderr.write('  run --domain <d> --name <n> [--vars <json>]  — run a flow\n');
  process.exit(1);
}
