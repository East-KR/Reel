'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

function getReelDir() {
  return process.env.REEL_DIR || path.join(os.homedir(), '.reel');
}

function getPidFile() { return path.join(getReelDir(), 'server.pid'); }
function getLogFile() { return path.join(getReelDir(), 'server.log'); }

function ensureDir() {
  const dir = getReelDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getPid() {
  try {
    const n = parseInt(fs.readFileSync(getPidFile(), 'utf8').trim(), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function writePid(pid) {
  ensureDir();
  fs.writeFileSync(getPidFile(), String(pid), 'utf8');
}

function clearPid() {
  try { fs.unlinkSync(getPidFile()); } catch {}
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function checkBridge() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:9999/status', (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).connected === true); }
        catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

async function start() {
  ensureDir();
  const existing = getPid();
  if (existing && isRunning(existing)) {
    console.log(`Server already running (pid ${existing})`);
    return;
  }
  if (existing) clearPid();

  const logFile = getLogFile();
  const logStream = fs.openSync(logFile, 'a');
  const serverJs = path.join(__dirname, 'server.js');
  const child = spawn(process.execPath, [serverJs], {
    detached: true,
    stdio: ['ignore', logStream, logStream],
  });
  fs.closeSync(logStream);
  child.unref();
  writePid(child.pid);
  console.log(`Server started (pid ${child.pid})`);
  console.log(`Log: ${logFile}`);
}

async function stop() {
  const pid = getPid();
  if (!pid || !isRunning(pid)) {
    clearPid();
    console.log('Server not running');
    return;
  }
  process.kill(pid);
  clearPid();
  console.log(`Server stopped (pid ${pid})`);
}

async function status() {
  const pid = getPid();
  if (!pid || !isRunning(pid)) {
    if (pid) clearPid();
    console.log('Server:    not running');
    console.log('Extension: disconnected');
    return;
  }
  const connected = await checkBridge();
  console.log(`Server:    running (pid ${pid})`);
  console.log(`Extension: ${connected ? 'connected' : 'disconnected'}`);
  console.log('Bridge:    http://127.0.0.1:9999');
}

module.exports = { getPid, writePid, clearPid, isRunning, start, stop, status };
