# Reel

A flow-based browser automation tool for recording, replaying, and AI-generating browser actions.

Record user interactions as `flow` JSON via a Chrome Extension, and let external scripts or AI agents control the browser through a local bridge server.

## Installation

### 1. reel-browser CLI

```bash
npm install -g reel-browser
```

### 2. Chrome Extension

Clone this repository and load it directly into Chrome.

```bash
git clone https://github.com/East-KR/Reel.git
```

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `chrome-extension/` folder from the cloned repository

### 3. Claude Code Skill (optional)

To use the `reel-browser` skill in Claude Code:

```bash
reel install-skill
```

## Quick Start

```bash
reel start          # Start the bridge server in the background
reel status         # Check server status + extension connection
reel stop           # Stop the bridge server
```

## Project Structure

```text
.
├── bridge/
│   ├── cli.js        # reel CLI entry point
│   ├── daemon.js     # Background server management
│   ├── server.js     # Local HTTP queue server (port 9999)
│   ├── flowgen.js    # AI flow generation
│   └── flowrun.js    # Flow execution
└── chrome-extension/
    ├── manifest.json
    ├── src/
    │   ├── background.js
    │   ├── content-script.js
    │   ├── popup.html
    │   ├── popup.js
    │   └── utils/
    │       ├── flow-builder.js
    │       ├── flow-storage.js
    │       └── validator.js
    └── tests/
```

## How It Works

### Manual Recording

1. Start recording from the extension popup.
2. The content script captures navigation, clicks, inputs, and selections.
3. Input values can be replaced with `{{variable}}` placeholders.
4. Name and save the flow from the popup for later replay.

### AI Flow Generation

1. `reel gen` enqueues a `scan_page` command to the bridge server.
2. The extension scans the current page for interactive elements.
3. The snapshot is sent to the Claude API to generate a flow.
4. The generated flow is saved via the extension.

### Runtime Flow

```
Chrome Extension (popup/background/content-script)
        ↕ chrome.storage.local + message passing
bridge/server.js  ←→  reel run / reel gen / external agents
     127.0.0.1:9999
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `reel start` | Start the bridge server in the background |
| `reel stop` | Stop the bridge server |
| `reel status` | Check server status and extension connection |
| `reel run list` | List saved flows |
| `reel run run --domain <d> --name <n>` | Run a flow |
| `reel gen --goal "..."` | Generate a flow with AI (requires `ANTHROPIC_API_KEY`) |
| `reel install-skill` | Install the reel-browser skill for Claude Code |

## Bridge API

The bridge server (`http://localhost:9999`) acts as a command queue between the extension and external agents.

### HTTP Endpoints

| Endpoint | Role |
|----------|------|
| `POST /enqueue` | Enqueue a command |
| `GET /next-cmd` | Extension polls for the next command |
| `POST /result` | Store execution result |
| `GET /wait-result/:id` | Long-poll for result |
| `GET /status` | Check extension connection |

### Bridge Actions

| Action | Description |
|--------|-------------|
| `navigate` | Navigate to a URL |
| `click` | Click an element |
| `fill` | Fill an input field |
| `select` | Select a dropdown option |
| `waitForSelector` | Wait for an element to appear |
| `evaluate` | Execute JavaScript |
| `scan_page` | Scan the current page for interactive elements |
| `save_flow` | Save a flow to extension storage |
| `list_flows` | List saved flows |
| `run_flow` | Run a flow (with automatic variable load/save) |
| `get_vars` | Get saved variable values for a flow |
| `save_vars` | Save variable values for a flow |

## Variable Persistence

Variable values entered during flow execution (e.g. email, password) are stored in `chrome.storage.local` and persist across browser restarts.

- **Popup**: Previously entered values are automatically pre-filled on next run.
- **Agents**: Use `get_vars` to load saved values first; auto-generate if missing, then persist with `save_vars`.
- **`run_flow`**: Automatically merges saved variables on execution and saves them after each run.

## Key Components

### `bridge/server.js`

A queue server built on Node.js built-in modules with no npm dependencies.

### `bridge/flowgen.js`

Automates page scan → Claude API call → flow save. Requires `ANTHROPIC_API_KEY`.

### `bridge/flowrun.js`

Lists and runs saved flows directly from the CLI.

### `chrome-extension/src/background.js`

The hub of the extension. Handles recording state, bridge polling, flow execution, tab group management, and variable persistence.

Key message types: `START_RECORDING`, `STOP_RECORDING`, `RUN_FLOW`, `STOP_RUN`, `BRIDGE_ON`, `BRIDGE_OFF`

### `chrome-extension/src/content-script.js`

Performs actual recording and execution inside the page. Resolves elements by CSS selector first, falling back to `aria-label`, role, and text.

## Flow Format

```json
{
  "name": "login",
  "domain": "example.com",
  "description": "Login flow example",
  "version": 1,
  "steps": [
    { "action": "navigate", "url": "https://example.com/login" },
    { "action": "fill", "selector": "input[name=\"email\"]", "value": "{{email}}" },
    { "action": "click", "selector": "button[type=\"submit\"]" }
  ],
  "variables": {
    "email": { "source": "user", "description": "Login email" },
    "password": { "source": "user", "description": "Password" }
  }
}
```

Supported actions: `navigate`, `click`, `fill`, `select`, `waitForSelector`, `evaluate`, `scan_page`

Flow files are stored at `~/.flows/{domain}/{name}.flow.json`.

## Development

```bash
# Extension tests
cd chrome-extension && npm test

# Bridge tests
cd bridge && npm test
```
