# reel-browser 스킬 아키텍처

Claude Code의 스킬 시스템과 `reel-browser` 스킬이 어떻게 동작하는지 설명합니다.

---

## 스킬이란

스킬은 Claude에게 특정 작업을 어떻게 수행할지 알려주는 마크다운 문서입니다.  
`~/.claude/skills/{skill-name}/SKILL.md` 경로에 저장되며, Claude가 대화 중 관련 키워드를 감지하면 자동으로 로드합니다.

스킬은 코드를 실행하지 않습니다. Claude가 스킬을 읽고, 그 규칙에 따라 **직접 코드를 작성하고 실행**합니다.

```
SKILL.md (규칙 문서)
    → Claude가 읽고 해석
    → Write 툴로 스크립트 작성
    → Bash 툴로 실행
```

---

## reel-browser 스킬 구조

### Frontmatter — 트리거 조건

```yaml
---
name: reel-browser
description: Use when the user wants to run a recorded browser flow...
             Triggers on "run flow", "automate this", "create a flow for" ...
---
```

대화에서 "플로우 실행해줘", "create a flow for", "automate this" 같은 표현이 나오면 Claude가 이 스킬을 자동으로 로드합니다.

---

### 플로우 생성 섹션

사용자가 새 플로우를 만들어달라고 요청할 때의 규칙입니다.

#### Option A — `reel gen` (ANTHROPIC_API_KEY 있을 때)

```bash
reel gen --goal "<목표 설명>"
```

브리지 서버에 `scan_page` 명령을 보내고, 스캔 결과를 Claude API에 전달해 flow JSON을 자동 생성합니다.

#### Option B — 수동 생성 (API 키 없을 때)

Claude가 직접 수행합니다:

1. 브리지 연결 확인 → `reel start` 필요시 실행
2. 대상 URL로 navigate
3. `scan_page`로 페이지 요소 수집
4. 스캔 결과 분석 → flow JSON 작성 (동적 값은 `{{variable}}` 처리)
5. `~/.flows/{domain}/{name}.flow.json` 저장
6. `save_flow` 브리지 명령으로 익스텐션 동기화
7. 사용자에게 결과 확인 및 실행 여부 질문

---

### 실행 루프 — 8단계

#### 1. 도메인 감지

플로우가 어느 사이트용인지 다음 순서로 추론합니다:

```
사용자 메시지에 명시 → flow 파일의 domain 필드 → git remote URL 추출 → 사용자에게 직접 질문
```

#### 2. 플로우 파일 탐색

```bash
ls ~/.flows/{domain}/*.flow.json
```

- 0개: 해당 도메인에 플로우 없음 안내
- 1개: 바로 진행
- 여러 개: 목록 출력 후 선택 요청

#### 3. 플로우 검증

파일을 읽어 다음을 확인합니다:

- `steps` 배열이 비어있지 않은지
- 모든 `{{variable}}`에 대응하는 `variables` 키가 있는지
- `fill` 스텝의 `value`가 빈 문자열이 아닌지 (녹화 중 Enter를 빨리 눌렀을 때 발생)

검증 실패 시 구체적인 이유와 함께 중단합니다.

#### 4. 변수 해결

변수값을 다음 우선순위로 해결합니다:

| 순서 | 방법 | 설명 |
|------|------|------|
| 1 | `get_vars` | 이전 실행에서 저장된 값 자동 로드 |
| 2 | git / package.json | `owner`, `repo`, `name` 등 프로젝트 정보 추론 |
| 3 | 자동 생성 | 저장값 없을 때 테스트용 값 생성 (`test_abc@example.com` 등) |
| 4 | 사용자 직접 입력 | Headless 모드이거나 추론 불가한 경우 |

실행 전 `save_vars`로 저장해 다음 실행 시 재사용합니다.

#### 5. 실행 모드 판단

```bash
curl -s --max-time 1 http://localhost:9999/status
```

| 응답 | 모드 | 특징 |
|------|------|------|
| `{"connected":true}` | Bridge mode | 사용자 크롬에서 실행, 쿠키/세션 유지 |
| 그 외 | Headless mode | Chromium 별도 실행, 독립 세션 |

#### 6. 스크립트 생성

flow의 각 step을 Node.js 코드로 변환합니다. 스킬에 변환 규칙 테이블이 정의되어 있습니다.

**Bridge mode 변환 규칙:**

| Flow action | 생성되는 코드 |
|-------------|-------------|
| `navigate` | `await step({ action: 'navigate', url: 'URL' });` |
| `click` | `await step({ action: 'click', selector: 'SEL' });` |
| `fill` | `await step({ action: 'fill', selector: 'SEL', value: 'VAL' });` |
| `waitForSelector` | `await step({ action: 'waitForSelector', selector: 'SEL', ms: MS });` |
| `wait` | `await new Promise(r => setTimeout(r, MS));` |

모든 Bridge 스크립트에는 HTTP 통신 헬퍼가 포함됩니다:

```javascript
// 스킬에 정의된 고정 헬퍼 템플릿
async function step(action) {
  const { id } = await post('/enqueue', action);       // 명령 적재
  const result = await get(`/wait-result/${id}`);      // 결과 대기
  if (!result.ok) throw new Error(`${action.action} failed: ${result.error}`);
  return result;
}
```

**Headless mode 변환 규칙:**

| Flow action | 생성되는 코드 |
|-------------|-------------|
| `navigate` | `await page.goto("URL", { waitUntil: 'domcontentloaded' });` |
| `click` | `await page.click("SEL");` |
| `fill` | `await page.fill("SEL", "VAL");` |
| `waitForSelector` | `await page.waitForSelector("SEL", { timeout: MS });` |
| `screenshot` | `const buf = await page.screenshot(); await saveScreenshot(buf, PATH);` |

#### 7. 실행

```
Write 툴 → /tmp/flow-<timestamp>.js 작성
Bash 툴  → node /tmp/flow-<timestamp>.js 실행
Bash 툴  → rm -f /tmp/flow-<timestamp>.js 삭제
```

Headless mode는 `dev-browser --headless --timeout 120 run /tmp/flow-xxx.js`로 실행합니다.

#### 8. 결과 처리

| 결과 | 처리 |
|------|------|
| exit 0 | 실행한 플로우, 모드, 출력 결과 보고 |
| exit 1 | 실패한 스텝과 에러 메시지 표시 후 옵션 제공 |

실패 시 재시도 옵션:
- **A) 해당 스텝부터 재시도** — 가장 가까운 `navigate`부터 재실행
- **B) 처음부터 재시도** — 변수값 재확인 후 전체 재실행
- **C) 취소** — 중단 후 상황 요약

---

## 전체 흐름 요약

```
사용자: "로그인 플로우 실행해줘"
    ↓
Claude: reel-browser 스킬 로드 (SKILL.md 읽기)
    ↓
도메인 감지 → 플로우 파일 탐색 → 검증
    ↓
변수 해결 (get_vars → 자동생성 → 사용자 입력)
    ↓
브리지 상태 확인 → Bridge / Headless 모드 결정
    ↓
flow step → Node.js 스크립트 변환 (Write 툴)
    ↓
node /tmp/flow-xxx.js 실행 (Bash 툴)
    ↓
HTTP → bridge/server.js → Chrome Extension → 페이지 조작
    ↓
결과 보고
```

---

## 스킬 설치

```bash
# reel CLI로 설치 (bridge/skills/ → ~/.claude/skills/ 복사)
reel install-skill
```

설치 후 Claude Code를 재시작하면 스킬이 활성화됩니다.
