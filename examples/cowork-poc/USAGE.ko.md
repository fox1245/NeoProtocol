# Cowork PoC — 사용 가이드 (한국어)

데모 실행 방법과 UI 의 모든 버튼·필드·패널이 무엇을 하는지 단계별로
설명한다. 영어 버전: [USAGE.md](./USAGE.md).

설계 의도 (각 Stage 가 무엇을 보여주는지, SPEC §16 / §17 와 어떻게
연결되는지) 는 [README.md](./README.md) 참고. 이 문서는 운영자 시점의
세부 사용 가이드다.

---

## 1. 사전 준비

- Node.js ≥ 18 (Originator + signaling relay 용).
- 최신 Chromium 계열 브라우저 (Chrome, Edge, Brave, Arc).
  Firefox/Safari 도 동작은 하나 Stage 1 이후로는 Chromium 에서만
  검증되어 있음.
- (선택) **OpenAI** 또는 **Anthropic** API 키 — 진짜 LLM 출력을
  보고 싶다면. 없으면 오프라인 mock 또는 in-browser 로컬 모델로 데모
  가능.
- (선택, 그러나 **연결 성공에 중요**) *WebRTC Leak Prevent* 같은
  WebRTC 차단 확장은 **반드시 비활성화**. 이런 확장이 ICE candidate
  를 막아버려 데이터 채널이 영영 안 열린다.

## 2. 두 서버 띄우기

repo 루트에서 터미널 두 개:

```bash
# 터미널 A — Originator (Express + /signaling WebSocket relay)
cd server
npm install         # 최초 1회
npm start           # → http://localhost:3001
```

```bash
# 터미널 B — 데모 HTML 정적 서버
cd examples
python3 -m http.server 8801   # → http://localhost:8801
```

둘 다 떠 있어야 한다. Originator 는 **태스크 분해 엔드포인트**
(`POST /tasks`) 와 **signaling relay** (`ws://…/signaling`) 두
역할을 동시에 한다. 정적 서버는 데모 HTML/JS 만 서빙하고, 페이지
자체는 importmap 으로 `esm.sh` 에서 의존성을 받아온다.

## 3. 두 창에서 데모 열기

**창 두 개**를 따로 띄운다 (한 창의 두 탭으로 해도 동작은 하지만 두
창이 Y.js 커서 동기화를 더 잘 보여준다):

```
http://localhost:8801/cowork-poc/index.html
```

같은 LAN 안의 다른 머신 두 대로도 가능 — **Signal** 필드의
`localhost` 만 호스트의 IP 로 바꿔주면 된다.

## 4. 헤더 — 연결 컨트롤

| 필드 / 버튼 | 하는 일 |
|---|---|
| **Name** | 에디터에서 상대 커서 옆에 표시되는 이름. 기본값은 랜덤한 `User-xxxx`; 원하면 수정. |
| **Room** | 두 창이 서로를 찾는 식별 문자열. **반드시 같은 값**을 입력해야 한다. 기본 `cowork-demo`. |
| **Signal** | signaling WebSocket URL. 기본 `ws://localhost:3001/signaling`. |
| **Join** | relay 에 접속, 같은 방 안의 다른 peer 와 WebRTC 핸드셰이크, 데이터 채널 두 개 (Workspace + ACP) 오픈. |
| **Leave** | WebRTC peer connection 닫고 로컬 상태 초기화. |
| **연결 상태 pill** | 실시간 상태: `idle` → `connecting` → `connected` (초록) 또는 `failed` (빨강). |

창 A 에서 먼저 **Join**, 그 다음 창 B 에서 **Join**. 약 1 초 안에 두
pill 이 초록으로 바뀌고 활동 로그에 `channel open:
neoprotocol-workspace` 와 `channel open: neoprotocol-acp` 가 뜬다.

> **pill 이 영영 `connecting` 상태**면: 다른 탭에서
> `chrome://webrtc-internals` 를 열어 SDP/ICE 흐름을 확인. 가장 흔한
> 원인은 **WebRTC 차단 확장**이 ICE candidate 를 잘라먹는 경우.
> 비활성화 후 재시도.

## 5. 에디터 페인 (왼쪽)

CodeMirror 6 에디터, Y.js CRDT 로 단일 JS 문서를 공유. 한 쪽에서 친
글자가 즉시 다른 쪽에서도 보이고, 서로의 커서는 **Name** 라벨과 색깔
flag 로 표시된다.

빈 방에 가장 먼저 들어온 peer 가 작은 시드 문서를 **seed** 한다
(Stage 1 first-joiner rule, SPEC §17.2.2). 나중 들어오는 peer 는
데이터 채널을 통한 Y.js sync 로 받아본다.

## 6. "Your agent (BYOK)" 카드

**내** 개인 에이전트 패널. 상대 peer 는 자기 패널을 따로 가지며
서로 독립이다.

### 6.1 Agent mode 드롭다운

네 가지 백엔드, 모두 동일한 `{reasoning, newDocument}` 계약:

| 모드 | 비고 |
|---|---|
| **OpenAI — gpt-5.4-mini (BYOK)** | 기본값. 브라우저에서 `api.openai.com` 직접 호출, JSON-object 응답. `sk-…` 키 필요. |
| **Anthropic — claude-sonnet-4-6 (BYOK)** | 브라우저에서 `api.anthropic.com` 직접 호출. `sk-ant-…` 키 필요. |
| **Local — Gemma / Llama (WebGPU, in-browser)** | transformers.js v3 로 ONNX 모델을 탭 안에 로드. API 키 불필요, 가중치 캐시 후엔 네트워크 호출도 없음. 아래 **Local model ID** 필드가 추가로 보인다. |
| **Mock (offline; for testing)** | 결정론적 stub — API 키 없거나 네트워크 없이 데모할 때. |

세션 중 모드 전환은 자유. 매 프롬프트마다 드롭다운을 다시 읽는다.
API 키 필드는 `local`/`mock` 모드에서는 자동으로 숨는다.

### 6.2 API 키 필드

OpenAI 면 `sk-…`, Anthropic 이면 `sk-ant-…` 키를 입력. 이 브라우저의
`sessionStorage` 에만 저장 — Originator 로도, peer 로도 **절대 전송
안 됨**. fetch 는 브라우저에서 provider 로 직행한다.

### 6.3 Local model ID (Local 모드에서만 보임)

자유 입력 + `<datalist>` 추천 목록:

| 추천 | 다운로드 크기 (대략) |
|---|---|
| `onnx-community/Llama-3.2-1B-Instruct` (기본값) | ~700 MB (q4f16) |
| `onnx-community/Phi-3.5-mini-instruct-onnx-web` | ~2 GB |
| `onnx-community/gemma-2-2b-it` | ~1.4 GB |
| `onnx-community/gemma-4-E2B-it` | ~3.4 GB (가용 시) |

HuggingFace 의 어떤 ONNX 번들 ID 도 붙여넣을 수 있다. 첫 로드는
가중치 다운로드 (IndexedDB 캐시; 다음 방문부터 즉시 로드). 필드 아래
진행 표시줄이 다운로드 중 실시간 갱신된다.

WebGPU 자동 감지 → `q4f16` 가중치 + `fp16` activation. WebGPU 없으면
wasm + `q4` 로 fallback.

### 6.4 Prompt 텍스트영역

에이전트가 처리할 지시 입력. 예: *"각 함수에 JSDoc 주석을 추가해줘"*.

### 6.5 "Send to peer's agent" 체크박스

**해제 (기본)**: 프롬프트가 **내** 에이전트에서 실행됨 (Stage 1).
**체크**: 프롬프트가 ACP 데이터 채널을 통해 **상대** 에이전트로
전달됨 (Stage 2 — 크로스-에이전트 ACP, SPEC §17.4). 상대 쪽엔 권한
다이얼로그가 뜨고, 그가 허용한 뒤에야 에이전트가 동작한다.

### 6.6 Ask my agent / Cancel

- **Ask my agent**: 요청 시작. WebRTC 채널이 `connected` 이전엔
  비활성.
- **Cancel**: 진행 중인 HTTP fetch (OpenAI/Anthropic) 또는 로컬 모델
  생성 중단.

에이전트가 끝나면:
1. 활동 로그에 `agent → <reasoning 발췌>` 줄 추가.
2. **Agent suggestion** 카드가 diff 미리보기와 함께 등장.

## 7. Permission requested 카드 (Stage 2 전용)

평소엔 숨김. 상대가 *Send to peer's agent* 체크하고 뭔가 물었을 때
**받는 쪽** 화면에 나타난다. 버튼 4 개:

| 버튼 | 효과 |
|---|---|
| **Allow once** | 이 1 회만 허용. 다음 요청은 다시 묻는다. |
| **Allow this session** | 같은 `(peer, agent)` 쌍의 모든 후속 요청을 Leave 할 때까지 자동 허용. |
| **Deny** | 이번 요청만 거부. 다음 요청은 다시 묻는다. |
| **Deny session** | 같은 `(peer, agent)` 쌍의 모든 후속 요청을 Leave 할 때까지 자동 거부. |

Standing grant 의 범위는 `(remote_peer_id, remote_agent_id)` 쌍 단위
— 상대가 자기 에이전트 모드를 바꾸면 grant 가 초기화된다.

## 8. Cowork task 카드 (SPEC §17.8 fan-out)

Coworker 가 자연어 프롬프트를 Originator 에 보내면 multi-leaf Task
Offer 가 돌아오고, 이 offer 가 방 안의 **모든 peer 에 fan-out** 되는
패널.

### 8.1 필드

- **Task prompt 텍스트영역**: 자연어 요청. 기본 Originator stub 은
  `code review|cowork|fan-out|critique|summarize…and…` 패턴을
  `cowork_review` fixture (2-leaf 그래프: `summarize` + `find_issues`
  → `aggregate` reducer) 에 매칭.
- **Decompose & run**: 프롬프트 POST → 워크스페이스 채널에 Y.Map
  mutation 으로 offer 브로드캐스트 → 결정론적 leaf 할당 트리거.
- **Reset**: `task` / `channels` / `leaf_status` Y.Map 초기화 →
  새 태스크 실행 가능.

### 8.2 라이브 상태 블록

태스크 시작 후 버튼 아래에 다음과 같은 표시:

```
Task 5e3f8c1d · status=running · 2 peer(s) · clientIds=[1729384, 4721098] · my clientId=1729384

Leaves & assignments:
  ▸ [L] summarize → client 1729384 ← MINE (openai, …)
  · [L] find_issues → client 4721098 (openai)
  · [R] aggregate → client 1729384 ← MINE
        reads: leaf:summarize, leaf:find_issues
       writes: report

Channels (truncated):
  leaf:summarize: The document defines a tiny utility module …
```

- `▸` = 지금 어떤 peer 에서 실행 중
- `✓` = 완료
- `✗` = 실패 (에러 메시지 함께)
- `·` = 대기 (입력 미충족 또는 내게 미할당)
- `← MINE` = 이 leaf 가 **내** 브라우저에 할당됨

두 peer 가 같은 화면을 보는 이유는 할당이
`sort(clientIds)[hash(leafId) % N]` 로 결정론적이기 때문이다 —
claim-and-race 라운드트립이 없다.

### 8.3 완료 시 동작

reducer (같은 hash 가 가리킨 peer 가 실행) 가 빌트인 `markdown_report`
(또는 offer 가 지정한 다른 reducer) 를 돌리고, 만들어진 마크다운
보고서를 워크스페이스 문서 **맨 위에 prepend**, §17.5 attribution
도장을 찍는다. 두 peer 모두 에디터 상단의 보고서를 보게 되며, leaf
별 attribution (어느 peer/어느 에이전트가 어떤 leaf 를 돌렸는지) 은
보고서 본문에 보존된다.

## 9. Agent suggestion 카드

**Ask my agent** 가 끝나면 등장. 세 부분:

- **Reasoning 텍스트** — 에이전트의 자유 설명.
- **Diff 미리보기** — 현재 문서 vs 제안 문서의 줄 단위
  prefix/suffix-trim diff.
- **Apply** / **Discard** 버튼:
  - **Apply**: 로컬 Y.Doc 에 `applyAgentEdit` (CRDT 친화 최소-변경
    apply) 실행. 편집이 `{agentId, peerId}` attribution 과 함께
    상대에게 전파됨. 상대 UI 에 토스트가 뜬다.
  - **Discard**: 제안 폐기 + 카드 초기화.

> **Diff 는 단순하다.** 문서 중간 삽입의 경우 diff 가 과하게
> 제거+재추가로 표시될 수 있다. 실제 `applyAgentEdit` 는 문자 단위
> 최소-변경 — 에디터에 들어가는 결과는 정확하고, 시각화만 보수적이다.

## 10. Activity 로그

오른쪽 아래 스크롤 패널. 색깔 3 종:

- **시스템 (보라)** — 연결 lifecycle, 채널 상태.
- **Agent (주황)** — 내 에이전트의 프롬프트/결과, 상대 에이전트
  편집의 도착.
- **Peer (청록)** — peer 합류/이탈, raw peer 이벤트.

기대하는 와이어 레벨 이벤트 확인용. 예를 들어 Stage 5 태스크 중엔
다음과 같이 보여야 한다:
```
agent: task: posted prompt, got offer (cowork_review)
agent: task: assigned 1 leaf(s) to me — running summarize
agent: task: leaf summarize done in 3214 ms
agent: task: report prepended (3 leaves, 2 peers)
```

## 11. 정리 / 재시작

- 한쪽 창 **Leave** → 그 쪽은 `idle` 로 초기화. 상대 peer 는 문서
  사본을 그대로 유지하고, 재합류하는 peer 는 그쪽으로부터 재동기화.
- 어떤 탭이든 새로고침 → 그 탭은 로컬 상태 폐기 + 새 peer 로 재합류;
  남은 peer 로부터 문서 재시드.
- 방의 **마지막** 창을 닫으면 문서 손실 (PoC 는 영속화 없음).
- Originator 중지 (터미널 A 의 `Ctrl+C`) → 모든 방 끊김, 신규 합류
  실패.

## 12. 흔한 함정

| 증상 | 가능한 원인 |
|---|---|
| pill 영영 `connecting`, `channel open:` 로그 없음 | WebRTC 차단 확장, 또는 symmetric NAT. v0.3 는 STUN 만 지원 — TURN 은 로드맵. |
| `agent: API key required for openai mode` | API 키 필드 비어있음. 키 붙여넣거나 Mock/Local 로 전환. |
| 두 번째 peer 에서 `task: no nodes assigned to me` | 두 client ID 가 한쪽으로만 hash 됨 — `Reset` 후 재시도, 또는 세 번째 peer 추가. |
| 새로고침 후 문서가 **두 배**로 늘어남 | 이미 시드된 방에 들어가놓고 또 시드한 경우. first-joiner 만 시드해야 함. (Stage 1 에서 fix 했으나 재발하면 버그 리포트 부탁) |
| 로컬 모델 "load failed" | 잘못된 모델 ID 또는 WebGPU/wasm 미호환 번들. [transformers.js v3 모델 목록](https://huggingface.co/models?library=transformers.js&sort=trending) 확인. |
