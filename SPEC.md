# NeoProtocol — Specification

> **Status: v0 draft, evolving toward v1.** Pre-v1 the wire format may
> break at any time; major bumps are documented in `CHANGELOG.md` and
> in the "Versioning" section below. v1 is the stability commitment.

> This spec covers v0 (single-leaf, what the sentiment-poc ships) plus
> the v0.3 extensions that unlock multi-leaf graphs, conditional
> routing, interrupt-resume, capability negotiation, and custom
> executor-registered leaves. Items marked **(v0)** ship today.
> Items marked **(v0.3)** are spec-only at this point — server +
> executor implementations land alongside the multi-leaf demo.

---

## 1. Roles

- **Originator** — sends Task Offers. Typically a server holding a
  frontier model that decomposes a user request into a graph.
- **Executor** — receives Task Offers, surfaces consent UI, runs the
  leaves it agrees to, and returns a Result Envelope. Typically a
  browser tab, but Originator-Executor isn't a server-vs-client claim
  — a Python process running an agent framework can be either or
  both.
- **End User** — drives consent decisions on the Executor side.

---

## 2. Conformance Levels

Single wire format, opt-in features. Modeled after HTTP/2's optional
extensions, not version forks. An Executor declares its maximum level
in the Capability Statement (§7); the Originator MUST NOT emit offers
exceeding the declared level.

### Level 0 — Single-Leaf

- `graph.nodes` has exactly 1 leaf node, `graph.edges` is `[]`
- One consent gate (offer-level)
- `data_locality.returns_to_originator` whitelist enforced
- Result Envelope `status ∈ {completed, declined, failed}`

The current sentiment-poc demo is Level 0 + Model A.

### Level 1 — Multi-Leaf Static

- Multiple nodes connected by `edges`
- Sequential and fan-out topologies (one-to-many)
- Channel reducers: `append` only
- All edges static (no `when` predicate)
- Single offer-level consent gate

### Level 2 — Conditional Routing

- Conditional edges with `when` predicate
- Channel reducers: `append`, `replace`, `sum`, `set_merge`
- Routing decisions made by the Executor at runtime

### Level 3 — Stateful with Interrupts

- `interrupt_before: ["node_a", ...]` per-node consent gating
- Executor pauses before listed nodes, surfaces a fresh consent UI
  scoped to that leaf, then resumes on agree
- Result Envelope may carry a `resumption_token` so the user can
  close the tab and come back later (Executor-side checkpoint)

### Implementation expectations

| Level | Realistic minimum runtime |
|------:|---------------------------|
| 0 | ~150 LOC pure JS / Python / any language |
| 1 | A graph executor with channels + reducers (NeoGraph, LangGraph + adapter, Burr, Pydantic-AI Graph, ...) |
| 2 | Same as Level 1 + conditional dispatch |
| 3 | Same as Level 2 + interrupt-resume + checkpoint persistence |

---

## 3. Message Flow

```
  Originator                    Executor                  End User
      │                             │                         │
      │  ── (v0.3) GET /caps ──>    │                         │
      │  <── Capability Statement ──                          │
      │                             │                         │
      │  ── Task Offer (JSON) ──>   │                         │
      │                             │  ── Consent UI ──>      │
      │                             │  <── agree/decline ──   │
      │                             │                         │
      │                             │ [if agree:              │
      │                             │   fetch model / data,   │
      │                             │   run leaves,           │
      │                             │   (Level 3) interrupt   │
      │                             │   per node as needed]   │
      │                             │                         │
      │  <── Result Envelope ──     │                         │
```

In v0 the Originator is simulated by a static `graph.json`. In v0.2
it's a real Express server (`server/`). Capability negotiation lands
fully at v0.3.

---

## 4. Task Offer

The Originator's structured request to delegate work.

### 4.1 Skeleton

```json
{
  "protocol_version": "neoprotocol/0",
  "task": {
    "id": "<uuid>",
    "type": "<freeform task type, e.g. sentiment_batch>",
    "human_description": "Plain-language description for consent UI"
  },
  "graph": {
    "nodes": [ /* see §5 + §6 */ ],
    "edges": [ /* see §5 */ ],
    "interrupt_before": [ /* §2 Level 3 */ ]
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

### 4.2 Field semantics

- `runtime: "client"` on a node — Executor MUST run this node locally
  if consent given.
- `fallback_runtime: "server"` — if Executor declines or fails, the
  Originator may take over. Spec doesn't mandate the fallback runs;
  the Originator may also abandon.
- `data_locality.raw_input_visibility` — `"client_only"` means raw
  input MUST NOT leave the Executor. `"shared"` means the Originator
  may also inspect it.
- `data_locality.returns_to_originator` — whitelist of Result
  Envelope `results` keys allowed back. Anything else MUST stay on
  the Executor. (Both Executor-side and Originator-side enforcement
  are spec'd; the Executor MUST strip; the Originator MUST also strip
  defensively — the demo server does this in `index.js`.)

---

## 5. Graph Semantics (Level 1+)

### 5.1 Topology

- `nodes` — array of node objects (see §6 for shapes)
- `edges` — array of `{from, to, when?}` triples
- Special node IDs: `__start__` and `__end__`
- Fan-out: multiple edges sharing the same `from` → all destinations
  run concurrently
- Fan-in: multiple edges sharing the same `to` → executor waits for
  all upstream nodes before dispatching

### 5.2 Channels

State flows through named channels. Each channel has a reducer that
defines how concurrent writes from fan-out merge.

```json
"graph": {
  "channels": {
    "items":      { "reducer": "append" },
    "summary":    { "reducer": "replace" },
    "vote_count": { "reducer": "sum" }
  },
  "nodes": [...],
  "edges": [...]
}
```

A node declares which channels it reads / writes:

```json
{
  "id": "classify",
  "kind": "leaf",
  "reads":  ["state.items"],
  "writes": ["per_item_labels"],
  ...
}
```

### 5.3 Reducer types

| Reducer | Semantics | Level |
|---|---|---|
| `append` | New value concatenated to existing list. Use for fan-out result collection. | 1+ |
| `replace` | New value overwrites previous. Default for sequential state passing. | 2+ |
| `sum` | Numeric addition. | 2+ |
| `set_merge` | Set union (deduplicated). | 2+ |

Custom reducers deferred to v1+. Spec-defined reducer set is
intentionally narrow to keep adapter complexity low.

### 5.4 Conditional Edges (Level 2)

```json
{ "from": "classify", "to": "high_priority_handler",
  "when": { "expr": "result.urgency > 0.7" } }
```

Expression grammar (v0.3 draft, subject to refinement):
- Comparisons: `==`, `!=`, `<`, `<=`, `>`, `>=`
- Booleans: `&&`, `||`, `!`
- Field access: `result.foo.bar`
- Literals: numbers, strings, true, false, null
- **No** function calls, no arbitrary code execution

Multiple `when`-edges from same `from` evaluated in declaration order;
first match wins. An unlabeled edge is the default fallback.

### 5.5 Interrupt-Resume (Level 3)

```json
"graph": {
  "interrupt_before": ["pii_redact", "third_party_api_call"]
}
```

Before executing a listed node, the Executor MUST surface a fresh
consent UI scoped to that leaf (showing what data the node will see,
what it will do, etc.) and pause until the user responds.

- `agree` → resume execution from the interrupted node
- `decline` → Result Envelope `status: "declined"`, with
  `interrupted_at: "<node_id>"` so the Originator knows where it
  stopped

Level 3 Executors MUST persist enough state (channel values, position
in the graph) to resume after a tab close. The persistence mechanism
is Executor-defined (IndexedDB, server-side checkpoint, etc.); the
spec only requires that a `resumption_token` returned in the offer's
acknowledgment can be redeemed later for continued execution.

---

## 6. Node Implementation Models

How a leaf node tells the Executor *what to actually do*. Two
canonical models; a graph may mix them.

### 6.1 Model A — Server-described

The Originator fully specifies how to run the leaf.

```json
{
  "id": "classify",
  "kind": "leaf",
  "runtime": "client",
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

### 6.2 Model B — Executor-registered

The Executor has registered a named callable; the Originator only
references it by name + IO schema.

```json
{
  "id": "fraud_score",
  "kind": "leaf",
  "runtime": "client",
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

Best for **custom logic** that MUST stay on the Executor — proprietary
scoring, internal taxonomies, sensitive business rules. The
Originator never sees the implementation.

The Capability Statement (§7) declares which `node_name`s are
registered. The Originator MUST NOT reference an unregistered
`node_name`.

### 6.3 v0 backward-compat shorthand

The v0 sentiment-poc uses an inline `leaf_spec` field:

```json
{ "id": "classify", "kind": "leaf",
  "leaf_spec": { "task": "...", "model_options": [...] } }
```

This is syntactic sugar equivalent to `implementation.model =
"server_described"`. v0 implementations MAY accept both forms; v1
canonicalizes on `implementation`.

---

## 7. Capability Statement (v0.3)

Sent Executor → Originator before the first task offer. Cached per
origin (cache freshness rules: TBD, likely per page-load until proven
otherwise).

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
    "runtime_kinds":     ["local_onnx", "byok_api", "browser_builtin"],
    "device_support":    ["wasm", "webgpu"],
    "max_model_size_mb": 200,
    "concurrent_leaves_max": 4,
    "max_input_tokens_per_leaf": 512
  },
  "user_preferences": {
    "max_download_mb": 50,
    "byok_available": ["openai", "anthropic"]
  }
}
```

The Originator MUST NOT generate offers that exceed declared
capabilities. Mismatch → fall back to its own runtime (server-side
execution) instead of shipping an unfulfillable offer.

---

## 8. Result Envelope

Executor → Originator response.

### 8.1 Completed

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
  "results": {
    /* Only keys whitelisted by data_locality.returns_to_originator. */
  }
}
```

### 8.2 Declined / failed

```json
{
  "protocol_version": "neoprotocol/0",
  "task_id": "<uuid>",
  "status": "declined" | "failed",
  "reason": "user_declined" | "model_unavailable" | "oom" |
            "timeout" | "byok_auth_failed" | "interrupt_declined" |
            "node_unregistered" | "capability_exceeded",
  "interrupted_at": "<node_id, only when reason=interrupt_declined>"
}
```

---

## 9. Consent UI Requirements

The Executor MUST present a consent surface before any of:
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
permission API for cross-site agent task delegation (analogous to
`navigator.permissions`).

---

## 10. Versioning

`protocol_version` is `neoprotocol/<major>`. Pre-v1 the major may
break at any time; the demo and the spec evolve together. v1 is the
stability commitment — after v1, breaking changes bump major.

Major version mismatch between Originator and Executor → both sides
SHOULD refuse with `reason: "protocol_version_unsupported"`.

Conformance level is orthogonal to protocol version: all levels share
one wire format. An Executor may upgrade its level over time without
re-handshaking the protocol version.

---

## 11. Out of Scope (still deferred)

| Item | When | Notes |
|---|---|---|
| Streaming results | v1 | Leaves return partial outputs; chunked / WS transport |
| Trust / attestation | v2 | Adversarial cross-org. v0~v1 = trusted Executor (your own users) |
| Authentication / origin verification | v1 | TLS + signed offers |
| Model version pinning | v1 | Hash + revision SHA on `model_id` |
| Cancellation | v1 | Mid-execution abort propagation |
| Custom reducers | v1+ | Spec-extension mechanism; v0.3 ships the closed set in §5.3 |
| Multi-Originator coordination | v2+ | One executor session, multiple Originators (think MCP-style) |

Items previously in this list and now in scope:
- Capability negotiation (now §7)
- BYOK model option (shipped v0.1)
- Multi-node graph composition (now §5)
- Per-leaf consent gating (now §5.5 / §9)

---

## Appendix A — Spec evolution log

| Version | Section additions | Commit |
|---|---|---|
| v0 init | §1, §3 (flow), §4 (offer), §8 (envelope), §9 (consent), §10, §11 | `26dd8e8` |
| v0.3 draft | §2 (conformance levels), §5 (graph semantics), §6 (impl models), §7 (capability statement) | this commit |
