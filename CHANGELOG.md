# Changelog

All notable changes documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning
per SPEC §10/§14: `neoprotocol/<major>` for the wire protocol.
Pre-v1 the protocol may break at any commit; this CHANGELOG also
tracks the demo / server / spec evolution.

## [Unreleased]

### Added

- **Collaborative Workspace — Stage 2** (SPEC §17.4): cross-agent
  ACP. User A's agent can ask User B's agent for help — the request
  travels P2P over a second multiplexed `RTCDataChannel`
  (`neoprotocol-acp`) on the same `RTCPeerConnection` as the
  Workspace channel. B's UI surfaces a permission dialog with four
  grant choices (`allow_once` / `allow_session` / `deny_once` /
  `deny_session`); standing grants are scoped to the
  `(remote_peer_id, remote_agent_id)` pair. On allow, B's agent
  runs the prompt (BYOK or mock), streams reasoning back via
  `session/update {kind: agent_message_chunk}`, and emits a terminal
  `{kind: candidate_document}` update carrying the proposed full
  document. A's UI renders the suggestion; on Apply, the §17.5
  attribution stamp credits the **remote** peer/agent — the wire
  reflects who actually authored the bytes even though the local
  user pressed the button.
  - `examples/cowork-poc/cross-agent.js` (~230 LOC) — ACP recursion
    sender + receiver halves sharing one `JsonRpcChannel` per
    channel (race-fix from PoC verification: separate channels would
    collide on incoming frames, the empty-handlers half replying
    "method not found" before the populated half).
  - `examples/p2p-acp-poc/peer.js` parameterized for multi-DC mode:
    new `dcLabels: string[]` constructor option, `labeled-channel-open` /
    `labeled-channel-close` events, and a `peer.channel(label)` lookup.
  - SPEC §17.4 promoted to "implemented", expanded with §17.4.1
    shared-channel rule, §17.4.2 from/to peer-agent identity wire
    fields, §17.4.3 streamed candidate-document update kind.

- **Collaborative Workspace — Stage 1** (SPEC §17): two browsers,
  one shared Y.js document, each user has their own BYOK / mock
  agent. Edits propagate with attribution metadata
  (`{agentId, peerId}`) so peer UIs distinguish human vs agent edits.
  Reuses the §16 Federated Mode signaling + WebRTC peer; the
  Workspace channel rides a second `RTCDataChannel` (label
  `neoprotocol-workspace`) multiplexed on the same `RTCPeerConnection`.
  - `examples/cowork-poc/` — runnable reference (CodeMirror 6 + Y.js
    + `yCollab`, ~750 LOC)
  - SPEC §17 first draft — Coworker role, Workspace channel framing,
    first-joiner seed rule, attribution metadata, Stage-2 cross-agent
    permission grant variants (spec only — Stage 2 impl follows)
  - PoC verification caught and pinned a CRDT seed-collision race
    (both peers seeding in parallel produced a doubled document); the
    fix is now in SPEC §17.2.2.
  - `examples/p2p-acp-poc/peer.js` parameterized — `dcLabel`
    constructor option so future demos can multiplex more channels

- **Federated Mode** — browser↔browser ACP-over-WebRTC. Two peers
  establish a P2P `RTCDataChannel` and exchange the Zed Agent Client
  Protocol wire format (JSON-RPC 2.0, NDJSON-style framing) over it.
  - SPEC §16: Federated Mode wire spec — Standard Mode
    (Originator-as-signaling) + Minimal Mode (SDP-via-URL, zero
    runtime server); cross-network ACP safety profile (Virtual Path
    namespace `np://session/<id>/<key>`, mandatory permission gate
    on every `fs/*` callback, DTLS fingerprint surfacing).
  - `server/signaling.js` — WebSocket `/signaling` endpoint on the
    Originator, dumb relay (forwards opaque SDP/ICE between paired
    peers, never inspects ACP traffic).
  - `examples/p2p-acp-poc/` — runnable reference implementation. ~1200
    LOC, ~600 of which is pure protocol; agent is a deterministic
    mock summarizer (offline, no model dependency).
  - `docs/federated-mode.md` — design rationale, trust roles, reasons
    ACP was chosen over A2A, what the implementation deliberately
    doesn't do.
  - SPEC §3 glossary additions (Federated Mode, Driver, Host,
    Signaling, Virtual Path); §12 error code taxonomy gains SIG-* and
    FED-* families.

## v0.3 — 2026-04-27

Spec graduates from "single-leaf draft" to "multi-leaf-ready". Adds
the second independent reference Executor and the first conformance
test suite — three of the four IETF "real protocol" criteria now
satisfied (≥2 interoperating implementations + conformance suite +
spec + reference impl).

### Added

- **Conformance suite** (`conformance/originator/level0/`) — language-
  neutral self-certification harness, 18 test cases, reference
  Originator passes 18/18. (`a3c66ea`)
- **Second independent reference Executor** (`examples/python-executor/`):
  Python + optimum + ONNX Runtime native CPU. Same q8 ONNX bytes as
  the browser, identical scores, same envelope shape accepted by the
  same Originator. (`25db061`)
- Spec §3 Glossary, §4 Transport, §5 expanded Sequence Diagrams (4
  scenarios — single-leaf, multi-leaf fan-out, conditional routing,
  interrupt-resume), §12 structured Error Codes (20 codes with
  EX-/OR-/PR- prefix taxonomy + HTTP status mapping), §13 Reliability
  (retry policy, timeouts, integrity, idempotency keys). (`11bb7de`)
- Spec §2 Conformance Levels (0/1/2/3), §7 Graph Semantics (channels,
  reducers, conditional edges, interrupt_before), §8 Node
  Implementation Models (A: server-described, B: executor-registered),
  §9 Capability Statement. (`7265e66`)

### Changed

- License: MIT → Apache 2.0 with explicit patent grant + retaliation
  clause. NOTICE file added. (`c68e7e1`)

## v0.2 — 2026-04-26

Closes the loop: a real Originator server with NL → graph
decomposition (stub for now), browser PoC wired to it via
`?server=URL`, full round-trip with server-side ajv schema
validation + defense-in-depth `data_locality` enforcement.

### Added

- Browser PoC's `?server=URL` mode: prompt textarea → POST /tasks →
  offer received → leaves run → POST /tasks/:id/results → server ack
  shown to user. (`cbdf406`)
- `server/` Originator skeleton: Express + ajv + 5 endpoints
  (`POST /tasks`, `GET /tasks/:id`, `GET /tasks/:id/data`,
  `POST /tasks/:id/results`, `GET /healthz`). 14-case smoke suite
  covers malformed envelope, tainted envelope (non-whitelisted
  field stripping), task_id mismatch. (`083276e`)
- JSON Schemas: `task_offer.json`, `result_envelope.json`. (`083276e`)

## v0.1 — 2026-04-26

Three concurrent runtime kinds in the consent UI; protocol now
expresses "the same leaf can run via local model, your own API key,
or browser built-in AI — your call".

### Added

- `runtime_kind` discriminator in `model_options`: `local_onnx`,
  `byok_api`, `browser_builtin`. Picker walks the prefs and skips
  unsafe combos. (`7a6d201`)
- Browser Built-in AI (`window.LanguageModel`) feature detect +
  graceful disable when unavailable. (`7a6d201`)
- BYOK consent modal: API key entry, sessionStorage only, never
  posted to Originator. (`7a6d201`)
- PLAN.md milestone roadmap. (`384db27`)

### Fixed

- transformers.js v3 `dtype: "q8" + device: "webgpu"` silent-garbage
  trap. Picker hard-skips this combo (q8 → WASM only, WebGPU → fp16).
  Verified end-to-end via Playwright after the fix. (`8248bef`)

## v0 — 2026-04-26

Initial spec, demo, and Originator skeleton.

### Added

- SPEC.md: Roles, Message Flow, Task Offer, Result Envelope, Consent
  UI requirements, Versioning, Out of Scope.
- `examples/sentiment-poc/`: single-page browser demo with consent
  UI, transformers.js + DistilBERT-SST2 (q8 ~17MB), 12 sample
  reviews, result envelope construction with `data_locality`
  whitelist enforcement.
- README + LICENSE (MIT at this point — switched to Apache 2.0 in
  v0.3). (`26dd8e8`)
