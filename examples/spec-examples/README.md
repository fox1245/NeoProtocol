# Spec-only worked examples

JSON fixtures illustrating protocol features that the running demos
(`sentiment-poc/`, `multi-leaf-poc/`, `python-executor/`) don't yet
exercise. Each fixture **validates against the canonical JSON Schemas**
in `server/schemas/` — run `node validate.mjs` from this directory's
parent (or `node examples/spec-examples/validate.mjs` from repo root)
to confirm.

These are reference artifacts, not runnable applications. They
demonstrate the *shape* the spec promises; an Executor that supports
the listed Conformance Level (and the listed registered nodes) would
process them end-to-end.

## Index

| # | Title | Level | Features highlighted |
|---|---|---|---|
| 01 | [Email triage batch](#01-email-triage-batch) | 1 | Large fan-out (200 items), mixed Model A + Model B, channel reducer (`append`), three impl options per leaf (local, BYOK OpenAI, BYOK Anthropic) |
| 02 | [PII-redact + conditional cloud answer](#02-pii-redact--conditional-cloud-answer) | 2 | Conditional edges (`when` predicates), full Model B chain on device, T1/T3 capability split via complexity gate |
| 03 | [Clinical scribe with interrupt](#03-clinical-scribe-with-interrupt) | 3 | `interrupt_before` per-leaf consent, sensitive-action gating, deeply chained Model B nodes for healthcare-specific logic |

---

## 01 — Email triage batch

**Workload**: 200 customer-support emails, classify by intent and
extract action items, score priority, return only the priority-sorted
list + intent counts to the Originator. Raw email bodies stay on the
device.

**Why this matters**: Tier-1 enterprise use case. Classical
"server-only" architecture would post 200 emails (sensitive customer
data) to a cloud LLM and pay per-message inference fees. NeoProtocol
keeps the bodies local and pays for *one* server-side decomposition
call only.

**Conformance level**: Level 1 (multi-leaf, fan-out, channel reducer).

**Notable graph features**:
- Two parallel leaves (`classify_intent` + `extract_action_items`)
  fan out from `__start__`.
- Both write to `append`-reducer channels so concurrent results
  accumulate cleanly.
- `score_priority` (Model B, `neoprotocol.builtin.priority_scorer`)
  reads both upstream channels.
- `summarize` (Model B reducer node) condenses everything into the
  whitelisted output shape.
- Each leaf carries multiple `model_options`: a local ONNX model and
  a BYOK API alternative. The Executor picks one at runtime.

**Files**:
- [`01-email-triage.offer.json`](01-email-triage.offer.json) — Task Offer
- [`01-email-triage.envelope.json`](01-email-triage.envelope.json) — example Result Envelope

---

## 02 — PII-redact + conditional cloud answer

**Workload**: A clinician asks a natural-language clinical question
that includes patient identifiers. PII detection + redaction happen
on device. A complexity score then decides:

- **Simple query** → answered by the browser's built-in AI (Gemini
  Nano), no network call.
- **Complex query** → the redacted question goes to the user's
  Anthropic API key for Claude 3.5 Sonnet.

Either way, the Originator never sees identifiers, and the user pays
their own API bill for the cloud branch.

**Why this matters**: Demonstrates the T1 / T3 capability split the
protocol is designed for — local model handles cheap workloads,
frontier model handles the rest, both gated by data locality.

**Conformance level**: Level 2 (conditional edges with `when`
predicates).

**Notable graph features**:
- Linear chain (`detect_pii` → `redact` → `score_complexity`) feeds
  a *branching point*.
- Two outgoing edges from `score_complexity` carry `when`
  expressions:
  - `when: { "expr": "complexity.score < 0.5" }` → `answer_local`
  - `when: { "expr": "complexity.score >= 0.5" }` → `answer_cloud`
- `answer_local` uses `runtime_kind: "browser_builtin"`; `answer_cloud`
  uses `runtime_kind: "byok_api"`. Both have `runtime: "client"`
  because the Executor (browser) drives the call in either case —
  the BYOK fact is in the runtime_kind, not the runtime.
- The `answer` channel is `replace`-reducer, so whichever branch
  wins overwrites with its result.

**Files**:
- [`02-pii-redact-conditional.offer.json`](02-pii-redact-conditional.offer.json)
- [`02-pii-redact-conditional.envelope.json`](02-pii-redact-conditional.envelope.json) — sample envelope showing the `answer_cloud` branch was taken (`execution_path` recorded)

---

## 03 — Clinical scribe with interrupt

**Workload**: A clinician records dictation about a patient. The
Executor transcribes (local Whisper-tiny), detects PHI, de-identifies,
and formats for EHR submission — all on device. **Before** the
de-identified payload is sent to the EHR vendor's API, the Executor
pauses and surfaces a per-leaf consent UI: "About to submit this
de-identified note to Epic. OK?" The clinician retains a per-submission
veto.

**Why this matters**: The interrupt-resume pattern (§7.5) is the
spec's answer to a real concern — auto-running multi-step pipelines
that include sensitive external API calls. Per-leaf consent makes
sensitive boundaries explicit without breaking the orchestration.

**Conformance level**: Level 3 (interrupt_before, resumption).

**Notable graph features**:
- `graph.interrupt_before: ["submit_to_ehr"]` — the spec's signal
  that the Executor MUST pause before this node.
- The clinician-facing UI shows the *de-identified* `ehr_payload`
  (not the original transcript) at the consent surface — this is
  the consent UX requirement of §11 applied per-leaf.
- All non-`submit_to_ehr` nodes are Model B (`executor_registered`)
  pointing at proprietary in-clinic logic — `internal.medical.phi_ner`,
  `internal.ehr.soap_formatter_v2`, `internal.ehr.epic_submit_v3`.
  These are referenced *by name* only; the Originator never sees
  the implementations.
- The accompanying envelope shows the *declined* outcome — the
  clinician reviewed the de-identified payload at the consent UI
  and clicked decline. `nodes_executed` lists the four nodes that
  did run; `interrupted_at: "submit_to_ehr"` localizes the stop.

**Files**:
- [`03-clinical-scribe-interrupt.offer.json`](03-clinical-scribe-interrupt.offer.json)
- [`03-clinical-scribe-interrupt.envelope.json`](03-clinical-scribe-interrupt.envelope.json) — sample envelope for the *declined* path

---

## Validating fixtures

```bash
# from repo root
node examples/spec-examples/validate.mjs
```

Expected output:

```
OK   01-email-triage.envelope.json
OK   01-email-triage.offer.json
OK   02-pii-redact-conditional.envelope.json
OK   02-pii-redact-conditional.offer.json
OK   03-clinical-scribe-interrupt.envelope.json
OK   03-clinical-scribe-interrupt.offer.json
```

If a fixture fails, the validator prints the JSON Schema error path
and message so the divergence (in the spec or in the fixture) is
immediately localizable.

## Adding new examples

1. Drop `<NN>-<short-name>.offer.json` + `<NN>-<short-name>.envelope.json`
   in this directory. Use the next free `NN`.
2. Add an entry to the index above.
3. Run the validator.
4. (Optional) If the example demonstrates a feature already covered by
   one of the running demos, link to that demo from the description.
