---
name: reel-browser
description: Use when the user wants to run a recorded browser flow, automate a web task using a saved flow file, or execute browser actions defined in a ~/.flows JSON file. Triggers on "run flow", "automate this", "use my recorded flow", "open browser and do X".
---

# reel-browser Skill

Executes recorded browser flows from `~/.flows/` using the dev-browser CLI or the Chrome extension bridge.

## Installation Check

```bash
if ! which dev-browser > /dev/null 2>&1; then
  npm install -g dev-browser
  dev-browser install
fi
```

Run `dev-browser install` once (after npm install) to download Playwright + Chromium.

## Execution Loop

Follow these steps in order:

### 1. Detect Domain

Priority order:
1. Explicit domain in user's message (e.g. "on github.com")
2. `domain` field of a flow the user names by name
3. `git remote get-url origin` → extract hostname
4. None found → ask user: "Which site is this flow for?"

```bash
git remote get-url origin 2>/dev/null | sed -E 's#^.*@##; s#://##; s#[:/].*##'
# e.g. "https://github.com/myorg/myrepo" → "github.com"
# e.g. "git@github.com:myorg/myrepo.git" → "github.com"
```

### 2. Find Flow

```bash
ls ~/.flows/{domain}/*.flow.json 2>/dev/null
```

- Zero files → tell user no flows found for this domain
- One file → proceed
- Multiple files → list them and ask user to choose

### 3. Validate Flow

Use the Read tool to load the flow file (the path resolved in Step 2), then check:
- `steps` array must not be empty
- Every `{{variable}}` pattern used in any step field must have a matching key in the `variables` object
- Any `fill` step with an empty `value: ""` was likely not captured correctly by the recorder (e.g. user pressed Enter before the debounce fired). Treat these as missing variables: ask the user to provide the value before running.

If validation fails, abort with a specific message.

### 4. Resolve Variables

For each variable with `source: "user"`:

1. **git context** — for `owner`/`repo`: `git remote get-url origin`
2. **package.json** — for `name`/`version`: `cat package.json | python3 -m json.tool`
3. **Inferred** → show user and ask to confirm: "I found owner=myorg, repo=myrepo. Proceed?"
4. **Not found** → ask user directly

Never run the flow before all variables are confirmed.

### 5. Check Execution Mode

Before generating the script, check whether the Chrome extension bridge is active:

```bash
curl -s --max-time 1 http://localhost:9999/status 2>/dev/null
```

- Response is `{"connected":true}` → **Bridge mode**: use the extension bridge (runs in the user's real Chrome, has their session/cookies)
- Any other response (server not running, `connected: false`, timeout) → **Headless mode**: use dev-browser with `--headless`

Tell the user which mode is being used: `"Bridge mode: running in your Chrome"` or `"Headless mode: launching Chromium"`.

### 6. Generate Script

#### Bridge Mode

Generate a Node.js script that sends each step to the bridge server (`http://localhost:9999`).

Start every bridge script with these helpers:

```javascript
const http = require('http');

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: 'localhost', port: 9999, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => { let s = ''; res.on('data', c => s += c); res.on('end', () => resolve(JSON.parse(s))); }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: 'localhost', port: 9999, path, method: 'GET' },
      (res) => { let s = ''; res.on('data', c => s += c); res.on('end', () => resolve(JSON.parse(s))); }
    );
    req.on('error', reject);
    req.end();
  });
}

async function step(action) {
  const { id } = await post('/enqueue', action);
  const result = await get(`/wait-result/${id}`);
  if (!result.ok) throw new Error(`${action.action} failed: ${result.error}`);
  return result;
}

async function run() {
```

Then translate each flow step inside the `run()` body:

| Flow action | Bridge script line |
|-------------|-------------------|
| `navigate` | `await step({ action: 'navigate', url: 'URL' });` |
| `click` | `await step({ action: 'click', selector: 'SELECTOR' });` |
| `fill` | `await step({ action: 'fill', selector: 'SELECTOR', value: 'VALUE' });` |
| `select` | `await step({ action: 'select', selector: 'SELECTOR', value: 'VALUE' });` |
| `evaluate` | `const r = await step({ action: 'evaluate', script: 'SCRIPT' }); console.log(r.result);` |
| `wait` | `await new Promise(r => setTimeout(r, MS));` |
| `waitForSelector` | `await step({ action: 'waitForSelector', selector: 'SELECTOR', ms: MS });` |
| `screenshot` | *(skip — not supported by bridge; log a note)* |

End the script with:

```javascript
}

run().then(() => { console.log('Flow complete'); process.exit(0); })
     .catch(e => { console.error('Error:', e.message); process.exit(1); });
```

#### Headless Mode

Start every script with:
```javascript
const page = await browser.getPage("FLOW_NAME");
// Replace FLOW_NAME with the flow's "name" field (e.g. "create-pr", "search")
// Named pages persist between runs — the same browser tab is reused each time
// this flow executes. Each flow name gets its own isolated tab.
// Note: saveScreenshot(buf, name), writeFile(name, data), readFile(name)
// are built-in sandbox functions. Do NOT define or require them.
```

Then translate each step. Variable values are substituted inline.

| Action | JavaScript code |
|--------|----------------|
| `navigate` | `await page.goto("URL", { waitUntil: 'domcontentloaded' });` |
| `click` | `await page.click("SELECTOR");` |
| `fill` | `await page.fill("SELECTOR", "VALUE");` |
| `select` | `await page.selectOption("SELECTOR", "VALUE");` |
| `wait` | `await page.waitForTimeout(MS);` |
| `waitForSelector` | `await page.waitForSelector("SELECTOR", { timeout: MS });` where MS = step's `ms` field, default 10000 |
| `screenshot` | `const buf = await page.screenshot(); await saveScreenshot(buf, PATH);` where PATH = step's `path` field value if present, otherwise `"screenshot-" + Date.now() + ".png"` |

If a step's `action` is not in the table above, abort and tell the user: "Unsupported action type: [action]. Cannot generate script."

Screenshots are saved to `~/.dev-browser/tmp/`.

### 7. Execute

Use the Write tool to create the script file at a temp path like `/tmp/flow-<timestamp>.js`.

#### Bridge Mode

```bash
node /tmp/flow-<timestamp>.js
EXIT_CODE=$?
rm -f /tmp/flow-<timestamp>.js
```

#### Headless Mode

```bash
dev-browser --headless --timeout 120 run /tmp/flow-<timestamp>.js
EXIT_CODE=$?
rm -f /tmp/flow-<timestamp>.js
```

**Note:** `--connect` (attach to user's Chrome) is available if the user explicitly requests it, but bridge mode is preferred over `--connect` when the bridge is active.

### 8. Report Result

- **Exit code 0** → success. Report which flow ran, which mode was used, and any output.
- **Non-zero exit** → identify the failing step from the error output.
  Ask user: "Step N failed: [error message]. What would you like to do?"
  - **A) Retry from this step** → find the most recent `navigate` step before the failed step, re-run from that `navigate` step through to the end. If no preceding `navigate` step exists, treat as option B.
  - **B) Retry from beginning** → re-confirm all variable values, then re-run from step 0
  - **C) Cancel** → abort and summarize what happened

## Flow File Format Reference

```json
{
  "name": "flow-name",
  "domain": "example.com",
  "description": "Human-readable description",
  "version": 1,
  "steps": [
    { "action": "navigate", "url": "https://example.com/page" },
    { "action": "click", "selector": "#button", "description": "optional label" },
    { "action": "fill", "selector": "#input", "value": "{{variable}}" },
    { "action": "select", "selector": "#dropdown", "value": "option-value" },
    { "action": "wait", "ms": 1000 },
    { "action": "waitForSelector", "selector": "#loaded-element", "ms": 15000 },
    { "action": "screenshot" }
  ],
  "variables": {
    "variable": { "source": "user", "description": "What this is" }
  }
}
```

Flow files live in: `~/.flows/{domain}/{name}.flow.json`
