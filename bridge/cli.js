#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const [,, cmd] = process.argv;

const USAGE = `Usage: reel <command>

Commands:
  start           Start bridge server in background
  stop            Stop bridge server
  status          Show server and extension status
  run <subcmd>    Run a flow  (subcmd: list | run --domain <d> --name <n>)
  gen             Generate flows with AI (requires ANTHROPIC_API_KEY)
  install-skill   Install reel-browser skill to ~/.claude/skills/

`;

if (!cmd || cmd === '--help' || cmd === '-h') {
  process.stdout.write(USAGE);
  process.exit(0);
}

const daemon = require('./daemon');

switch (cmd) {
  case 'start':
    daemon.start().catch(e => { console.error(e.message); process.exit(1); });
    break;

  case 'stop':
    daemon.stop().catch(e => { console.error(e.message); process.exit(1); });
    break;

  case 'status':
    daemon.status().catch(e => { console.error(e.message); process.exit(1); });
    break;

  case 'run':
    process.argv.splice(2, 1);
    require('./flowrun');
    break;

  case 'gen':
    process.argv.splice(2, 1);
    require('./flowgen');
    break;

  case 'install-skill': {
    const src = path.join(__dirname, 'skills', 'reel-browser', 'SKILL.md');
    const destDir = path.join(os.homedir(), '.claude', 'skills', 'reel-browser');
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, path.join(destDir, 'SKILL.md'));
    console.log(`Skill installed to ${destDir}/SKILL.md`);
    break;
  }

  default:
    console.error(`Unknown command: ${cmd}\n`);
    process.stdout.write(USAGE);
    process.exit(1);
}
