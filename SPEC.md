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

---

## Appendix A — Spec evolution log

| Version | Section additions | Commit |
|---|---|---|
| v0 init | §1, §5 (flow), §6 (offer), §10 (envelope), §11 (consent), §14 (versioning), §15 (deferred) | `26dd8e8` |
| v0.3 draft I | §2 conformance levels, §7 graph semantics, §8 impl models, §9 capability statement | `7265e66` |
| v0.3 draft II | §3 glossary, §4 transport, §5 expanded sequence diagrams, §12 error code taxonomy, §13 reliability | this commit |
