# NeoProtocol Server (v0.2 skeleton)

Minimal Originator implementation. Accepts a natural-language prompt
over HTTP, decomposes it into a `Task Offer`, and validates incoming
`Result Envelopes` against the SPEC.

**Status: stub.** The decomposer pattern-matches prompts against
fixtures rather than calling a frontier model. v0.2-B will swap the
body of `decomposer.js` for a real LLM call without changing the
signature.

## Run

```bash
cd server
npm install
npm start            # listens on :3001 (override via PORT env)
```

In another terminal:

```bash
npm run smoke        # end-to-end check against the running server
```

## Endpoints

| Method | Path                   | Body                | Returns                             |
|--------|------------------------|---------------------|-------------------------------------|
| POST   | /tasks                 | `{ "prompt": "…" }` | Task Offer JSON                     |
| GET    | /tasks/:id             | —                   | Stored offer + result + createdAt   |
| GET    | /tasks/:id/data        | —                   | Input data referenced by the offer  |
| POST   | /tasks/:id/results     | Result Envelope     | `{ "ack": true, "accepted_at": … }` |
| GET    | /healthz               | —                   | Liveness probe                      |

CORS is wide open. Tighten before any non-localhost deployment.

## Try it

```bash
# 1. submit a prompt
curl -s -X POST http://localhost:3001/tasks \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"analyze sentiment of these reviews"}' | jq .

# 2. fetch the data referenced by the returned offer
curl -s http://localhost:3001/tasks/<task-id>/data | jq .

# 3. POST a result envelope
curl -s -X POST http://localhost:3001/tasks/<task-id>/results \
  -H 'Content-Type: application/json' \
  -d @envelope.json | jq .
```

## What this guarantees

- **Offer schema validation** — decomposer output is run through ajv
  against `schemas/task_offer.json`. A misshapen offer returns 500
  with the schema errors logged server-side; the client never sees
  invalid offers.
- **Envelope schema validation** — incoming envelopes are validated
  against `schemas/result_envelope.json`. Malformed envelopes get 400
  with structured details.
- **Defense-in-depth data_locality enforcement** — any field in
  `envelope.results` that isn't whitelisted by the offer's
  `data_locality.returns_to_originator` is stripped server-side
  before storage. Logged so an audit trail exists. The client should
  already strip these (`index.html` does), but a misbehaving or
  compromised client can't leak via this path.
- **task_id integrity** — envelopes whose `task_id` doesn't match the
  URL are rejected (400).

## What it doesn't do (deferred)

- No persistence — restart wipes state. v1 swaps for a real DB.
- No origin verification / signing. v1 adds these.
- No streaming results — single POST submits the whole envelope.
- No real LLM decomposition — see the next subsection.
- No capability negotiation — that's v0.3.

## Wiring up a real LLM decomposer (v0.2-B)

`decomposer.js` exports `decompose(prompt) → Task Offer`. To replace
the stub with a real implementation:

1. Pick a provider (Anthropic / OpenAI). Use structured-output / tool
   calling so the schema is enforced at the model boundary.
2. Pin `schemas/task_offer.json` as the response schema.
3. Build a system prompt that explains the protocol, the available
   `runtime_kind` values, and what kinds of leaf tasks are reasonable
   to delegate (small bounded operations only — no chains).
4. Keep the existing ajv validation as a backstop in case the model
   produces a non-conformant offer.
5. Add a `.env` for the API key (and gitignore it).

Until that's wired up, the stub matches on a small whitelist of task
types — currently only `sentiment_batch`. To add another, drop a
fixture in `fixtures/` and a pattern in `decomposer.js` `PATTERNS`.
