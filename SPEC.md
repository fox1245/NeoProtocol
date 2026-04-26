# NeoProtocol v0 — Specification (Draft)

> Status: v0 draft. Subject to breaking change before v1.
> This spec covers what the v0 PoC implements; deferred items are
> marked **(v1+)**.

## 1. Roles

- **Originator** — sends the Task Offer. Typically a server holding a
  frontier model. Decomposes a user request into a graph.
- **Executor** — receives the Task Offer. Typically a browser tab
  with a tiny local model (WebGPU/CPU via transformers.js). Surfaces
  consent UI, runs assigned leaves, returns Result Envelope.
- **End User** — drives consent decisions on the Executor side.

## 2. Message Flow (v0)

```
  Originator                    Executor                  End User
      │                             │                         │
      │  ── Task Offer (JSON) ──>   │                         │
      │                             │  ── Consent UI ──>      │
      │                             │  <── agree/decline ──   │
      │                             │                         │
      │                             │  [if agree:             │
      │                             │     fetch model,        │
      │                             │     run leaves]         │
      │                             │                         │
      │  <── Result Envelope ──     │                         │
      │      (or Decline)           │                         │
```

In v0 the Originator is simulated by a static `graph.json` file. The
Executor is the demo HTML page. **(v1+)** real handshake over HTTP
or WebSocket; capability negotiation before the offer.

## 3. Task Offer

The Originator's structured request to delegate work.

```json
{
  "protocol_version": "neoprotocol/0",
  "task": {
    "id": "<uuid>",
    "type": "<freeform task type, e.g. sentiment_batch>",
    "human_description": "Plain-language description for consent UI"
  },
  "graph": {
    "nodes": [
      {
        "id": "classify",
        "kind": "leaf",
        "runtime": "client",
        "fallback_runtime": "server",
        "leaf_spec": {
          "task": "text-classification",
          "model_options": [
            {
              "model_id": "Xenova/distilbert-base-uncased-finetuned-sst-2-english",
              "size_mb": 17,
              "quantized": true,
              "device_pref": ["webgpu", "cpu"]
            }
          ]
        }
      }
    ],
    "edges": []
  },
  "input_data": {
    "items": [ /* opaque to Originator if data_locality says client_only */ ]
  },
  "data_locality": {
    "raw_input_visibility": "client_only",
    "returns_to_originator": ["sentiment_distribution", "per_item_labels"]
  },
  "fallback_estimate": {
    "if_declined_originator_will": "Run via own API model",
    "estimated_cost_usd": 0.005,
    "estimated_latency_ms": 8000
  }
}
```

### Field semantics

- `runtime: "client"` — Executor MUST run this node locally if consent given.
- `fallback_runtime: "server"` — if Executor declines or fails, Originator
  takes over. **(v0)** the Originator just logs this; **(v1+)** real fallback.
- `model_options` — ordered list. Executor picks the first it supports.
  Multiple entries allow the Originator to express "either this 17MB
  model OR this 350MB model — your call".
- `data_locality.raw_input_visibility` — either `"client_only"` (raw
  data MUST NOT leave Executor) or `"shared"` (Originator may also see).
  Constrains what fields the Result Envelope may include.
- `returns_to_originator` — whitelist of result envelope keys allowed
  back. Anything else stays in Executor.

## 4. Result Envelope

Executor → Originator response. Sent (in v0, logged to console) after
local execution completes.

```json
{
  "protocol_version": "neoprotocol/0",
  "task_id": "<uuid from Task Offer>",
  "status": "completed",
  "execution": {
    "runtime": "client",
    "model_used": "Xenova/distilbert-base-uncased-finetuned-sst-2-english",
    "device": "webgpu",
    "model_load_ms": 2100,
    "inference_ms_total": 180,
    "items_processed": 12
  },
  "results": {
    "sentiment_distribution": { "positive": 7, "negative": 5 },
    "per_item_labels": [
      { "id": "r1", "label": "POSITIVE", "score": 0.998 }
    ]
  }
}
```

The `results` object MUST contain only keys listed in
`data_locality.returns_to_originator` from the offer.

### Decline / Failure

```json
{
  "protocol_version": "neoprotocol/0",
  "task_id": "<uuid>",
  "status": "declined",
  "reason": "user_declined" | "model_unavailable" | "oom" | "timeout"
}
```

## 5. Consent UI Requirements

The Executor MUST present a consent surface before fetching any model
bytes. Required elements:

1. **What** — `task.human_description`
2. **Cost to user** — model size, estimated download time
3. **Data locality** — what leaves the device, what stays
4. **Fallback** — what happens if user declines (originator's own cost / latency)
5. **Decision** — at minimum *Agree* and *Decline*. **(v0.1+)** *Use my API key*.

Any UI satisfying the above is conformant. **(v1+)** browser-native
permission API for cross-site agent task delegation.

## 6. Versioning

`protocol_version` is `neoprotocol/<major>`. Breaking changes bump major.
v0 = breaking change at any time. v1 = stability commitment.

## 7. Out of Scope (deferred)

| Item | When | Notes |
|---|---|---|
| Capability negotiation | v0.3 | Client publishes capabilities first |
| Streaming results | v1 | Leaves return partial outputs |
| Multi-node graph composition | v0.2 | Channels, reducers, fan-out |
| BYOK model option | v0.1 | User's API key for non-local leaves |
| Trust / attestation | v2 | Adversarial cross-org. v0~v1 = trusted client |
| Authentication | v1 | Origin verification |
| Model version pinning | v1 | Hash + revision SHA |
| Cancellation | v1 | Mid-execution abort |
