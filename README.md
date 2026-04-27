# NeoProtocol

[![CI](https://github.com/fox1245/NeoProtocol/actions/workflows/ci.yml/badge.svg)](https://github.com/fox1245/NeoProtocol/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Spec: neoprotocol/0](https://img.shields.io/badge/spec-neoprotocol%2F0-7d3c98)](SPEC.md)
[![Conformance: Originator L0 18/18](https://img.shields.io/badge/conformance-Originator%20L0%2018%2F18-brightgreen)](conformance/)

**Federated agent execution.** A server orchestrates, the client's
device executes the leaves. The contract between them is JSON.

## Why

Today's LLM agents run end-to-end on the server. Every classification,
embedding, and short generation crosses the network — even when the
user's laptop has a perfectly capable GPU sitting idle.

NeoProtocol partitions agent execution across a server/client boundary:

- Server: frontier-model reasoning + graph decomposition (1 call per request)
- Client: bounded leaves — sentiment, classification, embedding, short
  summarization — running on a tiny model (~17–85 MB) downloaded once
- Wire format: JSON graph spec + JSON result envelope

The economics flip:

| | Server-only | NeoProtocol |
|---|---|---|
| Inference cost (200 reviews) | ~$0.05 | ~$0.001 (decomposition only) |
| User data sent to server | full reviews | aggregate stats |
| Latency | 200 × RTT | 1 × decomposition + local |
| Scaling ceiling | server GPUs | user device count |

## How is this different from LangChain.js?

LangChain.js graphs are JavaScript. Changing orchestration means
redeploying the client. The server has no leverage to vary the topology
per-request.

NeoProtocol graphs are **JSON payloads**. The server ships a fresh graph
per request — A/B tests, free-vs-paid tiers, per-user customization
become server-side decisions with zero client redeploy. The client is
just a dynamic loader + a tiny model.

## Status

**Stage 0 PoC.** Single-page sentiment-analysis demo proving the loop:
server-shaped task offer → consent UI → local model inference →
result envelope. No real server yet — `graph.json` is static.

See [SPEC.md](SPEC.md) for the protocol draft,
[PLAN.md](PLAN.md) for the milestone-by-milestone roadmap, and
[examples/sentiment-poc/](examples/sentiment-poc/) for the demo.

## Quickstart

### Static mode (no server)

```bash
cd examples/sentiment-poc
python3 -m http.server 8000
# open http://localhost:8000 in a Chrome/Edge/Safari tab
```

The page fetches `graph.json` (a hardcoded Task Offer), shows a
consent dialog with three runtime choices (local ONNX / BYOK OpenAI
key / browser built-in AI), runs the leaves, and prints the result
envelope that would post back.

### Server mode (real round-trip)

```bash
# terminal 1 — Originator
cd server
npm install && npm start            # listens on :3001

# terminal 2 — static page
cd examples/sentiment-poc
python3 -m http.server 8000

# browser
http://localhost:8000/index.html?server=http://localhost:3001
```

The page now starts with a prompt textarea, POSTs to `/tasks`, the
stub decomposer matches the prompt to a fixture, the offer comes
back, you pick a runtime, the leaves run locally, the envelope POSTs
to `/tasks/:id/results`, and the server's ack appears in the page.
Server log records the round-trip. Server-side ajv schema validation
+ data_locality whitelist enforcement (defense in depth) along the
way.

### Known v0 limitations

- **Model domain mismatch.** DistilBERT-SST2 is trained on movie
  reviews. Product-review cues like "returning it" or "chemical smell"
  can fool it. r8 in the sample set is a known miss. This is a
  picked-model issue, not a protocol/runtime issue — swap in a product-
  domain classifier (e.g. `Xenova/twitter-roberta-base-sentiment-latest`)
  for sturdier results in your own deployment.
- **q8 + WebGPU is unsafe in transformers.js v3 browser.** The picker
  in `index.html` skips this combo (q8 → WASM EP only; WebGPU needs
  fp16/fp32). If you set `device_pref: ["webgpu"]` AND `quantized:
  true` the picker falls through to wasm.
- **No real server yet.** `graph.json` is static; result envelope is
  logged to console rather than POSTed.

## Roadmap

- **v0 (now)**: static task offer, sentiment-only PoC
- **v0.1**: BYOK path — user supplies own API key, leaves run via that
- **v0.2**: real server in `server/` (Node/Python) generating graphs
  from natural-language requests via a frontier model
- **v0.3**: capability negotiation handshake (client publishes what it
  can run before server commits to a graph)
- **v1**: streaming results, multi-node graphs, decline-fallback
- **future**: NeoGraph WASM runtime as drop-in reference engine
  (replaces ad-hoc JS leaf executor with the full graph engine)

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The Apache 2.0 license includes an explicit patent grant from each
contributor and a patent retaliation clause — chosen over MIT
specifically because protocols are vulnerable to patent troll attacks
and Apache 2.0's automatic license termination on hostile patent
litigation provides a real defense mechanism. Industry-standard for
protocols (gRPC, OpenAPI, Kubernetes API).
