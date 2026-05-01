# Collaborative Workspace — Vision & Roadmap

> **Status: vision document. Stages 1–2 committed; Stages 3–5
> conditional on the prior stage shipping a demo people respond to.**
>
> Companion docs: [SPEC.md](../SPEC.md) (the wire),
> [docs/federated-mode.md](federated-mode.md) (Federated Mode design),
> [PLAN.md](../PLAN.md) (overall milestones).

This document captures what NeoProtocol is for at the maximum scope
of the current vision, and how we get there incrementally without
turning a protocol project into an IDE-fork project.

---

## 1. The vision in one paragraph

> Two or more people open the same web URL. No install, no
> extension, no account on a central service. Each person's browser
> runs **their own agent** (a small local model in WebGPU, or BYOK
> against their preferred frontier API). The agents and the humans
> share a workspace — files, edits, terminals, diffs — that is
> synchronized peer-to-peer over a CRDT. Each agent can talk to
> the others through ACP with explicit permission. There is no
> central place where the code or the conversation lives.

Compare this against today's positioning:

| Product | "Where does my work live?" | "Whose agent helps me?" |
|---|---|---|
| Cursor / Copilot | local files + their cloud | their cloud agent |
| Replit / Codespaces | their cloud workspace | their cloud agent |
| VS Code Live Share | Microsoft relay (server) | none (humans only) |
| Claude Cowork / Notion-style | their server | their cloud agent |
| **NeoProtocol Workspace** | **my browser + your browser, P2P** | **my agent + your agent, peer-to-peer with consent** |

The empty quadrant in this table is what we are aiming at.

---

## 2. Why this is the right maximum demo for NeoProtocol

The thesis of NeoProtocol since v0 has been **"compute partitioning,
raw data stays client-side."** That thesis is most loudly true when:

- Multiple humans are involved (single-user demos let the audience
  default to "isn't this just an IDE feature?").
- Multiple agents are involved (single-agent demos let the audience
  default to "isn't this just Cursor?").
- No central server has the data (otherwise the audience defaults to
  "isn't this just a hosted SaaS with extra steps?").

Collaborative Workspace satisfies all three at once. It is the
maximally legible expression of the protocol.

It also reuses primitives we have already proven:

| Primitive | Status | Where |
|---|---|---|
| Federated Mode (browser↔browser via WebRTC) | ✅ shipped, PoC verified end-to-end | SPEC §16, `examples/p2p-acp-poc/` |
| ACP wire format with bidirectional callbacks | ✅ shipped | `examples/p2p-acp-poc/acp.js`, neograph::acp |
| Virtual Path namespace + permission gate | ✅ shipped, 22-case unit pin | SPEC §16.4 |
| Originator-as-signaling rendezvous | ✅ shipped | `server/signaling.js` |
| BYOK runtime per-user | ✅ shipped (v0.1) | SPEC §8 / sentiment-poc |

We do not need to invent new transports, new framing, or new
permission semantics. We need to compose what we already have with
**(a)** a CRDT for shared workspace state and **(b)** a small
extension to ACP for agent ↔ agent calls.

---

## 3. Stage breakdown

Five stages, each with a standalone-watchable demo at the end. Each
stage is a go/no-go gate for the next: if the demo doesn't make
people lean forward, we either fix it or stop, rather than bulldozing
into the next stage on momentum.

### Stage 1 — "Living document with two agents" *(committed, ~1–2 weeks)*

**Demo goal.** Two browsers open the same URL. They join a room
(reusing the Federated Mode signaling). A single Monaco editor in
each browser shares one document via Y.js + WebRTC provider. Both
users type live; CRDT handles conflicts. Each user has an "ask my
agent" prompt box (BYOK only at this stage). User A asks for an
edit; A's agent reads the buffer, returns a suggested patch; user A
applies it; user B sees the change appear with attribution
("A's agent suggested this — A applied").

**What it proves.**
1. NeoProtocol's signaling channel doubles as Y.js sync transport
   (no separate Yjs server needed — y-webrtc rides our
   `RTCDataChannel`).
2. Each user's local agent is a first-class participant in the
   shared document, not a side cloud service.
3. The asymmetry is correct: each user owns their agent, sees their
   agent's suggestions, and decides what propagates.

**Deliverables.**
- `examples/cowork-poc/` — Monaco + Y.js + agent prompt UI
- `server/signaling.js` extension — relay y-webrtc-shaped frames
  alongside SDP/ICE (or just let y-webrtc open its own data channel
  on the same RTCPeerConnection — preferred)
- SPEC §17 first draft — Workspace channel definition
- 1 Playwright PoC test driving the two-tab flow (extends
  existing `examples/p2p-acp-poc` harness)

**Out of scope (Stage 1 only).** Multi-file workspace. Local model.
File system. Agent-to-agent calls.

**Demo sentence.** "Two strangers, two browsers, no install. Each
has their own agent. They cowrite a function. Neither agent ever
talked to a server we control."

---

### Stage 2 — "Cross-agent ACP" *(committed, ~1–2 weeks)*

**Demo goal.** Same setup as Stage 1. User A's agent decides it
needs help from User B's agent ("B's agent specializes in
performance review — let me ask"). A's browser issues an ACP request
through A's user, which routes it to B's user. B's UI shows a
permission dialog: *"User A's agent wants to ask your agent: 'review
this function for hot-loop allocations'. Allow? (one-time / this
session / never)"*. B clicks allow → B's agent runs the request →
result flows back to A's agent → A's agent incorporates and presents
to A.

**What it proves.**
1. ACP's bidirectional callback model is sufficient for agent ↔
   agent coordination — no new wire required, just **ACP recursion**:
   B's agent acts as an ACP "agent" to A's agent acting as ACP
   "client", but always mediated through A's user and B's user.
2. The permission gate from §16.4 extends naturally to multi-agent.
   Every cross-user agent call has a fresh consent surface.
3. The Virtual Path namespace generalizes: now we have
   `np://session/<id>/agent_response/<n>` for cross-agent
   intermediate results.

**Deliverables.**
- ACP "AgentMesh" extension — small spec addition for per-user
  routing of agent-to-agent requests
- SPEC §17 second pass — collaborative session lifecycle
- Permission UI variant: `allow_once` / `allow_session` /
  `allow_per_path` outcomes (extends `session/request_permission`)
- `examples/cowork-poc/` updated demo: a "send to peer's agent"
  button in each agent's response card

**Out of scope (Stage 2 only).** Local model. Multi-file
workspace. File system access.

**Demo sentence.** "Watch A's agent decide it needs B's agent's
help, and watch B click 'allow' to let that happen. Two agents
cooperated. No central agent service was involved."

---

### Stage 3 — "Real workspace" *(conditional, ~2–4 weeks)*

**Demo goal.** Same room, but each user opens a real folder using
the browser File System Access API. File tree, multi-buffer (Monaco
multi-model), syntax-aware diffs. Agents get workspace context (open
files, recent edits) bounded by Virtual Path scope. Edits sync via
Y.js per-file documents.

**What it proves.**
1. Virtual Path → real-file mapping is safe under
   `FileSystemDirectoryHandle` sandboxing. The agent never sees a
   path outside the user's chosen folder, even if it tries.
2. The PoC shape is now indistinguishable from a "real IDE feature"
   for outside observers — but it runs in the browser with no
   extension.

**Deliverables.**
- File tree + multi-buffer editor
- File System Access API wrapper that maps `np://session/X/
  workspace/<path>` to `<chosenDir>/<path>` with strict containment
  checks
- SPEC §17.3 — real-file mapping safety profile
- Chromium-only at this stage; document that as a known limit

**Out of scope (Stage 3 only).** Terminals, debuggers, extensions.
Firefox support.

**Risk.** File System Access API is Chromium-only. Firefox and
Safari users hit a "browser unsupported" wall at the demo. Mitigation:
in-memory fallback for non-Chromium browsers (snapshot upload /
download).

**Demo sentence.** "We just opened a real Git repo in the browser.
No extension. The agent only sees what we let it. Edits are P2P."

---

### Stage 4 — "Local model option" *(conditional, ~2–3 weeks)*

**Demo goal.** Same demo as Stage 3, but the BYOK toggle in each
agent panel can be flipped to "local model": transformers.js v3 +
WebGPU + a small coding model (Gemma 2B / Qwen 0.5B-coder /
Phi-3-mini). Demo shows a non-trivial workflow that completes purely
on local compute.

**What it proves.**
1. The "no extension, no install, your compute" thesis can run all
   the way down to the model weights — there is no vendor cloud
   anywhere in the loop.
2. NeoProtocol's runtime-kind discriminator (`local_onnx`,
   `byok_api`) covers the local-model case from v0.1.

**Deliverables.**
- transformers.js + WebGPU integration in the agent panel
- Honest documentation of the quality gap vs Cursor (Gemma 2B is
  not Sonnet); position as a "good enough for explain / refactor /
  test-stub" tier, with BYOK as the heavy-lifting tier
- Pre-cached model bundle to avoid 50–500 MB first-visit downloads
  ruining the demo

**Risk.** Local-model coding quality is not at parity with frontier
APIs. The demo has to pick tasks the local tier can do well
(rename refactor, doc-comment generation, test-stub creation, code
explain) rather than tasks where it visibly fails (architectural
suggestions, complex bug hunts).

**Demo sentence.** "Now offline. Both browsers are running a 2B
parameter model in WebGPU. Watch the same workflow happen with no
network at all."

---

### Stage 5 — "Editor surface upgrade decision" *(months, conditional)*

If Stages 1–4 produce demos that resonate (people sharing them,
asking for access, opening issues), this is where we evaluate
whether to invest in a richer editor surface. Options ranked by
cost:

| Option | Cost | What we get |
|---|---|---|
| Stay on Monaco + custom UI | low | Proven path. Limit is "feels like a toy IDE" |
| Theia / OpenVSCode-Server adoption | medium | Real IDE shell (file tree, terminals, debug) without forking |
| code-server fork | medium-high | Full VSCode-the-app, but tied to its assumptions |
| **VSCode source fork** | **very high (6–12 months)** | Total control, but a 1–2 person team disappears into it |

**Recommendation, written in advance.** Stay on Monaco-plus-custom-UI
unless and until a specific limit becomes the bottleneck. A VSCode
fork is the wrong default for a protocol-first project; it would
suck attention from spec work for half a year.

**Decision criteria, set now to be honest later.** We escalate to
Theia/OpenVSCode-Server only if Stage 4's demo gets >100 GitHub
stars and >10 unsolicited "I would use this for X" issues. We do
not consider a VSCode fork without an external partner committed to
the IDE side specifically.

---

## 4. Protocol-side work that Stages 1–2 unlock

The IDE side of the demo is the visible part. The interesting
durable contribution is the **protocol** — what gets added to the
SPEC because of what Stages 1–2 force into existence.

### 4.1 SPEC §17 — Collaborative Workspace (new)

Outline (drafted during Stage 1, finalized during Stage 2):

- **§17.1** Roles (Coworker = peer with both Driver and Host
  capabilities; same person owns both halves)
- **§17.2** Workspace channel — Y.js document(s) over the same
  WebRTC data channel as ACP, multiplexed by frame discriminator
- **§17.3** Real-file mapping safety profile (deferred to Stage 3
  but slot reserved)
- **§17.4** Cross-agent permission grants — `allow_once` /
  `allow_session` / `allow_per_path` / `revoke` (Stage 2)
- **§17.5** Attribution — every edit carries `(peer_id, agent_id?)`
  so users see who/what authored what

### 4.2 Federated Mode multi-peer

SPEC §16.8 already lists "multi-host fan-out" as deferred. Stages
1–2 force us to graduate the signaling relay from "1 host + 1
driver per room" to "N peers per room with explicit role tagging."
Most of this is already supported by `signaling.js` (8-peer cap, role
tag in `peer_joined`); what's missing is the demo-level pairing
logic. Light spec work, ~half a day of code.

### 4.3 ACP recursion

A peer's agent making an ACP request to another peer's agent is
not a new wire — it is ACP frames carried over an inner ACP
session, with the user's permission gate at the boundary. We need
to write that down explicitly so external implementers know the
recursive shape is intended (and not a hack).

---

## 5. Risks taken seriously

| Risk | Why real | Mitigation |
|---|---|---|
| Scope explosion into IDE-fork territory | "Just one more IDE feature" pulls forever | Stage 5 gating; Recommendation written in advance to say "no" |
| Local-model quality gap vs frontier | Gemma 2B ≠ Claude Sonnet | BYOK is the default in Stages 1–3; local model is Stage 4 toggle, demo tasks chosen for local-tier strengths |
| Symmetric NAT blocks Federated Mode | ~5–10% of network setups | Stage 1 PoC documents the limit honestly; v1 adds TURN policy or relay fallback |
| Browser File System Access API = Chromium only | Firefox/Safari users hit a wall | Stages 1–2 don't need it; Stage 3 documents Chromium requirement; Stage 3.5 adds in-memory fallback |
| Permission UX dialog spam | "Agent X wants to do Y" every keystroke = unusable | `allow_session` / per-path scope from Stage 2; this is on the spec |
| Trust model muddied if signaling server starts handling Y.js too | "But the server has the document!" | y-webrtc opens its own data channel through the same RTCPeerConnection; SPEC §17.2 makes the data-plane vs signaling-plane separation explicit |
| Demo brittleness (live coding demos fail at conferences) | Famous failure mode | Each stage ships a recorded reference walk-through alongside the live demo |

---

## 6. Out of scope (now and probably forever)

These are explicitly **not** ambitions of NeoProtocol Workspace:

- **Replacing VS Code**, Cursor, Replit, or any existing IDE. We are
  defining a protocol that any of them could implement; we are not
  trying to be one of them.
- **Hosted service for casuals.** Anyone can host their own
  Originator (or skip it entirely with Minimal Mode). We are not
  going to operate `cowork.neoprotocol.io` as a product.
- **Built-in code review / PR / Git workflow.** These layer on top
  of the workspace — they're not protocol-level.
- **Voice / video.** WebRTC supports them; that's an application
  choice on top of the protocol, not a protocol concern.
- **Authentication / identity.** v0.3 rooms are unauthenticated. v1
  adds room tokens. Cross-org identity (signed Capability
  Statements, federated identity) is v2 territory and may never
  ship if the demo doesn't demand it.

---

## 7. Commitment ledger

| Stage | Status | Owner | Target |
|---|---|---|---|
| 1 — Living document with two agents | **✅ shipped** (`examples/cowork-poc/`, SPEC §17) | — | done |
| 2 — Cross-agent ACP | **✅ shipped** (`examples/cowork-poc/cross-agent.js`, SPEC §17.4) | — | done |
| 3 — Real workspace | conditional on Stage 2 demo response | — | TBD |
| 4 — Local model option | conditional on Stage 3 | — | TBD |
| 5 — Editor surface upgrade | conditional on Stages 1–4 traction | — | TBD |

**Stage 2 — what we learned (from the PoC verification run, 2026-05-01):**

- ACP recursion really is just ACP. We didn't need a new wire
  format for "agent A asks agent B" — the existing §16 JSON-RPC
  framing carries it, with two new optional `fromPeerId` /
  `fromAgentId` params on `initialize` and `session/new` so the
  asker identifies themselves for the permission UI and for §17.5
  attribution.
- **Shared `JsonRpcChannel` rule** discovered the hard way: when
  both peers run a sender AND a receiver on the same data channel
  (because every Coworker can ask AND be asked), instantiating two
  `JsonRpcChannel` objects on one `RTCDataChannel` makes both listen
  to every frame; the sender (no request handlers) replies
  "method not found" before the receiver responds. Fix is now
  SPEC §17.4.1: one channel per DC, both halves register on it.
- **`candidate_document` update kind**: extending the Zed ACP enum
  was lighter than a separate fetch round-trip. Receiver streams
  `agent_message_chunk` reasoning (free-form), then emits a single
  terminal `{kind: candidate_document, document: "..."}`. Asker
  applies through the same `applyAgentEdit` codepath as Stage 1; the
  attribution stamp uses the remote peer/agent IDs so the wire
  records the actual author.
- Permission grant scope is `(remote_peer_id, remote_agent_id)` —
  not per-method, not per-path. Per-path lives in §17.4
  `allow_per_path` reserved for Stage 3 when there are multiple
  Virtual Paths in flight per session.

**Stage 1 — what we learned (from the PoC verification run, 2026-05-01):**

- Multiplexing Y.js + future ACP onto two separate `RTCDataChannel`s on
  the same `RTCPeerConnection` is clean — backpressure isolation, no
  framing collision, both channels open in parallel after the SDP/ICE
  handshake.
- Custom Y.js provider over our existing data channel is ~110 LOC.
  Beats `y-webrtc` (which would have brought its own signaling
  server) for our use case.
- **CRDT seed-collision race**: both peers calling
  `yText.insert(0, STARTER_DOC)` in parallel after channel open
  produced a doubled document because Y.js correctly preserved both
  inserts. The fix (only the first joiner seeds, and only after
  `sync_step2` confirms an empty doc) is now in SPEC §17.2.2.
- Edit attribution as a `Y.Map` mutation in the same transaction as
  the text edit — works reliably; receiving peers observe the meta
  key change and surface a toast. Pattern carries over to Stage 2 for
  cross-agent grants.
- esm.sh + transitive deps requires an explicit importmap to avoid
  loading multiple yjs / @codemirror/state instances. Documented in
  `examples/cowork-poc/index.html`.

When a stage ships, update PLAN.md with the milestone row, link the
demo here, and write a short "what we learned" note before
committing to the next stage.

---

## 8. Naming

The PoC directory will be `examples/cowork-poc/` — short, evokes
"coworking", differentiates from the existing `examples/p2p-acp-poc/`
which it builds on.

If a marketing name is needed later: **NeoProtocol Workspace** for
the product surface, **Workspace channel** for the SPEC §17 wire
addition. We will not use "Cowork" as a brand because it overlaps
with Anthropic's "Claude Cowork."
