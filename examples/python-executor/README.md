# Python Executor — second independent reference implementation

Why this exists: until two *independent* implementations interoperate
on the same wire format, NeoProtocol is just a spec + reference impl,
not yet a deployed protocol (see SPEC §2 and the spec evolution log).

This Executor is *intentionally* a different stack from the browser
demo:

| Layer | Browser Executor | Python Executor (this) |
|---|---|---|
| Language | JavaScript | Python 3.12 |
| HTTP client | `fetch` | `httpx` |
| ML runtime | transformers.js v3 → ONNX Runtime Web (WASM EP) | optimum + ONNX Runtime (Python, native) |
| Tokenizer | `@huggingface/transformers` JS port | `transformers` (HF Python) |
| Model loading | CDN download via browser cache | HuggingFace Hub via `huggingface_hub` cache |
| Consent surface | HTML buttons + modal | terminal prompt |

Same `graph.json` ships from the same Originator. Same model
(`Xenova/distilbert-base-uncased-finetuned-sst-2-english`,
quantized q8). Same Result Envelope shape goes back. If both clients
produce conformant envelopes that the Originator accepts, the spec
has interop'd.

## Conformance claim

NeoProtocol/0 — **Level 0**, **Model A** only, **runtime_kind:
local_onnx**.

Not implemented:
- BYOK (could be added — would just call OpenAI from Python)
- Browser built-in AI (n/a in Python)
- Multi-leaf graphs (Level 1+) — coming with the multi-leaf demo

## Run

In one terminal, the Originator:

```bash
cd ../../server
npm install      # if first time
npm start        # listens on :3001
```

In another terminal, this Executor:

```bash
cd examples/python-executor
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python executor.py \
  --server http://localhost:3001 \
  --prompt "analyze sentiment of these reviews"
```

Add `--auto-agree` to skip the consent prompt (CI mode).

## What you'll see

```
[python-executor] POST http://localhost:3001/tasks
[python-executor] Got task <uuid>
[python-executor] Fetched 12 input items

==== Task Offer received ====
  Task:                [stub-decomposer matched sentiment_batch] analyze sentiment ...
  Items:               12
  Leaf:                classify (runtime=client)
  Model (local_onnx):  Xenova/distilbert-base-uncased-finetuned-sst-2-english
  Model size:          17 MB (quantized)
  Raw data:            client_only
  Returns to server:   sentiment_distribution, per_item_labels
  If declined:         Run via OpenAI gpt-4o-mini (~$0.0048, ~8000ms)
=============================
Run locally? [Y/n] y

[python-executor] Loading Xenova/... via optimum.onnxruntime …
[python-executor] Loaded in <ms> (dtype=q8)
[python-executor] Classifying 12 items …
[python-executor] Inference done in <ms>ms
[python-executor] Server ack: {'ack': True, 'task_id': '...', 'accepted_at': '...'}

==== Result envelope (sent to Originator) ====
{ ... }
```

Server log (in the Originator terminal) will show:

```
[POST /tasks] new task <uuid> (type=sentiment_batch)
[POST /tasks/<uuid>/results] status=completed runtime_kind=local_onnx items=12
```

Same shape as the browser-side run — proving the spec is the contract,
not "whatever the JS client happens to do".

## Why this matters

When this works end-to-end, the spec graduates from
"specification + reference implementation" (HTTP/1.0 in 1990, MCP at
launch) to "specification with interop-validated implementations"
(IETF "Internet Standard" criterion: ≥2 independent interoperating
implementations).

That's the ticket from "design document" to "real protocol".

## Why optimum + onnxruntime (and not just `transformers`)

We could have used `transformers.pipeline('sentiment-analysis')` and
let it pull torch + the original DistilBERT-SST2 weights. We chose
optimum + onnxruntime instead because:

1. It loads the **same ONNX bytes** the browser does (Xenova's q8
   export). That's a tighter interop demonstration than "different
   model variant in different stack".
2. No torch dependency — much lighter wheel install for users who
   want to actually run this.
3. The runtime difference (Python ORT vs JS ORT-Web) is exactly the
   kind of variation NeoProtocol claims to abstract over.
