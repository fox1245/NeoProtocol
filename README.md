# NeoProtocol

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

```bash
cd examples/sentiment-poc
python3 -m http.server 8000
# open http://localhost:8000 in a Chrome/Edge/Safari tab
```

The page fetches `graph.json` (the simulated task offer), shows a
consent dialog, and on agree downloads ~17 MB DistilBERT-SST2 via
transformers.js, runs sentiment classification on 12 sample reviews
locally, and prints the result envelope that would post back.

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

MIT. See [LICENSE](LICENSE).
