// bridge/server.js
// HTTP bridge server — no npm dependencies
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 9999;

const queue = [];           // pending commands: [{ id, action, ... }]
const results = new Map();  // id -> result object
const waiters = new Map();  // id -> { res, timer } (long-poll holders)
let lastSeenAt = null;      // timestamp of last /next-cmd poll
const timeouts = new Map();  // id -> waitTimeout ms

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  // POST /enqueue — skill adds a command
  if (req.method === 'POST' && req.url === '/enqueue') {
    let cmd;
    try { cmd = await readBody(req); } catch (_) { send(res, 400, { error: 'Invalid JSON' }); return; }
    const id = crypto.randomUUID();
    queue.push({ id, ...cmd });
    if (typeof cmd.waitTimeout === 'number') timeouts.set(id, cmd.waitTimeout);
    console.log(`[enqueue] ${id} action=${cmd.action}`);
    send(res, 200, { id });
    return;
  }

  // GET /next-cmd — extension polls for next command
  if (req.method === 'GET' && req.url === '/next-cmd') {
    lastSeenAt = Date.now();
    const cmd = queue.shift();
    if (cmd) {
      console.log(`[dispatch] ${cmd.id} action=${cmd.action}`);
      send(res, 200, cmd);
    } else {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      res.end();
    }
    return;
  }

  // POST /result — extension posts result
  if (req.method === 'POST' && req.url === '/result') {
    let result;
    try { result = await readBody(req); } catch (_) { send(res, 400, { error: 'Invalid JSON' }); return; }
    console.log(`[result] ${result.id} ok=${result.ok}${result.error ? ' error=' + result.error : ''}`);
    timeouts.delete(result.id);
    const waiter = waiters.get(result.id);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiters.delete(result.id);
      send(waiter.res, 200, result);
    } else {
      results.set(result.id, result);
    }
    send(res, 200, {});
    return;
  }

  // GET /wait-result/:id — skill waits for result (long poll, 10s timeout)
  if (req.method === 'GET' && req.url.startsWith('/wait-result/')) {
    const id = req.url.slice('/wait-result/'.length);
    const existing = results.get(id);
    if (existing) {
      results.delete(id);
      send(res, 200, existing);
      return;
    }
    const timeoutMs = timeouts.get(id) ?? 10000;
    timeouts.delete(id);
    const timer = setTimeout(() => {
      waiters.delete(id);
      send(res, 200, { id, ok: false, error: 'timeout' });
    }, timeoutMs);
    waiters.set(id, { res, timer });
    return;
  }

  // GET /status — is extension connected?
  if (req.method === 'GET' && req.url === '/status') {
    const connected = lastSeenAt !== null && (Date.now() - lastSeenAt < 2000);
    send(res, 200, { connected, seenAt: lastSeenAt });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Bridge server listening on http://127.0.0.1:${PORT}`);
});
