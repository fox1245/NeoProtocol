# NeoProtocol — Specification

> **Status: v0 draft, evolving toward v1.** Pre-v1 the wire format may
> break at any time; major bumps are documented in `CHANGELOG.md` and
> in §15 below. v1 is the stability commitment.

> Items marked **(v0)** ship today. Items marked **(v0.3)** are
> spec-only at this point — server + executor implementations land
> alongside the multi-leaf demo.

---

## 1. Roles

- **Originator** — sends Task Offers. Typically a server holding a
  frontier model that decomposes a user request into a graph.
- **Executor** — receives Task Offers, surfaces consent UI, runs the
  leaves it agrees to, returns a Result Envelope. Typically a browser
  tab, but the role isn't a server-vs-client claim — a Python process
  running an agent framework can be either or both.
- **End User** — drives consent decisions on the Executor side.

---

## 2. Conformance Levels

Single wire format, opt-in features. Modeled after HTTP/2 optional
extensions, not version forks. An Executor declares its maximum level
in the Capability Statement (§9); the Originator MUST NOT emit offers
exceeding the declared level.

> **Note.** Federated Mode (§16) is **orthogonal** to conformance
> levels. A peer at any Level 0–3 MAY participate in Federated Mode;
> Federated Mode just changes how leaves get distributed across two
> or more Executors. The Task Offer / Result Envelope contracts
> (§§6, 10) are unchanged — only the transport between Executors
> changes.

### Level 0 — Single-Leaf
- `graph.nodes` has exactly 1 leaf node, `graph.edges` is `[]`
- One consent gate (offer-level)
- `data_locality.returns_to_originator` whitelist enforced
- Result Envelope `status ∈ {completed, declined, failed}`

### Level 1 — Multi-Leaf Static
- Multiple nodes connected by `edges`
- Sequential and fan-out topologies
- Channel reducers: `append` only
- All edges static (no `when` predicate)
- Single offer-level consent gate

### Level 2 — Conditional Routing
- Conditional edges with `when` predicate
- Channel reducers: `append`, `replace`, `sum`, `set_merge`
- Routing decisions made by the Executor at runtime

### Level 3 — Stateful with Interrupts
- `interrupt_before: ["node_a", ...]` per-node consent gating
- Executor pauses, surfaces a fresh consent UI per leaf
- Result Envelope MAY carry `resumption_token` for tab-close resume

### Implementation expectations
| Level | Realistic minimum runtime |
|------:|---------------------------|
| 0 | ~150 LOC pure JS / Python / any language |
| 1 | Graph executor with channels + reducers (NeoGraph, LangGraph + adapter, Burr, Pydantic-AI Graph) |
| 2 | Same + conditional dispatch |
| 3 | Same + interrupt-resume + checkpoint persistence |

---

## 3. Glossary

| Term | Meaning |
|---|---|
| **Originator** | Party that decomposes a user request into a Task Offer. Sends offers; receives result envelopes. |
| **Executor** | Party that receives Task Offers, runs leaves, returns Result Envelopes. |
| **Task Offer** | JSON document from Originator → Executor describing a delegated computation graph. (§6) |
| **Result Envelope** | JSON document from Executor → Originator carrying outcomes. (§10) |
| **Capability Statement** | JSON document from Executor → Originator declaring supported features. (§9) |
| **Graph** | The DAG of leaf nodes inside a Task Offer. Has `nodes`, `edges`, optionally `channels` and `interrupt_before`. |
| **Leaf** | A single bounded operation node — classify, extract, embed, etc. Always has a `runtime` and an `implementation`. |
| **Channel** | Named state slot read/written by leaves. Has a reducer that defines how concurrent writes merge. |
| **Reducer** | Function (`append`, `replace`, `sum`, `set_merge`) defining channel write merge semantics. |
| **Runtime** | Where a leaf executes — `client`, `server`, or `byok`. Affects who pays for compute. |
| **Runtime kind** | How the runtime executes — `local_onnx`, `byok_api`, `browser_builtin`, etc. Implementation detail under a Runtime. |
| **Implementation model** | Model A (server-described) vs Model B (executor-registered). See §8. |
| **Conformance Level** | 0–3 capability tier per §2. Executor declares; Originator respects. |
| **Consent gate** | UI surface where the End User accepts/declines/amends an offer or interrupt. |
| **Data locality** | Field in the offer that constrains what may leave the Executor. (§6.2) |
| **Federated Mode** | Two or more Executors cooperating on the same Task Offer over P2P transport. See §16. |
| **Driver** | In Federated Mode: the Executor playing the ACP "client" role — sends `session/prompt`, owns virtual data. (§16.3) |
| **Host** | In Federated Mode: the Executor playing the ACP "agent" role — runs the leaves, receives prompts, may issue `fs/*` callbacks. (§16.3) |
| **Signaling** | Out-of-band rendezvous channel used to exchange WebRTC SDP + ICE before the P2P data channel exists. (§16.2) |
| **Virtual Path** | `np://session/<id>/<key>` namespace used in `fs/*` callbacks. Never maps to a real filesystem. (§16.4.1) |
| **Coworker** | In Collaborative Workspace mode: a peer with both Driver and Host capabilities — same person owns prompts and the agent. (§17.1) |
| **Workspace channel** | Second `RTCDataChannel` (label `neoprotocol-workspace`) carrying Y.js sync + awareness frames, multiplexed alongside the `neoprotocol-acp` channel on the same `RTCPeerConnection`. (§17.2) |

---

## 4. Transport

The protocol is JSON-over-HTTP for v0, with a defined upgrade path
to WebSocket / chunked transfer for streaming (v1).

### 4.1 Wire format
- **Encoding**: UTF-8 JSON.
- **Content-Type**: `application/json` for all request and response
  bodies. Servers MUST reject other types with `415 Unsupported
  Media Type`.
- **Numbers**: standard JSON numbers. Implementations SHOULD treat
  integers up to 2^53 as exact (JavaScript-safe range).
- **Endianness**: N/A — JSON is text.

### 4.2 HTTP method conventions
| Method | Purpose | Idempotent? |
|---|---|---|
| `GET /capabilities` | Originator asks Executor (when reachable) for a Capability Statement | yes |
| `POST /tasks` | Originator-side endpoint receiving a prompt; returns Task Offer (Originator can also push offers without a prompt — directional flexibility) | no — creates new task |
| `GET /tasks/:id` | Fetch task metadata (offer + result if any) | yes |
| `GET /tasks/:id/data` | Fetch input data referenced by the offer | yes |
| `POST /tasks/:id/results` | Executor submits a Result Envelope | idempotent on `task_id` (re-submission of same envelope replaces; servers SHOULD log) |

In current v0.2, the Executor is the *initiator* (browser POSTs a
prompt, then GETs the offer back synchronously). v1 may invert this
for push notifications via WebSocket; the spec does not mandate
direction.

### 4.3 Authentication (deferred to v1)
v0~v0.2: trusted localhost / single-tenant. v1 will add origin
verification (TLS + signed offers) and per-Executor authentication
tokens. Until then, deployments MUST treat the Originator URL as a
trust boundary (don't expose to untrusted networks).

### 4.4 CORS
Browser Executors require CORS-permissive Originators. Production
Originators SHOULD restrict `Access-Control-Allow-Origin` to known
Executor domains rather than `*`.

### 4.5 Size limits
- Recommended max Task Offer size: 1 MB.
- Recommended max Result Envelope size: 2 MB.
- Larger payloads SHOULD use `input_data_ref` indirection (see §6.1).

---

## 5. Message Flow + Sequence Diagrams

### 5.1 Lifecycle (informal)

```
   Originator                    Executor                  End User
       │                             │                         │
   ────┴─── (v0.3) capability handshake ─────────────────────────
       │  ── GET /capabilities ──>   │                         │
       │  <── Capability Statement ──                          │
   ────┬───────────────────────────────────────────────────────
       │  ── Task Offer (JSON) ──>   │                         │
       │                             │  ── Consent UI ──>      │
       │                             │  <── agree/decline ──   │
       │                             │                         │
       │                             │ [Level 3 only:          │
       │                             │   interrupt_before each │
       │                             │   listed node, fresh    │
       │                             │   consent per node]     │
       │                             │                         │
       │                             │ [run leaves, write to   │
       │                             │  channels, follow edges │
       │                             │  per reducer rules]     │
       │                             │                         │
       │  <── Result Envelope ──     │                         │
       │  ── ack ──>                 │                         │
```

### 5.2 Single-leaf flow (Level 0, today's sentiment-poc)

```
Browser                         Server
  │                               │
  │── GET /index.html ────────────>
  │── GET /graph.json (or /tasks) ─>
  │<── Task Offer ─────────────────
  │                               │
  │ render consent UI             │
  │ user clicks "Run locally"     │
  │                               │
  │ load DistilBERT (~17MB)       │
  │ classify each item            │
  │                               │
  │── POST /tasks/:id/results ────>
  │<── { ack: true } ──────────────
```

### 5.3 Multi-leaf with fan-out (Level 1)

```
Originator                       Executor
  │                                │
  │── Task Offer (3 leaves) ──────>
  │                                │
  │                                │ consent (offer-level)
  │                                │ user agrees
  │                                │
  │                                │ start: classify_node
  │                                │   ├─ fan-out 200 items ─┐
  │                                │   │     ↓               │
  │                                │   │ writes to channel   │
  │                                │   │   per_item_labels   │
  │                                │   │   (reducer: append) │
  │                                │   ↓                     │
  │                                │ summarize_node          │
  │                                │   reads per_item_labels │
  │                                │   writes summary        │
  │                                │                         │
  │<── Result Envelope ────────────│
```

### 5.4 Conditional routing (Level 2)

```
classify_node
  ↓ writes result.urgency
  ↓
  ├─ if result.urgency > 0.7 ─> human_review_node
  └─ else ─────────────────────> auto_archive_node
```

### 5.5 Interrupt-resume (Level 3)

```
graph.interrupt_before = ["pii_redact"]

  ... preceding leaves run ...
  │
  │  before pii_redact:
  │    Executor pauses
  │    surfaces per-leaf consent UI:
  │      "About to run pii_redact on
  │       these 12 messages. It will
  │       classify and mask. OK?"
  │    │
  │    ├─ user agrees ─> resume from pii_redact
  │    │
  │    └─ user declines ─>
  │         Result Envelope:
  │           status: declined
  │           reason: interrupt_declined
  │           interrupted_at: "pii_redact"
  │
  │ tab close before resuming?
  │   resumption_token in initial
  │   ack lets the Executor reload
  │   state and continue.
```

---

## 6. Task Offer

### 6.1 Skeleton

```json
{
  "protocol_version": "neoprotocol/0",
  "task": {
    "id": "<uuid>",
    "type": "<freeform task type, e.g. sentiment_batch>",
    "human_description": "Plain-language description for consent UI"
  },
  "graph": {
    "nodes":             [ /* §7 + §8 */ ],
    "edges":             [ /* §7 */ ],
    "channels":          { /* §7.2 */ },
    "interrupt_before":  [ /* §2 Level 3 */ ]
  },
  "input_data_ref": "<URL or inline reference>",
  "data_locality": {
    "raw_input_visibility": "client_only" | "shared",
    "returns_to_originator": ["<whitelisted result key>", ...]
  },
  "fallback_estimate": {
    "if_declined_originator_will": "...",
    "estimated_cost_usd": 0.0,
    "estimated_latency_ms": 0
  }
}
```

### 6.2 Field semantics

- `runtime: "client"` on a node — Executor MUST run this node locally
  if consent given.
- `fallback_runtime: "server"` — if Executor declines or fails, the
  Originator may take over.
- `data_locality.raw_input_visibility` — `"client_only"` means raw
  input MUST NOT leave the Executor; `"shared"` means the Originator
  may also inspect it.
- `data_locality.returns_to_originator` — whitelist of Result
  Envelope `results` keys allowed back. Both Executor-side and
  Originator-side enforcement are spec'd; both MUST strip
  non-whitelisted keys (defense in depth).
- `input_data_ref` — opaque pointer for large payloads. Common
  values: a URL the Executor fetches, or `"inline"` if the data is
  embedded directly. The Originator's server MUST authorize Executor
  access to the referenced data.

---

## 7. Graph Semantics (Level 1+)

### 7.1 Topology

- `nodes` — array of node objects (see §8 for shapes)
- `edges` — array of `{from, to, when?}` triples
- Special node IDs: `__start__` and `__end__`
- **Fan-out**: multiple edges sharing the same `from` → all
  destinations run concurrently
- **Fan-in**: multiple edges sharing the same `to` → executor waits
  for all upstream nodes before dispatching

### 7.2 Channels

State flows through named channels. Each channel has a reducer that
defines how concurrent writes from fan-out merge.

```json
"graph": {
  "channels": {
    "items":      { "reducer": "append" },
    "summary":    { "reducer": "replace" },
    "vote_count": { "reducer": "sum" }
  }
}
```

A node declares which channels it reads / writes:

```json
{ "id": "classify",
  "reads":  ["state.items"],
  "writes": ["per_item_labels"] }
```

### 7.3 Reducer types (closed set in v0.3)

| Reducer | Semantics | Min level |
|---|---|---|
| `append` | New value concatenated to existing list | 1 |
| `replace` | New value overwrites previous | 2 |
| `sum` | Numeric addition | 2 |
| `set_merge` | Set union (deduplicated) | 2 |

Custom reducers deferred to v1+. The v0.3 set is intentionally narrow
to keep adapter complexity low across frameworks.

### 7.4 Conditional Edges (Level 2)

```json
{ "from": "classify", "to": "high_priority_handler",
  "when": { "expr": "result.urgency > 0.7" } }
```

Expression grammar (v0.3 draft):
- Comparisons: `==`, `!=`, `<`, `<=`, `>`, `>=`
- Booleans: `&&`, `||`, `!`
- Field access: `result.foo.bar`
- Literals: numbers, strings, true, false, null
- **No** function calls, no arbitrary code execution

Multiple `when`-edges from the same `from` evaluated in declaration
order; first match wins. An unlabeled edge is the default fallback.

### 7.5 Interrupt-Resume (Level 3)

```json
"graph": { "interrupt_before": ["pii_redact", "third_party_api_call"] }
```

Before executing a listed node the Executor MUST surface a fresh
consent UI scoped to that leaf and pause. `agree` → resume; `decline`
→ Result Envelope `status: "declined"`, `reason:
"interrupt_declined"`, `interrupted_at: "<node_id>"`.

Level 3 Executors MUST persist channel values + graph position so a
tab close doesn't lose state. The persistence mechanism is
Executor-defined (IndexedDB, server-side checkpoint); the spec only
requires that a `resumption_token` returned in the initial offer
acknowledgment can be redeemed for continued execution.

---

## 8. Node Implementation Models

How a leaf tells the Executor *what to actually do*. Two canonical
models; a graph may mix them.

### 8.1 Model A — Server-described

```json
{ "id": "classify", "kind": "leaf", "runtime": "client",
  "implementation": {
    "model": "server_described",
    "task": "sentiment-analysis",
    "model_options": [
      { "runtime_kind": "local_onnx",
        "model_id": "Xenova/distilbert-base-uncased-finetuned-sst-2-english",
        "size_mb": 17, "quantized": true,
        "device_pref": ["webgpu", "wasm"] },
      { "runtime_kind": "byok_api",
        "byok_provider": "openai",
        "model_id": "openai/gpt-4o-mini",
        "endpoint": "https://api.openai.com/v1/chat/completions",
        "prompt_template": "Classify ... {text}" }
    ]
  }
}
```

The Executor needs only a generic runner per known `task` type. Best
for **stock leaves** — sentiment, classification, embeddings, PII
redaction, short summarization. Originator controls the version.

### 8.2 Model B — Executor-registered

```json
{ "id": "fraud_score", "kind": "leaf", "runtime": "client",
  "implementation": {
    "model": "executor_registered",
    "node_name": "internal.fraud.score_v3",
    "input_schema":  { "type": "object", "properties": {
      "transaction": { "type": "object" } } },
    "output_schema": { "type": "object", "properties": {
      "risk": { "type": "number", "minimum": 0, "maximum": 1 } } }
  }
}
```

Best for **custom logic** that MUST stay on the Executor —
proprietary scoring, internal taxonomies, sensitive business rules.
The Originator never sees the implementation. The Capability
Statement (§9) declares which `node_name`s are registered.

### 8.3 v0 backward-compat shorthand

The v0 sentiment-poc inlines a `leaf_spec` field. This is syntactic
sugar equivalent to `implementation.model = "server_described"`. v0
implementations MAY accept both forms; v1 canonicalizes on
`implementation`.

---

## 9. Capability Statement (v0.3)

```json
{
  "protocol_version": "neoprotocol/0",
  "executor_id": "<opaque session id>",
  "capabilities": {
    "max_conformance_level": 2,
    "implementation_models": ["server_described", "executor_registered"],
    "registered_nodes": [
      { "name": "internal.fraud.score_v3",
        "input_schema":  { "type": "object", ... },
        "output_schema": { "type": "object", ... } }
    ],
    "runtime_kinds":            ["local_onnx", "byok_api", "browser_builtin"],
    "device_support":           ["wasm", "webgpu"],
    "max_model_size_mb":        200,
    "concurrent_leaves_max":    4,
    "max_input_tokens_per_leaf": 512
  },
  "user_preferences": {
    "max_download_mb": 50,
    "byok_available":  ["openai", "anthropic"]
  }
}
```

Originator MUST NOT generate offers that exceed declared
capabilities. Mismatch → fall back to its own runtime instead of
shipping an unfulfillable offer.

---

## 10. Result Envelope

### 10.1 Completed

```json
{
  "protocol_version": "neoprotocol/0",
  "task_id": "<uuid from Task Offer>",
  "status": "completed",
  "execution": {
    "runtime":            "client" | "server" | "byok",
    "runtime_kind":       "local_onnx" | "byok_api" | "browser_builtin",
    "model_used":         "...",
    "device":             "wasm" | "webgpu" | "remote-api" | ...,
    "model_load_ms":      0,
    "inference_ms_total": 0,
    "items_processed":    0,
    "nodes_executed":     ["classify", "aggregate"]
  },
  "results": { /* whitelisted by data_locality.returns_to_originator */ }
}
```

### 10.2 Declined / Failed

```json
{
  "protocol_version": "neoprotocol/0",
  "task_id": "<uuid>",
  "status": "declined" | "failed",
  "reason_code": "EX-201",
  "reason": "user_declined",
  "interrupted_at": "<node_id, only when interrupted>"
}
```

See §12 for the structured `reason_code` taxonomy.

---

## 11. Consent UI Requirements

The Executor MUST present a consent surface before:
- Fetching model bytes (Level 0 cold start)
- Posting any data to a non-Originator endpoint (BYOK API call)
- Executing an `interrupt_before` node (Level 3)

Required elements:
1. **What** — `task.human_description` (or per-node description for
   Level 3 interrupts)
2. **Cost to user** — model size, estimated download time, estimated
   API cost if BYOK
3. **Data locality** — what leaves the device, what stays
4. **Fallback** — what happens if user declines (Originator's own
   cost / latency)
5. **Decision** — at minimum *Agree* and *Decline*. *Use my API key*
   in v0.1+. *Use browser built-in AI* in v0.1+ where available.

Any UI satisfying these is conformant. **(v1+)** browser-native
permission API for cross-site agent task delegation.

---

## 12. Error Codes

Structured taxonomy. Every Result Envelope with `status: "declined"`
or `status: "failed"` MUST include both `reason_code` (machine) and
`reason` (human-readable string).

### 12.1 Code prefix conventions
- **EX-1xx** — Executor-side input validation / setup errors
- **EX-2xx** — Executor-side user / consent / runtime errors
- **EX-3xx** — Executor-side model / inference errors
- **OR-1xx** — Originator-side reception errors (used in HTTP error responses, not envelopes)
- **OR-2xx** — Originator-side validation errors (offer rejected)
- **PR-1xx** — Protocol-level errors (version, capability mismatch)
- **SIG-xxx** — Signaling errors (Federated Mode, §16). Reuses HTTP-style 4xx digits.
- **FED-xxx** — Federated Mode application errors (Virtual Path, permission, scope).

### 12.2 Defined codes

| Code | Reason string | Meaning |
|---|---|---|
| EX-101 | `offer_malformed` | Task Offer fails JSON Schema validation |
| EX-102 | `node_unregistered` | Offer references Model B `node_name` not declared in Capability Statement |
| EX-103 | `task_unsupported` | Offer uses Model A `task` type the Executor doesn't implement |
| EX-201 | `user_declined` | End User clicked decline at offer-level consent |
| EX-202 | `interrupt_declined` | End User declined a per-leaf interrupt (Level 3) |
| EX-203 | `byok_auth_failed` | BYOK API call returned 401/403 |
| EX-204 | `consent_timeout` | Consent UI shown but user did not respond within bound (Executor-defined) |
| EX-301 | `model_unavailable` | Model fetch failed or runtime refused load |
| EX-302 | `oom` | Out of memory during inference |
| EX-303 | `timeout` | Inference exceeded Executor-defined per-leaf budget |
| EX-304 | `model_runtime_error` | Inference threw an exception not covered above |
| OR-101 | `prompt_missing` | `POST /tasks` body lacked required `prompt` |
| OR-102 | `body_too_large` | Request body exceeded Originator size limit |
| OR-201 | `decomposer_failed` | Originator's planner could not produce a conformant offer |
| OR-202 | `task_not_found` | Result POST referenced a task_id the Originator doesn't know |
| OR-203 | `envelope_invalid` | Result Envelope failed schema validation |
| OR-204 | `task_id_mismatch` | URL `:id` and envelope `task_id` disagree |
| PR-101 | `protocol_version_unsupported` | Major version mismatch between peers |
| PR-102 | `capability_exceeded` | Offer exceeds declared Executor capability |
| PR-103 | `level_unsupported` | Offer requires conformance level above declared |
| SIG-400 | `bad_signaling_frame` | Malformed signaling frame (§16.2) |
| SIG-401 | `not_joined` | Signaling op attempted before `join` |
| SIG-404 | `peer_not_found` | Signaling target peer ID unknown in room |
| SIG-409 | `room_state_conflict` | Already joined, or peer ID collision |
| SIG-413 | `signaling_frame_too_large` | Frame exceeds the 1 MiB cap |
| SIG-429 | `room_full` | Room peer cap reached |
| FED-001 | `path_not_virtual` | `fs/*` path not in `np://session/...` namespace (§16.4.1) |
| FED-002 | `path_out_of_scope` | Virtual Path session ID does not match active session |
| FED-003 | `permission_denied` | Driver / End User denied the `fs/*` or tool-call request |
| FED-004 | `session_not_found` | `session/prompt` or callback referenced an unknown sessionId |

New codes added in subsequent spec versions retain numbers (no reuse
of retired codes).

### 12.3 HTTP status mapping (Originator side)

| HTTP | When |
|---|---|
| `400` | OR-101, OR-203, OR-204 (client sent bad request body) |
| `404` | OR-202 (unknown `:id`) |
| `413` | OR-102 (oversize body) |
| `415` | wrong Content-Type |
| `422` | OR-201 (decomposer couldn't plan) |
| `500` | unexpected server error |

---

## 13. Reliability

### 13.1 Retries

- **POST /tasks** — Executor MAY retry on `5xx` and network errors,
  with exponential backoff (250 ms initial, 2× factor, max 4
  retries, jitter). MUST NOT retry on `4xx`.
- **POST /tasks/:id/results** — idempotent on `task_id`. Executor
  MAY retry on `5xx`/network errors with the same backoff. The
  Originator MUST tolerate duplicate envelope submission (replace
  prior result; log the duplication).
- **Model fetch** — implementation-defined. Browser executors should
  rely on the browser HTTP cache + service worker.

### 13.2 Timeouts

| Path | Suggested timeout |
|---|---|
| Connect to Originator | 5 s |
| `GET /capabilities` | 5 s |
| `POST /tasks` (offer creation) | 30 s (Originator may be calling a frontier model) |
| `GET /tasks/:id/data` | 30 s |
| `POST /tasks/:id/results` | 10 s |
| Per-leaf inference | offer-defined or Executor default; recommended 60 s for local, 30 s for BYOK |

Executors MUST surface "still running" feedback past 5 s on any leaf
to keep the End User from assuming the page is broken.

### 13.3 Integrity

- All payloads are JSON; integrity is delegated to TLS in production.
- v0~v0.2: localhost / trusted network — no payload signing.
- **(v1)** signed offers — Originator signs the offer with a key the
  Executor has trusted (e.g. JWS). Prevents man-in-the-middle offer
  modification on untrusted networks.
- **(v2)** signed envelopes — Executor signs with attestation key.
  Allows Originator to verify the result came from a known runtime.

### 13.4 Idempotency keys

`POST /tasks/:id/results` is naturally idempotent on `task_id`. For
`POST /tasks` (where the Originator may be unable to dedupe a retried
prompt), the Executor SHOULD include an `Idempotency-Key` header with
a UUID; the Originator SHOULD return the previously generated offer
on key reuse.

### 13.5 Cancellation
Deferred to v1. Executor will be able to send `DELETE /tasks/:id` to
abort an in-flight run; Originator-side fallback execution may then
resume from the last successful node.

---

## 14. Versioning

`protocol_version` is `neoprotocol/<major>`. Pre-v1 the major may
break at any time; the demo and the spec evolve together. v1 is the
stability commitment — after v1, breaking changes bump major.

Major version mismatch between Originator and Executor → both sides
SHOULD refuse with `reason_code: "PR-101"`.

Conformance level (§2) is orthogonal to protocol version: all levels
share one wire format. An Executor may upgrade its level over time
without re-handshaking the protocol version.

---

## 15. Out of Scope (still deferred)

| Item | When | Notes |
|---|---|---|
| Streaming results | v1 | Leaves return partial outputs; chunked / WS transport |
| Trust / attestation | v2 | Adversarial cross-org. v0~v1 = trusted Executor (your own users) |
| Authentication / origin verification | v1 | TLS + signed offers (§13.3) |
| Model version pinning | v1 | Hash + revision SHA on `model_id` |
| Cancellation | v1 | `DELETE /tasks/:id` + fallback resume (§13.5) |
| Custom reducers | v1+ | Spec-extension mechanism; v0.3 ships closed set in §7.3 |
| Multi-Originator coordination | v2+ | One Executor session, multiple Originators |

Items previously in this list and now in scope:
- Capability negotiation (§9)
- BYOK model option (shipped v0.1)
- Multi-node graph composition (§7)
- Per-leaf consent gating (§7.5)
- Browser↔browser P2P agent coordination (§16, Federated Mode)

---

## 16. Federated Mode

> **Status: v0.3 draft.** Reference implementation in
> `examples/p2p-acp-poc/`, Originator signaling endpoint shipped in
> `server/signaling.js`. The wire format is stable for the PoC, but
> may grow before v1 (rooms scoped by Originator, ICE TURN policy,
> resumption tokens for tab close).

Federated Mode lets two or more Executors cooperate on a single Task
Offer by establishing a peer-to-peer data channel between their
browsers and exchanging the **ACP wire format** (Zed Agent Client
Protocol, JSON-RPC 2.0, NDJSON-style framing) over it. The Originator
is unchanged in its role as decomposer; it gains an optional
**signaling rendezvous** responsibility but never inspects ACP
traffic. Once peers have exchanged SDP + ICE, the Originator drops
out and ACP frames flow e2e over DTLS-protected SCTP.

### 16.1 Why ACP

The cross-browser problem is structurally **bidirectional with
permission gating**: peers need to ask each other for data and
authorization, not just submit and poll. A2A's task-lifecycle model
(submit → poll → fetch) is one-directional; ACP's `fs/*` and
`session/request_permission` callbacks are first-class
bidirectional, and the consent semantics line up with NeoProtocol's
existing per-leaf consent gates (§7.5). NDJSON line framing also
maps 1:1 to WebRTC `RTCDataChannel.send()` because SCTP preserves
message boundaries — no reassembly layer required.

The reference implementation reuses `neograph::acp` (NeoGraph's full
ACP server, including the StopReason 5-value Zed-conformant enum)
verbatim as the wire-format reference; only the transport layer is
re-implemented in JS to ride WebRTC.

### 16.2 Signaling — two modes, same data plane

A peer MUST support at least one of these two signaling modes; SHOULD
support both for interoperability.

#### 16.2.1 Standard Mode — Originator-as-signaling

The Originator exposes a WebSocket endpoint (default path
`/signaling`) that acts as a **dumb relay**: it forwards opaque
payloads (SDP and ICE candidates) between paired peers in the same
room. The Originator never parses these payloads.

```
client → server                       server → client
{ kind: "join",                       { kind: "joined",
  room: "<id>",                         peer_id: "<self>",
  role: "host"|"driver",                peers: [{id,role,capabilities},...] }
  capabilities?: {...} }              { kind: "peer_joined", peer: {...} }
{ kind: "signal", to: "<peer_id>",    { kind: "signal", from: "<peer_id>",
  payload: <opaque> }                   payload: <opaque> }
{ kind: "leave" }                     { kind: "peer_left", peer_id: "<id>" }
                                      { kind: "error", code: "...", reason: "..." }
```

Caps:
- 1 MiB max signaling frame (`SIG-413`).
- 8 peers max per room (`SIG-429`); v1 may raise.
- Rooms are ephemeral and unauthenticated in v0.3; v1 adds room
  tokens and rate limits.

#### 16.2.2 Minimal Mode — SDP via URL

Zero runtime server. Each peer waits for ICE gathering to complete
(non-trickle), then encodes the full SDP into a base64url URL hash
fragment and shares it over any out-of-band channel (chat, email,
QR). The other peer pastes the URL, generates the answer, and the
originating peer pastes the answer URL back.

```
host:    createOffer → setLocalDescription → wait ICE complete
         → URL = <pageUrl>#offer=<base64url(sdp)>
driver:  paste offer URL → setRemoteDescription → createAnswer
         → setLocalDescription → wait ICE complete
         → URL = <pageUrl>#answer=<base64url(sdp)>
host:    paste answer URL → setRemoteDescription → connection up
```

Conformance note: a peer that supports only Minimal Mode is still a
conformant Federated Mode peer. The `signaling_modes` capability
declares which modes are supported (§16.5).

### 16.3 Roles and the data plane

Within a Federated session:

- **Host** — the peer running the agent. Implements ACP **agent**
  responsibilities (`initialize`, `session/new`, `session/prompt`,
  `session/cancel`). MAY issue callbacks: `fs/read_text_file`,
  `fs/write_text_file`, `session/request_permission`. Host pre-creates
  the `RTCDataChannel` (label `neoprotocol-acp`, ordered, reliable).

- **Driver** — the peer initiating prompts. Implements ACP **client**
  responsibilities. Owns the End User. MUST gate every `fs/*` and
  `session/request_permission` callback through a UI consent surface
  (§11 applies). Receives the data channel via `ondatachannel`.

- **Originator** — only present in Standard Mode, only for signaling.
  Never has access to the ACP data plane.

The data channel MUST be ordered + reliable. The label
`neoprotocol-acp` is the rendezvous identifier; alternative labels
are reserved for future protocol variants.

### 16.4 Cross-network ACP safety profile

Stock ACP was designed for IDE-agent co-location (Zed editor spawning
a local agent subprocess). Several callbacks — particularly `fs/*` —
trust the client's filesystem boundaries. Across the network, those
boundaries vanish. This subsection defines the hardening required
when ACP rides Federated Mode.

#### 16.4.1 Virtual Path namespace (MUST)

In Federated Mode, **all `fs/*` paths MUST be Virtual Paths** of the
form:

```
np://session/<sessionId>/<key>[/<key>...]
```

Where `<sessionId>` is the value returned by `session/new` and
`<key>` segments are application-defined. The driver MUST reject any
`fs/*` request whose path:
- is not a string starting with `np://session/`, or
- contains a `..` segment, or
- has a session segment that does not match the active sessionId.

Rejection codes: `FED-001` (not virtual) or `FED-002` (out of scope).

The driver maintains an in-memory map of `(virtualPath → contents)`
and serves `fs/read_text_file` from it. Mapping a Virtual Path to a
real file (e.g., to forward the user's actual document) is a driver
implementation choice and outside the protocol — but the wire MUST
NEVER carry a real path.

#### 16.4.2 Permission gate (MUST)

Every callback from host → driver that reads or writes data
(`fs/read_text_file`, `fs/write_text_file`, future tool-call requests)
MUST go through a fresh permission UI surface unless the driver has
declared a per-path standing grant for the active session. The
permission surface MUST display:
- the Virtual Path being requested,
- the operation kind (read / write / tool-call),
- the host peer's identity (peer_id + capability statement summary).

Denial returns `FED-003` (permission_denied).

#### 16.4.3 DTLS fingerprint surfacing (SHOULD)

To allow the End User to detect MITM on the signaling channel, the
driver UI SHOULD display the host's DTLS certificate fingerprint
(extracted from the SDP `a=fingerprint:` line). End Users who wish
strong assurance can compare fingerprints out-of-band.

#### 16.4.4 Capability statement bound (MUST)

When acting as host in Federated Mode, the executor's Capability
Statement (§9) MUST faithfully describe what the agent will do.
Misrepresentation by the host gives the driver no recourse beyond
disconnecting; v1 MAY add signed Capability Statements for
attestation.

### 16.5 Capability Statement extensions

Federated Mode adds an optional `federated` block to the §9 capability
statement:

```jsonc
{
  "capabilities": {
    "federated": {
      "spec_version": "neoprotocol/0.3",
      "signaling_modes": ["standard", "manual"],
      "role": "host" | "driver" | "both",
      "ice_servers_self_provided": false,    // peer needs us to supply STUN/TURN?
      "max_concurrent_sessions": 4,
      "fs_callbacks": {
        "read_text_file":  true,
        "write_text_file": false
      }
    }
  }
}
```

A peer that does NOT include `capabilities.federated` is implicitly a
non-federated Executor (Levels 0–3 monolithic).

### 16.6 Lifecycle

```
SIGNALING                                      DATA PLANE
─────────                                      ──────────
host  ─ join(room=R, role=host) ──► relay
driver ─ join(room=R, role=driver) ─► relay
relay  ─ peer_joined(host) ──► driver
relay  ─ peer_joined(driver) ──► host
host  ─ signal(SDP offer)  ─────► driver       (RTCPeerConnection
driver ─ signal(SDP answer) ────► host          handshake in progress)
host/driver ─ signal(ICE) ◄─────► driver/host
                                               DTLS handshake → DataChannel open
                                               ──────────────────────────────────
                                               driver → initialize
                                               driver ◄ {protocolVersion, agentCapabilities}
                                               driver → session/new
                                               driver ◄ {sessionId}
                                               driver → session/prompt {sessionId, prompt}
                                                 host  → fs/read_text_file
                                                         {path: "np://session/.../doc"}
                                                 driver shows permission UI
                                                 driver ◄ {content}
                                                 host  ↛ session/update {agent_message_chunk}
                                                       ↛ session/update {agent_message_chunk}
                                                       ↛ ...
                                               driver ◄ {stopReason: "end_turn"}
                                               (or: driver → session/cancel)
                                               ──────────────────────────────────
either side ─ leave / close
```

### 16.7 Reliability

- Signaling reconnect: if the signaling WebSocket drops **after**
  `RTCDataChannel` is open, the data plane is unaffected — peers
  MUST continue ACP traffic and not require the signaling channel.
- Data channel close: peers SHOULD treat data channel close as
  session termination. Resumption across data channel reconnect is
  out of scope for v0.3 (deferred to v1, alongside §13.5
  cancellation tokens).
- Session timeout: drivers SHOULD bound `session/prompt` round trips
  with a wall-clock timeout. A timed-out session SHOULD issue
  `session/cancel` before disconnecting.

### 16.8 Out of scope (v0.3 → v1)

| Item | When | Notes |
|---|---|---|
| TURN policy | v1 | v0.3 = STUN only. Symmetric NAT cases fall back to Minimal Mode. |
| Room auth tokens | v1 | v0.3 rooms are unauthenticated (private deployment). |
| Resumption across DC reconnect | v1 | Tied to §13.5. |
| Signed Capability Statements | v2 | Cross-org attestation. |
| Multi-host fan-out (1 driver → N hosts) | v1 | Wire spec already supports it; reference impl is 1:1 only. |
| MCP-server passthrough | v1 | `mcpServers` field of `session/new` is reserved. |

---

## 17. Collaborative Workspace

> **Status: v0.3 draft, Stages 1+2 reference implementation shipped.**
> Stage 1 covers §§17.1–17.2, §17.5 attribution, and the Stage 1
> portion of §17.6 lifecycle. Stage 2 covers §17.4 (cross-agent
> permission grants + ACP recursion shape + streamed candidate
> document). Stage 3 onwards (§17.3 real-file mapping) is
> conditional. See
> [`docs/roadmap-collaborative-workspace.md`](docs/roadmap-collaborative-workspace.md)
> for the staged plan and decision criteria.

Federated Mode (§16) lets two browsers exchange ACP frames over a P2P
data channel. Collaborative Workspace generalizes that primitive into
a shared editable document: two or more peers, each with their own
agent (local model or BYOK), share a Y.js CRDT and the protocol
preserves attribution as edits propagate.

The Originator's role is unchanged from §16. It signals; it does not
see the workspace state, the document content, the prompts, or the
agent outputs. ACP frames and Y.js updates both ride DTLS-protected
SCTP — strictly P2P — and the §16.4 trust class applies verbatim.

### 17.1 Roles

- **Coworker** — a peer with both Driver and Host capabilities. The
  same person owns the user-facing UI (drives prompts) and the
  agent-facing logic (runs the BYOK / local agent). Coworkers are
  symmetric: any Coworker can prompt their own agent or, with
  consent (§17.4), prompt a peer's agent.
- **Originator** — same as §16: signaling rendezvous, never sees the
  data plane.

A peer's `capabilities.federated.role` value is `"both"` when acting
as a Coworker.

### 17.2 Workspace channel

The Workspace channel is a separate `RTCDataChannel` from the §16
ACP channel, multiplexed onto the same `RTCPeerConnection`:

| Channel label | Carries | SPEC |
|---|---|---|
| `neoprotocol-acp` | ACP JSON-RPC 2.0 frames (§16) | §16.3 |
| `neoprotocol-workspace` | Y.js sync + awareness frames (§17.2) | §17.2 |

Both channels MUST be ordered + reliable. Splitting them isolates
backpressure (large Y.js updates won't head-of-line block ACP
prompts) and lets a Stage 2 peer that does not yet speak ACP still
participate in §17 cowork.

#### 17.2.1 Frame format

Each `RTCDataChannel.send()` carries one JSON envelope. Binary Y.js
payloads are base64url-encoded (browsers don't have native ergonomic
binary framing on data channels; the Stage 1 PoC measured the
overhead at ~33% per frame which is acceptable for code-sized docs).

```jsonc
// Y.js sync handshake — one round-trip on connect
{ "kind": "ydoc.sync_step1", "sv":     "<base64 state vector>" }
{ "kind": "ydoc.sync_step2", "update": "<base64 update bytes>"  }

// Subsequent local edits — broadcast on Y.Doc 'update' event
{ "kind": "ydoc.update",     "update": "<base64 update bytes>"  }

// Cursor / selection / display name — one frame per local awareness change
{ "kind": "awareness.update", "update": "<base64 awareness update>" }
```

Reserved frame kinds (forward compatibility): `ydoc.sub` and
`ydoc.unsub` for multi-document workspaces (Stage 3).

#### 17.2.2 First-joiner seed rule

To prevent the late-joiner double-seed race that Stage 1
PoC verification exposed:

- The first peer to enter a fresh room (signaling reports
  `peers.length === 0` in its `joined` ack) MAY seed the document
  with starter content **only after** the Workspace channel opens
  AND the `ydoc.sync_step2` exchange completes with a still-empty
  Y.Doc.
- Late joiners (`peers.length > 0`) MUST NOT seed.
- Implementations MUST NOT seed before the channel is open;
  optimistic local seeds will collide under CRDT semantics with the
  remote's seed and produce duplicated content.

### 17.3 Real-file mapping safety profile (Stage 3 placeholder)

When a Coworker maps Virtual Paths (§16.4.1) to real filesystem
entries via a sandbox root (e.g. browser `FileSystemDirectoryHandle`),
the following constraints MUST hold. **Stage 3 will fill in the
detail; the slot is reserved here.**

- The sandbox root MUST be a directory the user explicitly chose
  through the browser's permission UI in this session. It MUST NOT
  be persisted across origins.
- Every `np://session/<id>/workspace/<rel>` resolves to
  `<sandboxRoot>/<rel>` after `..` and absolute-path rejection.
- Path traversal outside the sandbox MUST yield `FED-001` /
  `FED-002` (unchanged from §16.4).

### 17.4 Cross-agent permission grants (Stage 2 — implemented)

When a peer's agent issues an ACP request whose target is the
*peer's* agent (rather than its own user), the receiving Driver
MUST surface a permission UI. The Driver's response carries a grant
scope:

| Grant | Meaning |
|---|---|
| `allow_once`        | This single request only. Future requests re-prompt. |
| `allow_session`     | All future requests from the same `(remote_peer_id, remote_agent_id)` pair for the active session. |
| `allow_per_path`    | (Stage 3+) all future requests with the *exact* `path` for the active session. Reserved; Stage 2 PoC does not emit. |
| `deny_once`         | Reject this request (`FED-003`). Future requests re-prompt. |
| `deny_session`      | Reject this and all future requests from the same `(remote_peer_id, remote_agent_id)` pair for the session. |

These extend the existing `session/request_permission` outcome
field. A peer that does not understand the new grant variants MUST
treat them as `allow_once` / `deny_once` respectively for forward
compatibility.

#### 17.4.1 ACP recursion shape

Cross-agent calls reuse the §16 ACP wire format unchanged. The
receiver acts as an ACP **agent** (handles `initialize`,
`session/new`, `session/prompt`); the sender acts as an ACP
**client**. Because both halves run on every Coworker (a peer can
ask AND be asked), implementations MUST share **one**
`JsonRpcChannel` per `neoprotocol-acp` data channel — instantiating
two channels on the same `RTCDataChannel` causes both to listen for
incoming frames and the empty-handlers half will reply
"method not found" before the populated half can respond.
Reference impl: `examples/cowork-poc/cross-agent.js` exposes
`makeCrossAgentChannel(dc)` returning the shared channel that both
`startCrossAgentReceiver` and `startCrossAgentSender` hook into.

#### 17.4.2 Cross-agent identification on the wire

`initialize` and `session/new` requests in the cross-agent direction
carry two non-standard ACP fields so the peer's agent can identify
the asker for the permission UI and so attribution (§17.5) can
travel with the eventual edit:

```jsonc
{ "method": "initialize", "params": {
    "protocolVersion": 1,
    "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } },
    "fromPeerId":  "<asker peer_id>",
    "fromAgentId": "<asker's agentId, e.g. 'anthropic' / 'mock'>"
} }

{ "method": "session/new", "params": {
    "fromPeerId":  "...",
    "fromAgentId": "...",
    "mcpServers":  []
} }
```

The receiver's `initialize` reply MUST echo its own identity so the
asker can build the attribution stamp:

```jsonc
{ "result": {
    "protocolVersion": 1,
    "agentCapabilities": { ... },
    "peerId":  "<receiver peer_id>",
    "agentId": "<receiver's agentId>"
} }
```

#### 17.4.3 Streamed candidate document

The receiver's `session/prompt` response uses two
`session/update` notifications followed by `{stopReason}`:

1. `agent_message_chunk` (streamed, possibly multiple) — the
   reasoning the receiver's agent produced.
2. `candidate_document` (terminal) — the proposed full document, to
   be applied by the asker via §17.5 attribution stamping.

```jsonc
// Notification (one or more):
{ "method": "session/update", "params": {
    "sessionId": "...",
    "update": { "kind": "agent_message_chunk", "content": { "type": "text", "text": "..." } }
} }
// Notification (one terminal):
{ "method": "session/update", "params": {
    "sessionId": "...",
    "update": { "kind": "candidate_document", "document": "<full new document text>" }
} }
// Final response:
{ "result": { "stopReason": "end_turn" } }
```

The `candidate_document` update kind is reserved by NeoProtocol; it
extends the Zed ACP enum used in §16. Implementations that don't
recognize the kind MUST ignore the update without erroring.

### 17.5 Attribution

Every Y.Doc transaction that is the result of an *agent* edit (as
opposed to a direct human keystroke) MUST stamp the workspace
metadata map with:

```jsonc
{
  "agentId":    "<implementation-defined; e.g. 'anthropic', 'mock', 'local-gemma2'>",
  "peerId":     "<peer_id of the user whose agent produced the edit>",
  "appliedAt":  <unix-ms when the user clicked Apply>,
  "bytesIn":    <inserted character count>,
  "bytesOut":   <deleted character count>
}
```

This metadata travels with the edit (it's a Y.Map mutation in the
same transaction). Receiving peers' UIs SHOULD surface attribution —
e.g. a transient toast "User A's agent applied an edit" — so that
collaborators can distinguish human edits from agent edits at a
glance. Stage 1 PoC implements this with a fade-in toast.

### 17.6 Lifecycle (Stage 1 + Stage 2 sketch)

```
SIGNALING                                      DATA PLANES
─────────                                      ───────────
peer-A ─ join(room=R, role=host) ──► relay
peer-B ─ join(room=R, role=driver) ─► relay
relay  ─ peer_joined ──► both peers
                                               (RTCPeerConnection + 2 DCs:
                                                neoprotocol-acp,
                                                neoprotocol-workspace)
                                               ─────────────────────────
                                               WORKSPACE channel:
                                               peer-A → ydoc.sync_step1
                                               peer-B → ydoc.sync_step2
                                               peer-A seeds (first joiner)
                                               peer-A → ydoc.update (seed bytes)
                                               peer-B applies → editor renders
                                               (Stage 1 stops here)
                                               ─────────────────────────
                                               STAGE 2: ACP channel:
                                               peer-A's user prompts agent
                                               peer-A's agent decides it needs
                                                 peer-B's agent
                                               peer-A's agent → ACP request
                                                 over neoprotocol-acp DC
                                               peer-B's UI shows permission
                                                 dialog with grant choice
                                               peer-B's user picks allow_once
                                               peer-B's agent runs the request
                                               peer-B's agent → result via ACP
                                               peer-A's agent integrates
                                               either side → ydoc.update with
                                                 attribution {agentId, peerId}
```

### 17.7 Out of scope (Stage 1+2 → Stage 3+)

| Item | Stage | Notes |
|---|---|---|
| Multi-file workspace + file tree | 3 | Reserved `ydoc.sub` / `ydoc.unsub` frame kinds. |
| `FileSystemDirectoryHandle` mapping | 3 | §17.3 placeholder. |
| Local-model agent backends | 4 | BYOK only in Stages 1–3. |
| Multi-peer (>2) Coworker mesh | 1 (wire) / 4 (impl) | Wire allows; reference is 1:1. |
| Edit conflict UX (semantic merge) | 4+ | CRDT handles textual conflicts; semantic conflicts are out of protocol scope. |
| Voice / video | never | Application choice on top of WebRTC; not protocol territory. |

---

## Appendix A — Spec evolution log

| Version | Section additions | Commit |
|---|---|---|
| v0 init | §1, §5 (flow), §6 (offer), §10 (envelope), §11 (consent), §14 (versioning), §15 (deferred) | `26dd8e8` |
| v0.3 draft I | §2 conformance levels, §7 graph semantics, §8 impl models, §9 capability statement | `7265e66` |
| v0.3 draft II | §3 glossary, §4 transport, §5 expanded sequence diagrams, §12 error code taxonomy, §13 reliability | `11bb7de` |
| v0.3 draft III | §16 Federated Mode (ACP-over-WebRTC; Standard + Minimal signaling; Virtual Path safety profile); §3 glossary entries; §12 SIG/FED codes; §2 federated-orthogonality note | `7e22473` |
| v0.3 draft IV | §17 Collaborative Workspace (Coworker role; Workspace channel multiplexed with ACP; first-joiner seed rule; cross-agent permission grant variants Stage-2 spec; attribution metadata); Stage 1 reference impl `examples/cowork-poc/` | `78e1124` |
| v0.3 draft V | §17.4 Stage-2 reference impl shipped — cross-agent ACP recursion (§17.4.1 shared-`JsonRpcChannel` rule, §17.4.2 from/to peer-agent identity wire fields, §17.4.3 streamed candidate-document update kind). `examples/cowork-poc/cross-agent.js` ~230 LOC. peer.js parameterized for multi-DC mode (`dcLabels: string[]`) | this commit |
