# Reel

브라우저 동작을 기록하고, 재실행하고, AI로 생성할 수 있는 flow 기반 자동화 도구입니다.

Chrome Extension으로 사용자 동작을 `flow` JSON으로 저장하고, 로컬 브리지 서버를 통해 외부 스크립트나 AI 에이전트가 이를 제어할 수 있습니다.

## 설치

### 1. reel-browser CLI

```bash
npm install -g reel-browser
```

### 2. Chrome Extension

[Chrome Web Store]에서 **Reel** 확장 프로그램을 설치합니다.

### 3. Claude Code 스킬 (선택)

Claude Code에서 `reel-browser` 스킬을 사용하려면:

```bash
reel install-skill
```

## 빠른 시작

```bash
reel start          # 브리지 서버 시작
reel status         # 서버 상태 + 익스텐션 연결 확인
reel stop           # 브리지 서버 종료
```

## 구성

```text
.
├── bridge/
│   ├── cli.js        # reel CLI 진입점
│   ├── daemon.js     # 백그라운드 서버 관리
│   ├── server.js     # 로컬 HTTP 큐 서버 (포트 9999)
│   ├── flowgen.js    # AI flow 생성
│   └── flowrun.js    # flow 실행
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

## 동작 방식

### 수동 녹화

1. 확장 프로그램에서 녹화를 시작합니다.
2. 콘텐츠 스크립트가 페이지 이동, 클릭, 입력, 선택 동작을 기록합니다.
3. 입력값 일부를 `{{variable}}` 형태로 치환할 수 있습니다.
4. popup에서 이름을 지정해 flow를 저장하고, 이후 재실행할 수 있습니다.

### AI flow 생성

1. `reel gen`이 브리지 서버에 `scan_page` 명령을 넣습니다.
2. 확장 프로그램이 현재 페이지의 상호작용 가능한 요소를 스캔합니다.
3. 스냅샷을 Claude API에 보내 flow를 생성합니다.
4. 생성된 flow를 확장 프로그램을 통해 저장합니다.

### 런타임 흐름

```
Chrome Extension (popup/background/content-script)
        ↕ chrome.storage.local + message passing
bridge/server.js  ←→  reel run / reel gen / 외부 에이전트
     127.0.0.1:9999
```

## CLI 커맨드

| 커맨드 | 설명 |
|--------|------|
| `reel start` | 브리지 서버를 백그라운드에서 시작 |
| `reel stop` | 브리지 서버 종료 |
| `reel status` | 서버 상태 및 익스텐션 연결 여부 확인 |
| `reel run list` | 저장된 flow 목록 조회 |
| `reel run run --domain <d> --name <n>` | flow 실행 |
| `reel gen --goal "..."` | AI로 flow 생성 (`ANTHROPIC_API_KEY` 필요) |
| `reel install-skill` | Claude Code용 reel-browser 스킬 설치 |

## 주요 컴포넌트

### `bridge/server.js`

npm 의존성 없이 Node 기본 모듈만으로 동작하는 큐 서버입니다.

| 엔드포인트 | 역할 |
|---|---|
| `POST /enqueue` | 명령 적재 |
| `GET /next-cmd` | 확장 프로그램이 다음 명령 수신 |
| `POST /result` | 실행 결과 저장 |
| `GET /wait-result/:id` | 결과 long-poll 대기 |
| `GET /status` | 확장 프로그램 연결 여부 확인 |

### `bridge/flowgen.js`

페이지 스캔 → Claude API 호출 → flow 저장까지 자동화합니다. `ANTHROPIC_API_KEY` 필요.

### `bridge/flowrun.js`

저장된 flow를 CLI에서 직접 조회하고 실행합니다.

### `chrome-extension/src/background.js`

확장 프로그램의 허브입니다. 녹화 상태 관리, 브리지 폴링, flow 실행, 탭 그룹 관리를 담당합니다.

주요 메시지 타입: `START_RECORDING`, `STOP_RECORDING`, `RUN_FLOW`, `STOP_RUN`, `BRIDGE_ON`, `BRIDGE_OFF`

### `chrome-extension/src/content-script.js`

페이지 내부에서 실제 기록과 실행을 수행합니다. CSS selector 우선, 실패 시 `aria-label` / role / text fallback으로 요소를 탐색합니다.

## flow 포맷

```json
{
  "name": "login_flow",
  "domain": "example.com",
  "version": 1,
  "steps": [
    { "action": "navigate", "url": "https://example.com/login" },
    { "action": "fill", "selector": "input[name=\"email\"]", "value": "{{email}}" },
    { "action": "click", "selector": "button[type=\"submit\"]" }
  ],
  "variables": {
    "email": { "source": "user", "description": "" }
  }
}
```

지원 액션: `navigate`, `click`, `fill`, `select`, `waitForSelector`, `evaluate`, `scan_page`

## 개발

```bash
# 익스텐션 테스트
cd chrome-extension && npm test

# 브리지 테스트
cd bridge && npm test
```
