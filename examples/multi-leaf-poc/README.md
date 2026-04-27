# Multi-Leaf PoC — Level 1 expressiveness

The Level 0 sentiment-poc is intentionally a single classifier behind
the consent gate. This example exercises the parts of the spec that
the toy demo can't reach:

- **§7.1 Topology** — fan-out + fan-in (one __start__ → two parallel
  leaves → one reducer → __end__)
- **§7.2 Channels** — four named channels with declared reducers
- **§7.3 Reducers** — `append` (for accumulating per-item leaf
  outputs) and `replace` (for the final aggregate)
- **§8.1 + §8.2 mixed implementation models** — `classify_sentiment`
  and `extract_keyword` are Model A (server-described); `aggregate` is
  Model B (executor-registered, references
  `neoprotocol.builtin.zip_and_count` which the executor pre-registers)

Same v0.2 protocol; no spec changes. Pure JS executor — no NG WASM, no
optimum, no transformers.js for the keyword extractor (uses a 30-line
heuristic). The sentiment leaf still uses transformers.js + DistilBERT-
SST2 for the same q8 ONNX bytes the Level 0 demo loads.

## Run

```bash
cd examples/multi-leaf-poc
python3 -m http.server 8800
# open http://localhost:8800 in a Chromium-based browser
```

Click **Agree — run all leaves locally**. The page:

1. Loads `graph.json` (the offer) and `reviews.json` (12 product reviews)
2. Loads DistilBERT-SST2 q8 (~17MB cold; cached after)
3. Walks the graph: starts both leaves in parallel, waits for both to
   finish, then runs the aggregate reducer
4. Renders per-review label+topic, the topic→sentiment matrix, and the
   filtered Result Envelope

## What you'll see

```
Topic        | Positive | Negative
-------------|----------|----------
headphone    |    1     |    0
battery      |    0     |    1
sound        |    1     |    1     ← same topic, conflicting sentiment
bluetooth    |    1     |    1     ← same topic, conflicting sentiment
noise        |    1     |    0
comfortable  |    1     |    0
microphone   |    0     |    1
build        |    1     |    0
cushions     |    0     |    1
```

The "split" rows (sound, bluetooth) are the *actual value* of a
topic-sentiment matrix — they expose contradictions in customer
feedback that pure sentiment averages would hide.

## What the executor is doing under the hood

`index.html` ships a ~80-line `GraphExecutor` class:

- Builds a topological run order using the `edges` list
- Runs all currently-ready nodes in parallel via `Promise.all` (Level 1
  fan-out)
- Applies channel reducers per `graph.channels[*].reducer`
- Looks up Model A leaves in a local runners map; Model B leaves in a
  pre-registered nodes map
- Builds the Result Envelope at the end and applies the
  `data_locality.returns_to_originator` whitelist

This is the same executor pattern any v0.3 Level 1+ implementation
needs. It's intentionally written from scratch (no NG/LangGraph
dependency) to demonstrate that pure JS in ~80 lines is enough for
Level 1 conformance.

## Conformance claim

NeoProtocol/0 — **Level 1**, mixed Models A + B, runtime_kind:
local_onnx for the sentiment leaf, executor-registered for the
reducer. Static graph (no conditional edges → does not exercise
Level 2). No interrupts (does not exercise Level 3).

## Limitations

- Keyword extraction is a stopword-filtered heuristic. A real Level 1+
  deployment would put a tiny model in `extract_keyword`'s
  `model_options` (e.g., a quantized KeyBERT or a tiny TF-IDF service).
- No real Originator (still static graph.json). Wiring this demo to
  the v0.2 server is mechanical (same pattern as sentiment-poc's
  `?server=URL` mode) but adds noise for a Level-1-focused demo.
- Pure JS executor — no checkpointing (Level 3 territory).
