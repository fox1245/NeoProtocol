# NeoProtocol Conformance Suite

Tests anyone can run against their NeoProtocol implementation to
self-certify conformance at a given level. Language-neutral —
addresses implementations over HTTP or via CLI invocation, not via
in-process imports.

## What's covered (today)

| Suite | Level | Notes |
|---|---|---|
| `originator/level0/` | 0 | POST /tasks shape, envelope ingest, schema validation, data_locality enforcement, error mapping |
| `originator/level1/` | 1 | Deferred — lands with the multi-leaf milestone |
| `executor/level0/` | 0 | Deferred — needs mock-Originator harness |
| Interop pair test | 0 | Two Executors → same Originator → identical envelope shape |

## Run the Originator suite

Against the bundled reference Originator (`server/`):

```bash
# terminal 1 — start the implementation under test
cd ../server
npm install && npm start    # listens on :3001

# terminal 2 — run the suite
cd conformance
python3 -m pip install -r requirements.txt
python3 -m originator.level0 --base-url http://localhost:3001
```

Against any conformant Originator:

```bash
python3 -m originator.level0 --base-url http://your-server.example
```

Pass: every test case prints `OK:` and the suite ends with
`All N checks passed.` Fail: the suite prints `FAIL:` and exits
non-zero, with details.

## What "Level 0 conformant" means

An Originator implementation is **NeoProtocol/0 Level 0 conformant**
if it passes all tests in `originator/level0/`. The suite verifies:

1. `POST /tasks` accepts a JSON body with a `prompt` field and
   returns a valid Task Offer (validates against
   `server/schemas/task_offer.json`).
2. `POST /tasks` with no body / no prompt returns 4xx with a
   structured error (HTTP 400 + JSON `{error, ...}` body).
3. `GET /tasks/:id/data` after task creation returns referenced
   input data (`{items: [...]}` for sentiment_batch tasks).
4. `POST /tasks/:id/results` with a valid Result Envelope returns
   `{ack: true, ...}`.
5. `POST /tasks/:id/results` with a malformed envelope returns 400
   with structured details.
6. Non-whitelisted result fields are stripped server-side (defense in
   depth — even if the Executor misbehaves, the Originator must not
   store fields outside `data_locality.returns_to_originator`).
7. `task_id` mismatch between URL path and envelope body is rejected.
8. Unmatched / unsupported prompts produce a documented error
   response (the stub returns 422; a real LLM-backed decomposer
   may behave differently — the test verifies *some* 4xx is returned,
   not the exact code).

## Claiming conformance

Add to your README:

```markdown
This implementation passes the NeoProtocol/0 Level 0 conformance
suite (commit <suite-sha> from
https://github.com/fox1245/NeoProtocol/tree/master/conformance).
```

Self-certification only at this stage. Once the spec stabilizes at
v1, a signed conformance badge mechanism may be added.

## Roadmap

- [x] Originator Level 0
- [ ] Executor Level 0 (mock-Originator harness)
- [ ] Originator Level 1 (multi-leaf, channels, reducers)
- [ ] Executor Level 1
- [ ] Capability-statement contract test (Originator MUST NOT exceed
      declared capability)
- [ ] Round-trip test (offer → executor → envelope → originator) with
      side-by-side runs of two reference Executors against one
      Originator
