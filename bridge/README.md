# reel-browser

CLI and bridge server for the [Reel](https://github.com/East-KR/Reel) browser automation tool.

## Installation

```bash
npm install -g reel-browser
```

## Commands

```bash
reel start                              # Start bridge server in background
reel stop                               # Stop bridge server
reel status                             # Check server status and extension connection
reel run list                           # List saved flows
reel run run --domain <d> --name <n>    # Run a saved flow
reel gen --goal "..."                   # Generate a flow with AI (requires ANTHROPIC_API_KEY)
reel install-skill                      # Install reel-browser skill for Claude Code
```

## Files

| File | Description |
|------|-------------|
| `cli.js` | CLI entry point — routes subcommands |
| `daemon.js` | Background server management (PID file at `~/.reel/server.pid`) |
| `server.js` | HTTP queue server on port 9999 |
| `flowrun.js` | Flow listing and execution |
| `flowgen.js` | AI flow generation via Claude API |
| `skills/reel-browser/SKILL.md` | Claude Code skill (copied by `reel install-skill`) |

## Bridge Server API

The server runs at `http://localhost:9999` and acts as a command queue between the Chrome extension and external agents.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/enqueue` | POST | Enqueue a command |
| `/next-cmd` | GET | Extension polls for next command |
| `/result` | POST | Store execution result |
| `/wait-result/:id` | GET | Long-poll for result |
| `/status` | GET | Check extension connection |

### Supported Actions

| Action | Description |
|--------|-------------|
| `navigate` | Navigate to URL |
| `click` | Click an element |
| `fill` | Fill an input field |
| `select` | Select a dropdown option |
| `waitForSelector` | Wait for an element |
| `evaluate` | Execute JavaScript |
| `scan_page` | Scan page for interactive elements |
| `save_flow` | Save a flow to extension storage |
| `list_flows` | List saved flows |
| `run_flow` | Run a flow (auto load/save variables) |
| `get_vars` | Get saved variable values for a flow |
| `save_vars` | Save variable values for a flow |

## Development

```bash
npm test
```

## Flow Storage

Flows are stored as JSON files at `~/.flows/{domain}/{name}.flow.json`.  
Variable values persist in the extension's `chrome.storage.local` across browser restarts.
