# AI 에이전트 워크플로우

Claude Code의 `reel-browser` 스킬을 통해 AI 에이전트가 플로우를 생성하고 실행하는 과정을 설명합니다.

---

## 1. 플로우 생성

### 트리거

사용자가 URL과 목표를 전달합니다.

```
"https://example.com/login 에서 로그인 테스트 플로우 만들어줘"
```

### Step 1 — 브리지 상태 확인

```bash
curl -s http://localhost:9999/status
# {"connected":true}  → Bridge mode (사용자의 실제 크롬에서 실행)
# {"connected":false} → Headless mode (Chromium 별도 실행)
```

브리지가 연결되어 있으면 사용자의 쿠키/세션을 그대로 활용할 수 있습니다.

### Step 2 — 페이지 이동 및 스캔

브리지를 통해 대상 URL로 이동한 뒤 `scan_page`로 인터랙션 가능한 요소를 수집합니다.

```javascript
await step({ action: 'navigate', url: 'https://example.com/login' });
await step({ action: 'scan_page' });
```

`scan_page` 응답 예시:

```json
{
  "url": "https://example.com/login",
  "title": "Login",
  "elements": [
    { "tag": "input", "type": "email",    "selector": "#customer_email",    "label": "Email" },
    { "tag": "input", "type": "password", "selector": "#customer_password", "label": "Password" },
    { "tag": "input", "type": "submit",   "selector": "div.action_bottom > input.button" }
  ]
}
```

수집 대상: `input`, `textarea`, `select`, `button`, `a[href]`, `[role="button"]` 등  
제외 대상: `display:none`, `visibility:hidden`, `aria-hidden="true"` 요소

### Step 3 — flow JSON 구성

스캔 결과에서 목표에 맞는 셀렉터를 골라 flow를 작성합니다.  
동적인 값은 `{{variable}}` 플레이스홀더로 처리합니다.

```json
{
  "name": "login",
  "domain": "example.com",
  "description": "이메일/비밀번호로 로그인",
  "version": 1,
  "steps": [
    { "action": "navigate",        "url": "https://example.com/login" },
    { "action": "fill",            "selector": "#customer_email",    "value": "{{email}}" },
    { "action": "fill",            "selector": "#customer_password", "value": "{{password}}" },
    { "action": "click",           "selector": "div.action_bottom > input.button" },
    { "action": "waitForSelector", "selector": "#logout_link",       "ms": 8000 }
  ],
  "variables": {
    "email":    { "source": "user", "description": "로그인 이메일" },
    "password": { "source": "user", "description": "비밀번호" }
  }
}
```

### Step 4 — 저장 및 익스텐션 동기화

파일시스템 저장과 익스텐션 동기화를 모두 해야 합니다.

```bash
# 파일시스템 저장 (에이전트가 다음 실행 시 읽는 경로)
~/.flows/{domain}/{name}.flow.json
```

```javascript
// 익스텐션 chrome.storage.local 동기화 (팝업에서 보이려면 필수)
await step({ action: 'save_flow', domain: flow.domain, name: flow.name, flow });
```

> 파일만 저장하면 에이전트는 읽을 수 있지만 크롬 팝업에서는 보이지 않습니다.  
> `save_flow`까지 해야 팝업에서 확인/실행이 가능합니다.

---

## 2. 플로우 실행

### Step 1 — 플로우 파일 로드 및 검증

```bash
cat ~/.flows/{domain}/{name}.flow.json
```

검증 항목:
- `steps` 배열이 비어있지 않은지
- 모든 `{{variable}}` 패턴에 대응하는 `variables` 키가 있는지
- `fill` 스텝의 `value`가 빈 문자열이 아닌지

### Step 2 — 변수값 해결

변수값 해결 우선순위:

| 순서 | 방법 | 설명 |
|------|------|------|
| 1 | `get_vars` (저장된 값) | 이전 실행에서 저장된 값 자동 로드 |
| 2 | git / package.json | `owner`, `repo`, `name` 등 추론 |
| 3 | 자동 생성 | 저장값 없을 때 테스트용 값 생성 (`test_abc123@example.com` 등) |
| 4 | 사용자에게 직접 요청 | Headless mode이거나 추론 불가한 경우 |

브리지 모드에서는 실행 전 `save_vars`로 변수값을 저장합니다.

```javascript
// 저장된 변수 로드
const { vars } = await step({ action: 'get_vars', domain, name });

// 실행 전 저장 (다음 실행 시 재사용)
await step({ action: 'save_vars', domain, name, vars: resolvedVars });
```

### Step 3 — 실행 모드 선택

| 모드 | 조건 | 특징 |
|------|------|------|
| **Bridge mode** | `connected: true` | 사용자 크롬에서 실행, 쿠키/세션 유지 |
| **Headless mode** | `connected: false` | Chromium 별도 실행, 독립적인 세션 |

### Step 4 — 스크립트 생성 및 실행

각 flow step을 Node.js 스크립트로 변환해서 실행합니다.

**Bridge mode 스크립트 예시:**

```javascript
await step({ action: 'navigate', url: 'https://example.com/login' });
await new Promise(r => setTimeout(r, 2000)); // 페이지 로딩 대기
await step({ action: 'waitForSelector', selector: '#customer_email', ms: 8000 });
await step({ action: 'fill', selector: '#customer_email',    value: 'user@example.com' });
await step({ action: 'fill', selector: '#customer_password', value: 'password123' });
await step({ action: 'click', selector: 'div.action_bottom > input.button' });
await new Promise(r => setTimeout(r, 4000)); // 제출 후 리다이렉트 대기
await step({ action: 'waitForSelector', selector: '#logout_link', ms: 8000 });
```

**Headless mode 스크립트 예시:**

```javascript
const page = await browser.getPage("login");
await page.goto("https://example.com/login", { waitUntil: 'domcontentloaded' });
await page.waitForSelector("#customer_email", { timeout: 8000 });
await page.fill("#customer_email",    "user@example.com");
await page.fill("#customer_password", "password123");
await page.click("div.action_bottom > input.button");
await page.waitForSelector("#logout_link", { timeout: 8000 });
```

### Step 5 — 결과 처리

| 결과 | 처리 |
|------|------|
| 성공 (exit 0) | 실행한 플로우, 모드, 출력 결과 보고 |
| 실패 (exit 1) | 실패한 스텝과 에러 메시지 표시 후 재시도 옵션 제공 |

실패 시 재시도 옵션:
- **A) 해당 스텝부터 재시도** — 가장 가까운 `navigate` 스텝부터 재실행
- **B) 처음부터 재시도** — 변수값 재확인 후 전체 재실행
- **C) 취소** — 중단 후 상황 요약

---

## 3. 알려진 한계

### 페이지 이동 후 메시지 채널 단절

폼 제출이나 navigate 후 페이지가 전환되면 콘텐츠 스크립트의 메시지 채널이 닫힙니다.  
바로 `waitForSelector`를 보내면 실패하므로, **navigate/click(submit) 후에는 sleep을 추가**합니다.

```javascript
await step({ action: 'click', selector: 'input[type="submit"]' });
await new Promise(r => setTimeout(r, 4000)); // 리다이렉트 완료 대기
await step({ action: 'waitForSelector', selector: '#dashboard', ms: 8000 });
```

### scan_page는 현재 페이지만 스캔

로그인 후 이동하는 페이지의 요소는 별도로 navigate 후 추가 스캔이 필요합니다.

### SPA 동적 셀렉터

React/Vue 등 SPA에서는 렌더링 타이밍에 따라 셀렉터가 달라질 수 있습니다.  
`:r2:`, `:R1357:` 같은 불안정한 동적 ID는 자동으로 필터링됩니다.

### 익스텐션 미동기화

`~/.flows/`에만 저장하고 `save_flow`를 보내지 않으면 크롬 팝업에서 플로우가 보이지 않습니다.  
재동기화가 필요한 경우:

```javascript
const flow = JSON.parse(fs.readFileSync('~/.flows/domain/name.flow.json'));
await step({ action: 'save_flow', domain: flow.domain, name: flow.name, flow });
```
