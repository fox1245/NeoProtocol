# Cowork PoC — Usage Guide (English)

Step-by-step walkthrough of how to start the demo and what every button,
field, and panel in the UI does. Korean version: [USAGE.ko.md](./USAGE.ko.md).

For the design narrative (what each Stage demonstrates, how it relates to
SPEC §16 / §17), see [README.md](./README.md). This document is the
operator-facing companion.

---

## 1. Prerequisites

- Node.js ≥ 18 (for the Originator + signaling relay).
- A modern Chromium-based browser (Chrome, Edge, Brave, Arc). Firefox /
  Safari should work but Stage 1+ has only been verified on Chromium.
- Optional: an **OpenAI** or **Anthropic** API key, if you want real LLM
  output rather than the offline mock or local in-browser model.
- Optional but **important** for connection success: disable any browser
  extension that blocks WebRTC (e.g. *WebRTC Leak Prevent*). Such
  extensions strip ICE candidates and the data channel can never open.

## 2. Start the two servers

Open two terminals from the repo root:

```bash
# Terminal A — the Originator (Express + the /signaling WebSocket relay)
cd server
npm install         # first run only
npm start           # → listens on http://localhost:3001
```

```bash
# Terminal B — a static file server for the demo HTML
cd examples
python3 -m http.server 8801   # → serves at http://localhost:8801
```

Leave both running. The Originator hosts both the **task decomposition
endpoint** (`POST /tasks`) and the **signaling relay** (`ws://…/signaling`).
The static server only ships the bundled HTML/JS; the demo page itself
loads dependencies from `esm.sh` via the importmap.

## 3. Open the demo in two windows

Open **two separate windows** (two tabs in the same window also works,
but two windows make the Y.js cursor sync more obvious):

```
http://localhost:8801/cowork-poc/index.html
```

You can also open the URL on two different machines on the same LAN —
just replace `localhost` in the **Signal** field with the host's IP.

## 4. Header — connection controls

| Field / button | What it does |
|---|---|
| **Name** | Display name shown next to your remote cursor in the editor. Pre-filled with a random `User-xxxx`; edit if you want. |
| **Room** | Rendezvous string. Both windows must use the **same value** to find each other. Default `cowork-demo`. |
| **Signal** | URL of the signaling WebSocket. Default `ws://localhost:3001/signaling`. |
| **Join** | Connects to the relay, performs the WebRTC handshake with the other peer in the same room, opens both data channels (Workspace + ACP). |
| **Leave** | Closes the WebRTC peer connection and resets local state. |
| **Connection pill** | Live status: `idle` → `connecting` → `connected` (green) or `failed` (red). |

Click **Join** in window A first, then **Join** in window B. Within ~1 s
both pills should turn green and the activity log will show
`channel open: neoprotocol-workspace` and `channel open: neoprotocol-acp`.

> **If the pill stays on `connecting` forever**: open
> `chrome://webrtc-internals` in another tab to see the SDP/ICE flow. The
> single most common cause is a **WebRTC-blocking extension** stripping
> ICE candidates. Disable it and retry.

## 5. Editor pane (left)

A CodeMirror 6 editor showing a single shared JavaScript document via
Y.js CRDT. Whatever you type appears in the other peer's editor in
real time, and each peer sees the other's cursor with their **Name**
and color flag.

The first peer to join an empty room **seeds** a small starter document
(Stage 1 first-joiner rule, SPEC §17.2.2). Later peers receive it via
Y.js sync over the data channel.

## 6. "Your agent (BYOK)" card

This is **your** personal agent panel. The peer has their own — they're
independent.

### 6.1 Agent mode dropdown

Four backends, all using the same `{reasoning, newDocument}` contract:

| Mode | Notes |
|---|---|
| **OpenAI — gpt-5.4-mini (BYOK)** | Default. Browser-direct call to `api.openai.com`, JSON-object response. Requires an `sk-…` key. |
| **Anthropic — claude-sonnet-4-6 (BYOK)** | Browser-direct call to `api.anthropic.com`. Requires an `sk-ant-…` key. |
| **Local — Gemma / Llama (WebGPU, in-browser)** | Loads an ONNX model into the tab via transformers.js v3. No API key, no network calls after the weights are cached. Reveals a **Local model ID** field below. |
| **Mock (offline; for testing)** | Deterministic stub — useful when you have no API key or want to demo without network. |

Switching mode mid-session is allowed; the dropdown is re-read on every
prompt. The API-key field hides itself in `local` and `mock` modes.

### 6.2 API key field

Type your `sk-…` (OpenAI) or `sk-ant-…` (Anthropic) key here. Stored in
this browser's `sessionStorage` only — it is **never** sent to the
Originator and **never** sent to the peer. The fetch goes directly from
your browser to the provider.

### 6.3 Local model ID (visible only in Local mode)

Free-form text input plus a `<datalist>` of suggestions:

| Suggestion | Approx. download |
|---|---|
| `onnx-community/Llama-3.2-1B-Instruct` (default) | ~700 MB (q4f16) |
| `onnx-community/Phi-3.5-mini-instruct-onnx-web` | ~2 GB |
| `onnx-community/gemma-2-2b-it` | ~1.4 GB |
| `onnx-community/gemma-4-E2B-it` | ~3.4 GB (if available) |

You can paste any HuggingFace ONNX bundle ID. First load downloads
weights (cached in IndexedDB; subsequent visits load instantly). The
progress line below the field updates live during download.

WebGPU is auto-detected → `q4f16` weights + `fp16` activations. Falls
back to wasm + `q4` if WebGPU isn't available.

### 6.4 Prompt textarea

Type the instruction you want the agent to act on, e.g. *"add JSDoc
comments to each function"*.

### 6.5 "Send to peer's agent" checkbox

If **unchecked** (default): the prompt runs on **your** agent (Stage 1).
If **checked**: the prompt is forwarded over the ACP data channel to the
**peer's** agent (Stage 2 — cross-agent ACP, SPEC §17.4). The peer sees
a permission dialog before their agent runs anything.

### 6.6 Ask my agent / Cancel

- **Ask my agent**: starts the request. Disabled until the WebRTC
  channel is `connected`.
- **Cancel**: aborts the in-flight HTTP fetch (OpenAI / Anthropic) or
  in-progress local-model generation.

When the agent finishes you'll see:
1. Activity-log line `agent → <reasoning excerpt>`.
2. The **Agent suggestion** card appears with a diff preview.

## 7. Permission requested card (Stage 2 only)

This card is hidden by default. It appears on the **receiver's** screen
when the peer ticked *Send to peer's agent* and asked something. Four
buttons:

| Button | Effect |
|---|---|
| **Allow once** | This single request is allowed. Future requests still prompt. |
| **Allow this session** | All future requests from this same `(peer, agent)` pair are auto-allowed until you Leave. |
| **Deny** | This request is denied; future requests still prompt. |
| **Deny session** | All future requests from this `(peer, agent)` pair auto-denied until you Leave. |

Standing grants are scoped to the pair `(remote_peer_id,
remote_agent_id)` — flipping the peer's agent mode resets the grant.

## 8. Cowork task card (SPEC §17.8 fan-out)

This panel lets a Coworker submit a NL prompt to the Originator, which
returns a multi-leaf Task Offer that is then **fanned out across all
peers in the room**.

### 8.1 Fields

- **Task prompt textarea**: the natural-language request. The default
  Originator stub matches `code review|cowork|fan-out|critique|summarize…and…`
  to the `cowork_review` fixture (a 2-leaf graph: `summarize` +
  `find_issues` → `aggregate` reducer).
- **Decompose & run**: POSTs the prompt, broadcasts the offer through
  the workspace channel as a Y.Map mutation, and triggers deterministic
  leaf assignment.
- **Reset**: clears `task` / `channels` / `leaf_status` Y.Maps so you
  can run a fresh task.

### 8.2 Live status block

Below the buttons, after a task starts, you'll see something like:

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

- `▸` = running on a peer right now
- `✓` = complete
- `✗` = failed (with error message)
- `·` = pending (waiting on inputs or not assigned to me)
- `← MINE` = this leaf was assigned to **your** browser

Both peers see the same view because the assignment is computed
deterministically from `sort(clientIds)[hash(leafId) % N]` — there is
no claim-and-race step.

### 8.3 What happens at completion

The reducer (assigned to whichever peer the same hash points to)
executes the built-in `markdown_report` (or whatever the offer
specified), prepends the resulting markdown report to the workspace
document, and stamps the edit with §17.5 attribution. Both peers see
the report at the top of the editor; per-leaf attribution (which peer /
which agent ran each leaf) is preserved in the report body.

## 9. Agent suggestion card

Appears after **Ask my agent** finishes. Three components:

- **Reasoning text** — the agent's free-form explanation.
- **Diff preview** — line-level prefix/suffix-trim diff of
  current document vs proposed document.
- **Apply** / **Discard** buttons:
  - **Apply** runs `applyAgentEdit` (CRDT-friendly minimal-change
    apply) on your local Y.Doc. The edit propagates to the peer with
    `{agentId, peerId}` attribution metadata. The peer's UI flashes a
    toast.
  - **Discard** drops the suggestion and clears the card.

> **Diff is naive.** Mid-document insertions can over-mark the diff as
> remove+readd. The actual `applyAgentEdit` uses character-level
> minimal change — what lands in the editor is correct, only the
> visualization is conservative.

## 10. Activity log

Bottom-right scrolling pane. Three colors:

- **System (purple)** — connection lifecycle, channel state.
- **Agent (orange)** — your agent's prompts/results, peer's agent
  edits landing.
- **Peer (teal)** — peer joined / left, raw peer events.

Use it to confirm the wire-level events you'd expect. For example,
during a Stage 5 task you should see:
```
agent: task: posted prompt, got offer (cowork_review)
agent: task: assigned 1 leaf(s) to me — running summarize
agent: task: leaf summarize done in 3214 ms
agent: task: report prepended (3 leaves, 2 peers)
```

## 11. Cleanup / restart

- **Leave** in either window → that side resets to `idle`. The other
  peer keeps its copy of the doc and rejoiners will re-sync from
  whoever's still in the room.
- Refresh either tab → that tab discards local state but rejoins as a
  new peer; the doc is reseeded from the surviving peer.
- Closing the **last** window in a room loses the document (no
  persistence in the PoC).
- Stop the Originator (`Ctrl+C` in Terminal A) → all rooms drop and
  no new joins succeed.

## 12. Common gotchas

| Symptom | Likely cause |
|---|---|
| Pill stuck on `connecting`, no `channel open:` log | WebRTC-blocking extension, or symmetric NAT. STUN-only in v0.3 — TURN is roadmap. |
| `agent: API key required for openai mode` | API-key field empty. Either paste a key or switch to Mock / Local. |
| `task: no nodes assigned to me` on second peer | Your client IDs hashed onto only one side — try `Reset` and rerun, or add a third peer. |
| Document **doubles** on reload | You've rejoined into an already-seeded room and somehow re-seeded. Make sure only one peer is the first joiner. (Stage 1 fixed this; if it returns, file a bug.) |
| Local model "load failed" | Bad model ID, or the bundle isn't WebGPU/wasm-compatible. Check the [transformers.js v3 model list](https://huggingface.co/models?library=transformers.js&sort=trending). |
