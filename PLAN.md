# NeoProtocol Improvement Plan

> Living document. Update as milestones land or assumptions shift.
> Last updated: 2026-04-26 (v0 + v0.1 + v0.2 + browser↔server wiring all
> shipped and verified via Playwright + smoke tests).

## Status snapshot

| Milestone | State    | Commits |
|-----------|----------|---------|
| v0 — single-leaf PoC | ✅ done | `26dd8e8`, `8248bef` |
| v0.1 — BYOK + Built-in runtime kinds | ✅ done | `7a6d201` |
| v0.2 — server skeleton with ajv | ✅ done | `083276e` |
| browser↔server end-to-end | ✅ done | `cbdf406` |
| spec v0.3 draft I (levels + multi-leaf + impl models + capability) | ✅ done | `7265e66` |
| spec v0.3 draft II (glossary + transport + state + errors + reliability) | ✅ done | `11bb7de` |
| **2nd independent reference impl (Python Executor)** | ✅ done | (this commit) |
| **Interop graduation** — same `graph.json` round-trips both stacks | ✅ verified | (this commit) |
| Conformance test suite | ⏳ next | — |
| Multi-leaf demo (Level 1) | ✅ done | `274f12c` |
| v0.2-B real LLM decomposer | ⏳ | — |
| v0.5 Chrome Built-in AI verified live | ⏳ (code shipped, needs flag-enabled Chrome to demo) | — |
| **Federated Mode (SPEC §16, browser↔browser ACP-over-WebRTC)** | ✅ done | `7e22473` |
| **Collaborative Workspace Stage 1** (Monaco + Y.js + per-user agent) | ⏳ next | — |
| **Collaborative Workspace Stage 2** (cross-agent ACP) | ⏳ committed | — |
| Workspace Stage 3 (FS Access API, multi-buffer) | ⏸ conditional | see [docs/roadmap-collaborative-workspace.md](docs/roadmap-collaborative-workspace.md) |
| Workspace Stage 4 (local model option) | ⏸ conditional | — |
| Workspace Stage 5 (editor surface upgrade) | ⏸ conditional | — |
| v1 streaming + multi-node | ⏳ | — |
| Tier 2 Chromium fork | ⏸ deferred | — |

### Interop check (Python ↔ Browser, same Originator)

Two independent Executors processed the same `graph.json` from the
v0.2 Originator. Identical scores (q8 ONNX is deterministic), shape-
identical Result Envelopes, server accepted both via the same ajv-
validated schema:

| | Browser Executor | Python Executor |
|---|---|---|
| Stack | JS + transformers.js + ONNX Web (WASM) | Python + optimum + ONNX Runtime (native CPU) |
| Model bytes | `Xenova/.../onnx/model_quantized.onnx` (q8) | same |
| Model load | ~8 s first / ~1 s cached | ~35 s first / ~2.3 s cached |
| Inference per item | 34 ms (wasm) | 10 ms (native) |
| r1 "Five stars, would buy again" | POSITIVE 0.9916 | POSITIVE 0.9916 |
| r2 "Arrived broken" | NEGATIVE 0.9991 | NEGATIVE 0.9991 |
| r12 "Absolutely love it" | POSITIVE 0.9998 | POSITIVE 0.9998 |

This is the *graduation* from "specification + reference
implementation" to "specification with interop-validated
implementations" — IETF's ≥2 independent interoperating
implementations criterion (RFC 2026 / Internet Standards Process).

## What's true today (v0)

Shipped in commits `26dd8e8` (init) and `8248bef` (q8/WebGPU fix):

- `SPEC.md` — v0 protocol draft. Task Offer, Result Envelope,
  Consent UI requirements. Deferred items explicitly flagged.
- `examples/sentiment-poc/` — single-page demo, no server. Static
  `graph.json` simulates the offer; transformers.js + DistilBERT-SST2
  q8 (~17 MB) on WASM EP, ~8s first load (cached after), ~34 ms per
  classification. 11/12 correct on the sample (r8 misses — known
  out-of-domain SST-2 weakness, not a protocol bug).
- `data_locality.returns_to_originator` whitelist enforced at envelope
  build time — fields not in the whitelist are dropped before logging.
- Decline path simulates "originator falls back to its own model"
  with cost/latency estimate from the offer.

**Hard lessons from v0:**

1. q8 + WebGPU is a silent-garbage trap in transformers.js v3 browser.
   See `feedback_transformers_js_q8_webgpu` memory.
2. Always validate model output against ground truth before declaring
   a demo "works" — UI rendering correctness ≠ inference correctness.
3. SST-2 is movie-domain. Product reviews need a domain-matched
   classifier for production-grade results.

## Working ladder

```
   ┌─ v0    static offer, JS PoC                        [DONE]
   │
   ├─ v0.1  BYOK path (user's own API key)              [next, ~2h]
   │
   ├─ v0.2  real server: NL → graph decomposition       [~1-2 days]
   │
   ├─ v0.3  capability negotiation handshake            [~1 week]
   │
   ├─ v0.5  Chrome Built-in AI integration (parallel)   [~half day]
   │
   ├─ v1    streaming, multi-node graphs, real fallback [~3-4 weeks]
   │
   └─ Tier 2 (deferred — fire only on identified wall):
        Chromium fork for primitives JS can't reach
```

---

## v0.1 — BYOK ("Bring Your Own Key") path

**Why:** the protocol claims a third option in the consent UI ("use my
own API key") but v0 only ships Agree / Decline. v0.1 closes that gap
and proves the offer's `model_options` array can express heterogeneous
runtimes (local model OR remote API).

**Schema additions:**

```json
{
  "leaf_spec": {
    "model_options": [
      { "model_id": "Xenova/distilbert-...", "size_mb": 17, "runtime_kind": "local_onnx" },
      { "model_id": "openai/gpt-4o-mini",    "runtime_kind": "byok_api",
        "byok_provider": "openai",
        "prompt_template": "Classify sentiment of: {text}\nReply POSITIVE or NEGATIVE." }
    ]
  }
}
```

**Implementation steps:**

1. Add `runtime_kind` discriminator to `model_options` entries.
2. New consent button: "Use my OpenAI key" → modal collects key,
   stored in `sessionStorage` only (never POSTed to originator).
3. Implement `byokOpenAIClassifier(prompt_template, items)` — fetch
   to `api.openai.com/v1/chat/completions` with user's key, parse
   POSITIVE/NEGATIVE from response.
4. Result envelope `execution.runtime` becomes `"byok"`, with sub-
   field `byok_provider: "openai"`.
5. Update SPEC.md §2 message flow to show the BYOK branch.

**Open questions for v0.1:**

- Should the originator be told *which* BYOK provider was used? Yes
  (for cost accounting transparency) — add to result envelope.
- Should the originator know the user's key? **No, ever.** Document
  this as a hard invariant in SPEC.md.
- What if the user supplies a wrong key? Return a Decline envelope
  with `reason: "byok_auth_failed"`.

**Effort:** ~2 hours including SPEC update. Demoable: same sentiment
batch but switching between local DistilBERT and user's GPT-4o-mini.

---

## v0.2 — Real server: NL → graph decomposition

**Why:** v0/v0.1 use a static `graph.json`. The real protocol value
lands when the server actually decomposes a natural-language request
into the graph, ideally driven by a frontier model. This is the first
end-to-end demo of "user prompt → originator decomposition →
executor leaves → server reassembly".

**New components:**

- `server/` — Node.js + Express (or Python + FastAPI; pick by user
  preference). Three endpoints:
  - `POST /tasks` body `{ "prompt": "Analyze these 200 reviews..." }`
    → returns Task Offer JSON. Internally calls Anthropic Claude
    Opus 4.7 (or GPT-5.5) to plan the graph.
  - `GET /tasks/{id}/data` → returns input data referenced by offer.
  - `POST /tasks/{id}/results` → accepts Result Envelope, validates
    against the original offer, stores aggregate response.
- `server/decomposer.js` — prompt template + JSON schema that asks
  the frontier model to emit a Task Offer conforming to SPEC.md.

**Implementation steps:**

1. Stand up server skeleton. CORS open to `localhost:8000` for the
   PoC page.
2. Write decomposer prompt + structured-output schema. Use Anthropic
   tool calling so the schema is enforced. Validate output against
   `schemas/task_offer.json` (also written in this milestone).
3. Update `index.html` to call `POST /tasks` instead of fetching
   `graph.json`. Form: textarea for the prompt + a submit button.
4. After local execution, `POST /tasks/{id}/results` instead of just
   logging. Server displays the reassembled response.
5. Demo workload: paste a list of reviews into the textarea →
   server decomposes → consent → local classify → server returns
   "summary: 8 positive, 4 negative; key complaints: chemical smell,
   broken on arrival".

**Open questions for v0.2:**

- Where does the server get its model API key? `.env` file. Document
  that production deployments need a secrets manager.
- How does the server bound decomposition cost? Hard cap on input
  size + 1 frontier-model call per request.
- What if the frontier model emits an invalid offer? Server returns
  500, logs the offer for inspection. Don't auto-retry.

**Effort:** ~1-2 days. Most time goes into the decomposer prompt
(getting the frontier model to reliably emit conformant JSON).

---

## v0.3 — Capability negotiation handshake

**Why:** v0.2 assumes the originator can guess what the executor can
run. In reality the executor's capabilities (device, RAM, models
already cached, throughput) need to be communicated *before* the
offer is generated, so the originator can size the graph correctly.

**New message: Capability Statement (client → server)**

```json
{
  "protocol_version": "neoprotocol/0",
  "capabilities": {
    "devices": ["wasm", "webgpu"],
    "max_model_size_mb": 200,
    "cached_models": ["Xenova/distilbert-...", "Xenova/all-MiniLM-..."],
    "approx_inference_tps": 50,
    "concurrent_leaves_max": 4,
    "max_input_tokens_per_leaf": 512
  },
  "user_preferences": {
    "max_download_mb": 50,
    "byok_available": ["openai"]
  }
}
```

**Implementation steps:**

1. Add `POST /capabilities` server endpoint, body = above schema.
   Server stores per-session.
2. Update `POST /tasks` to look up capabilities and feed them into
   the decomposer prompt: "the executor can run X, Y, Z; size your
   graph accordingly."
3. Browser side: gather capabilities on page load (feature-detect
   WebGPU, query IndexedDB for cached models, run a quick MiniLM
   throughput probe), send before the user types a prompt.
4. SPEC.md §2 — add a Phase 0 "Capability handshake" before the
   message flow.

**Open questions for v0.3:**

- Capability staleness: cache for how long? Per-page-load is safest.
- Does the user need to consent to capability disclosure? Probably
  yes for `cached_models` (reveals previous task history).
  Strip-by-default; opt-in disclosure for performance hints.
- How does the originator handle a capability mismatch (offer
  requires bge-large but client only has MiniLM)? Negotiation
  retry? For v0.3, just fail with a Decline envelope and let the
  originator pick a smaller model.

**Effort:** ~1 week. Most time on browser-side capability detection
and the decomposer's adaptive sizing logic.

---

## v0.5 — Chrome Built-in AI integration (parallel track)

**Why:** Chrome shipped `window.LanguageModel` (Prompt API) on
Gemini Nano in late 2024. It's a browser-managed local model with
native consent — exactly the pattern NeoProtocol describes. v0.5
adds it as a `runtime_kind: "browser_builtin"` option alongside the
transformers.js path.

**Implementation steps:**

1. Feature-detect `window.LanguageModel` (or whatever the stable API
   surface is — verify against current Chrome canary at impl time).
2. Add a `browser_builtin` model option in `graph.json` for
   sentiment classify. Use prompt template "Reply POSITIVE or
   NEGATIVE only: {text}".
3. Wire picker to honor `runtime_kind: "browser_builtin"` when
   available.
4. Compare end-to-end:
   | path | model | size | first-load | per-item |
   |---|---|---|---|---|
   | transformers.js | DistilBERT-SST2 | 17 MB | ~8 s | 34 ms |
   | browser_builtin | Gemini Nano | 0 MB (preinstalled) | 0 s | TBD |

**Open questions:**

- Is the browser_builtin API stable enough to depend on? Origin
  trial vs shipped? Verify at impl time.
- Does Gemini Nano even produce "POSITIVE/NEGATIVE only" reliably
  for short prompts? Probably yes, but worth measuring.
- Browser support is Chrome-only as of writing. Document as a
  capability the executor declares (not a baseline assumption).

**Effort:** ~half day. Mostly verification + benchmarking.

---

## v1 — Streaming, multi-node graphs, real fallback

**Why:** v0 → v0.3 are all single-leaf, batch-mode. The protocol's
real value emerges with composed graphs (fan-out + reduce, sequential
chains with fallback per-node). v1 ships these.

**New machinery:**

- **Streaming results** — chunked HTTP responses or WebSocket for the
  client → server result post. Each leaf completion streams a partial
  envelope. Server reassembles incrementally.
- **Multi-node graphs** — first non-trivial topology: 2 leaves
  parallel (sentiment + topic extract) → 1 server reducer (cluster +
  summarize). Tests channel/reducer semantics.
- **Real fallback** — if leaf returns Decline with
  `reason: "model_unavailable"`, server picks up that node via its
  own API model. Result envelope distinguishes which nodes ran where.
- **Cancellation** — client can abort mid-execution; partial results
  flushed.

**Implementation steps:**

1. Move from REST to WebSocket for the task lifecycle. Open question:
   keep REST for offer/results envelope, WS only for streaming?
2. Add `Reducer` node kind to graph spec. Server-side reducer
   receives streamed leaf outputs, emits final result.
3. Implement node-level fallback dispatch. Add `fallback_runtime`
   semantics to the executor.
4. Multi-leaf demo: "summarize this 200-review batch" — sentiment
   leaves + topic leaves in parallel client-side, summary node
   server-side.

**Open questions:**

- Is the right transport HTTP/2 server-sent events, WebSocket, or
  HTTP/3? Defer to whichever is simplest first; can change later.
- How does the executor express "this leaf failed transiently, retry"
  vs "this leaf will never succeed, fall back"? Reason codes.

**Effort:** ~3-4 weeks. Real engineering, not a weekend.

---

## Tier 2 (deferred) — Chromium fork

**Status:** not pursued. Discussed in conversation, deferred until a
specific wall is identified that browser-native primitives could
solve and JS/extensions cannot.

**Trigger conditions** — fork only when one of these is hit:

1. Need cross-origin shared model cache (no JS API exists; service
   workers cache per-origin).
2. Need a privileged sandbox to run server-shipped leaf code with
   different security boundaries than page JS.
3. Need native consent UI for cross-site agent task delegation
   (`chrome.permissions` doesn't cover this case).
4. Need network-layer protocol enforcement (HTTP intercept, signing).
5. Need attestation primitives (browser signs result envelopes).

**Cheaper alternatives to investigate first:**

- Chromium extension (covers most of (1)-(3) with chrome.permissions
  + service worker + native messaging).
- WICG / TAG explainer for standardization (skip the fork, propose
  the missing primitive instead).
- Build instrumentation against existing Chromium source as
  reference, but don't ship a fork.

---

## Cross-cutting

### Schema versioning

- `protocol_version` is `neoprotocol/<major>` until v1, then SemVer.
- v0 = breaking change at any time.
- v1 = stability commitment. Pre-v1 schema changes documented in
  CHANGELOG.md (file to be created at v0.2).
- Major version mismatch between client and server → both sides
  refuse with `"reason": "protocol_version_unsupported"`.

### Validation

- v0.2 milestone adds JSON Schema files in `schemas/` for Task
  Offer and Result Envelope.
- Server validates outgoing offers + incoming envelopes.
- Browser validates incoming offers (refuses malformed ones).
- Test fixtures: known-good offers + envelopes + fuzz cases.

### Browser compatibility

Track in `docs/compat.md` (create at v0.2). Initial matrix:

| Feature | Chrome | Edge | Safari | Firefox |
|---|---|---|---|---|
| transformers.js + WASM | ✅ | ✅ | ✅ | ✅ |
| transformers.js + WebGPU | ✅ | ✅ | 17.4+ | flags |
| `window.LanguageModel` | 127+ | TBD | ❌ | ❌ |
| WebSocket streaming | ✅ | ✅ | ✅ | ✅ |

### Privacy / security review

Before declaring v1: walk through threat model document.

- Is `data_locality.returns_to_originator` truly enforced? (Currently
  yes, at envelope-build time, but easy to bypass if we add free-form
  fields. Lock down.)
- BYOK key handling: never logged, never POSTed, sessionStorage only.
- Origin verification: how does executor know the originator is who
  it claims? TLS + origin checks for v1.
- Replay: does the protocol need nonces / timestamps? Probably yes
  for v1.

### Sample workloads (demo wishlist)

Pick 3 for the v0.2 / v1 milestones to drive concrete demos:

- ✅ Batch sentiment (v0)
- Email triage: 200 emails → priority labels + draft replies
- RAG over local docs: embeddings + retrieval client-side, summary
  server-side
- PII redaction → cloud follow-up: client redacts, server processes
  redacted, returns enriched
- Real-time content moderation: live stream of user comments,
  client-side first-pass, server confirms only flagged

### Standardization path (long horizon)

Three options, ranked by ambition:

1. **Just publish the spec.** Single repo, BSD-style "this is what
   we built, here's how it works." Anyone can implement.
2. **WICG explainer.** Web Incubator Community Group is the standard
   path for new web platform primitives. Requires implementer
   interest.
3. **W3C TAG.** Technical Architecture Group review. Heavyweight,
   reserved for genuinely cross-cutting platform changes. Not a
   v1 concern.

For now: option 1 implicitly via this repo. Option 2 once we have
real adoption signal (multiple deployments, browser vendor interest).
