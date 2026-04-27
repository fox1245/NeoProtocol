"""NeoProtocol/0 Level 0 — Originator conformance suite.

Tests an Originator implementation by exercising its HTTP surface and
asserting the responses match the spec. Stack-neutral — only HTTP +
JSON Schema, no in-process imports of the implementation.

Run:
    python3 -m originator.level0 --base-url http://localhost:3001
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import httpx
import jsonschema


# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------

PASS = "\033[32mOK:  \033[0m"
FAIL = "\033[31mFAIL:\033[0m"

_results: list[tuple[bool, str]] = []


def assert_(cond: bool, msg: str) -> None:
    _results.append((cond, msg))
    print(f"{PASS if cond else FAIL} {msg}")


def report_and_exit() -> None:
    failed = sum(1 for ok, _ in _results if not ok)
    total = len(_results)
    print()
    if failed:
        print(f"{failed}/{total} checks FAILED.")
        sys.exit(1)
    else:
        print(f"All {total} checks passed.")
        sys.exit(0)


# ---------------------------------------------------------------------------
# Schema loading
# ---------------------------------------------------------------------------

def load_schemas() -> tuple[dict, dict]:
    """Load the canonical Task Offer + Result Envelope schemas.

    Looks adjacent to the conformance/ directory in the repo. If the
    suite is being run against a remote server without local repo
    access, the user can override with --schemas-dir.
    """
    here = Path(__file__).resolve()
    # conformance/originator/level0/__main__.py → repo root is 3 up.
    repo = here.parent.parent.parent.parent
    schemas_dir = repo / "server" / "schemas"
    return (
        json.loads((schemas_dir / "task_offer.json").read_text()),
        json.loads((schemas_dir / "result_envelope.json").read_text()),
    )


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

def run(base_url: str) -> None:
    offer_schema, envelope_schema = load_schemas()
    offer_validator = jsonschema.Draft202012Validator(offer_schema)
    envelope_validator = jsonschema.Draft202012Validator(envelope_schema)

    with httpx.Client(timeout=30.0) as c:
        # ----- T0: liveness (optional but most servers ship it) -----
        try:
            r = c.get(f"{base_url}/healthz")
            assert_(r.status_code in (200, 404),
                    "T0: GET /healthz returns 200 (live) or 404 (not implemented — optional)")
        except httpx.RequestError as e:
            assert_(False, f"T0: GET /healthz network error — server up? ({e})")
            report_and_exit()

        # ----- T1: POST /tasks with a known prompt -----
        r = c.post(f"{base_url}/tasks", json={"prompt": "analyze sentiment of these reviews"})
        assert_(r.status_code == 200,
                f"T1: POST /tasks with matching prompt → 200 (got {r.status_code})")
        offer = None
        if r.status_code == 200:
            offer = r.json()

        # ----- T2: returned offer validates against task_offer schema -----
        if offer:
            errs = list(offer_validator.iter_errors(offer))
            assert_(len(errs) == 0,
                    f"T2: returned offer validates against task_offer.json schema "
                    f"({len(errs)} schema errors)")
            if errs:
                for e in errs[:3]:
                    print(f"      ↳ {e.json_path}: {e.message}")

        # ----- T3: offer has required identity fields -----
        if offer:
            assert_(offer.get("protocol_version", "").startswith("neoprotocol/"),
                    f"T3: offer.protocol_version starts with 'neoprotocol/' "
                    f"(got {offer.get('protocol_version')!r})")
            assert_(offer.get("task", {}).get("id"),
                    "T3: offer.task.id is non-empty")
            assert_(offer.get("data_locality", {}).get("returns_to_originator") is not None,
                    "T3: offer.data_locality.returns_to_originator is present")

        task_id = offer["task"]["id"] if offer else None

        # ----- T4: POST /tasks with no prompt → 4xx -----
        r = c.post(f"{base_url}/tasks", json={})
        assert_(400 <= r.status_code < 500,
                f"T4: POST /tasks with empty body → 4xx (got {r.status_code})")

        # ----- T5: POST /tasks with unmatched prompt → 4xx (decomposer-defined) -----
        r = c.post(f"{base_url}/tasks", json={"prompt": "do my taxes please"})
        assert_(400 <= r.status_code < 500 or r.status_code == 200,
                "T5: POST /tasks with out-of-scope prompt → either 4xx or "
                "a valid offer (impl-defined; a real LLM decomposer might handle it)")

        # ----- T6: GET /tasks/:id/data returns input items -----
        if task_id:
            r = c.get(f"{base_url}/tasks/{task_id}/data")
            assert_(r.status_code == 200,
                    f"T6: GET /tasks/:id/data → 200 (got {r.status_code})")
            if r.status_code == 200:
                data = r.json()
                assert_(isinstance(data.get("items"), list) and len(data["items"]) > 0,
                        "T6b: data has non-empty items[]")

        # ----- T7: POST a valid Result Envelope → 200 + ack -----
        if task_id:
            envelope = {
                "protocol_version": "neoprotocol/0",
                "task_id": task_id,
                "status": "completed",
                "execution": {
                    "runtime": "client",
                    "runtime_kind": "local_onnx",
                    "model_used": "test/conformance",
                    "device": "test",
                    "model_load_ms": 0,
                    "inference_ms_total": 1,
                    "items_processed": 1,
                },
                "results": {
                    "sentiment_distribution": {"positive": 1, "negative": 0},
                    "per_item_labels": [{"id": "r1", "label": "POSITIVE", "score": 0.99}],
                },
            }
            # First validate our test envelope against the canonical schema
            errs = list(envelope_validator.iter_errors(envelope))
            assert_(len(errs) == 0,
                    f"T7-pre: test envelope is itself schema-valid ({len(errs)} errors)")

            r = c.post(f"{base_url}/tasks/{task_id}/results", json=envelope)
            assert_(r.status_code == 200,
                    f"T7: POST valid envelope → 200 (got {r.status_code} {r.text[:100]})")
            if r.status_code == 200:
                ack = r.json()
                assert_(ack.get("ack") is True,
                        f"T7b: ack body has ack:true (got {ack})")

        # ----- T8: POST malformed envelope → 400 -----
        if task_id:
            bad = {"protocol_version": "neoprotocol/0", "task_id": task_id}  # missing status, exec, results
            r = c.post(f"{base_url}/tasks/{task_id}/results", json=bad)
            assert_(r.status_code == 400,
                    f"T8: POST malformed envelope → 400 (got {r.status_code})")

        # ----- T9: data_locality whitelist enforced server-side -----
        # Re-create a task because we may have already committed a result
        # to the previous one.
        r = c.post(f"{base_url}/tasks", json={"prompt": "sentiment"})
        if r.status_code == 200:
            new_offer = r.json()
            new_task_id = new_offer["task"]["id"]
            tainted = {
                "protocol_version": "neoprotocol/0",
                "task_id": new_task_id,
                "status": "completed",
                "execution": {
                    "runtime": "client", "runtime_kind": "local_onnx",
                    "model_used": "test", "device": "test",
                    "model_load_ms": 0, "inference_ms_total": 1, "items_processed": 0,
                },
                "results": {
                    "sentiment_distribution": {"positive": 0, "negative": 0},
                    "per_item_labels": [],
                    "secret_field_that_should_be_stripped": "this MUST NOT survive",
                },
            }
            r = c.post(f"{base_url}/tasks/{new_task_id}/results", json=tainted)
            assert_(r.status_code == 200,
                    f"T9: tainted envelope still 200 (server strips, doesn't reject) "
                    f"(got {r.status_code})")
            # Read it back via GET /tasks/:id (if implemented) and verify
            # the rogue field didn't survive.
            r = c.get(f"{base_url}/tasks/{new_task_id}")
            if r.status_code == 200:
                body = r.json()
                stored = (body.get("result") or {}).get("results") or {}
                assert_("secret_field_that_should_be_stripped" not in stored,
                        "T9b: non-whitelisted field was stripped server-side")
            else:
                print(f"      (T9b skipped — GET /tasks/:id not implemented or returned {r.status_code})")

        # ----- T10: task_id mismatch rejected -----
        if task_id:
            mismatch = {
                "protocol_version": "neoprotocol/0",
                "task_id": "totally-different-id",  # ≠ URL :id
                "status": "completed",
                "execution": {
                    "runtime": "client", "runtime_kind": "local_onnx",
                    "model_used": "test", "device": "test",
                    "model_load_ms": 0, "inference_ms_total": 1, "items_processed": 0,
                },
                "results": {"sentiment_distribution": {"positive": 0, "negative": 0}},
            }
            r = c.post(f"{base_url}/tasks/{task_id}/results", json=mismatch)
            assert_(r.status_code == 400,
                    f"T10: task_id mismatch → 400 (got {r.status_code})")

        # ----- T11: unknown task_id on results → 404 -----
        bogus_id = "00000000-0000-0000-0000-000000000000"
        envelope_for_bogus = {
            "protocol_version": "neoprotocol/0",
            "task_id": bogus_id,
            "status": "completed",
            "execution": {
                "runtime": "client", "runtime_kind": "local_onnx",
                "model_used": "test", "device": "test",
                "model_load_ms": 0, "inference_ms_total": 1, "items_processed": 0,
            },
            "results": {"sentiment_distribution": {"positive": 0, "negative": 0}},
        }
        r = c.post(f"{base_url}/tasks/{bogus_id}/results", json=envelope_for_bogus)
        assert_(r.status_code == 404,
                f"T11: POST /tasks/<unknown>/results → 404 (got {r.status_code})")


def main():
    ap = argparse.ArgumentParser(description="NeoProtocol/0 Level 0 Originator conformance suite")
    ap.add_argument("--base-url", required=True, help="Base URL of the Originator under test")
    args = ap.parse_args()
    print(f"== NeoProtocol/0 Level 0 Originator conformance ==")
    print(f"   target: {args.base_url}")
    print()
    run(args.base_url)
    report_and_exit()


if __name__ == "__main__":
    main()
