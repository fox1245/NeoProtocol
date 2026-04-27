"""NeoProtocol Executor — Python reference implementation.

Goal: prove the spec is implementation-agnostic by running the same
graph.json that the browser executor handles, in a completely different
stack:
  - Python instead of JavaScript
  - optimum + onnxruntime (Python) instead of transformers.js (browser)
  - synchronous HTTP via httpx instead of fetch
  - CLI interface instead of consent UI (deferred — see "Consent" below)

If this Executor and the browser Executor produce conformant Result
Envelopes against the same Originator, the protocol has graduated from
"spec + reference impl" to "spec + interop-validated".

Conformance: NeoProtocol/0 Level 0, Model A only, runtime_kind = local_onnx.
Other runtime_kinds (byok_api, browser_builtin) are not implemented here.

Consent in v0.1 spec terms: this Executor is operator-driven (the user
runs `python executor.py` knowing it will fetch a model and post results
back). The CLI prompt before --auto-agree fulfills the §11 Consent UI
requirements (showing model size, data locality, fallback estimate)
even though the surface is text rather than HTML.

Run:
    pip install -r requirements.txt
    python executor.py --server http://localhost:3001 \
                       --prompt "analyze sentiment of these reviews"
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Any

import httpx
from optimum.onnxruntime import ORTModelForSequenceClassification
from transformers import AutoTokenizer


PROTOCOL_VERSION = "neoprotocol/0"


# ---------------------------------------------------------------------------
# Consent surface (§11)
# ---------------------------------------------------------------------------

def render_consent(offer: dict, num_items: int) -> None:
    node = offer["graph"]["nodes"][0]
    impl = node.get("implementation") or {
        "model": "server_described", **node.get("leaf_spec", {})
    }
    model_opts = impl.get("model_options", [])
    local = next((m for m in model_opts if m.get("runtime_kind") == "local_onnx"), None)
    dl = offer["data_locality"]
    fb = offer.get("fallback_estimate", {})
    print()
    print("==== Task Offer received ====")
    print(f"  Task:                {offer['task']['human_description']}")
    print(f"  Items:               {num_items}")
    print(f"  Leaf:                {node['id']} (runtime={node.get('runtime')})")
    if local:
        print(f"  Model (local_onnx):  {local['model_id']}")
        print(f"  Model size:          {local.get('size_mb', '?')} MB"
              f"{' (quantized)' if local.get('quantized') else ''}")
    print(f"  Raw data:            {dl['raw_input_visibility']}")
    print(f"  Returns to server:   {', '.join(dl['returns_to_originator'])}")
    if fb:
        print(f"  If declined:         {fb.get('if_declined_originator_will', '?')} "
              f"(~${fb.get('estimated_cost_usd', 0)}, "
              f"~{fb.get('estimated_latency_ms', 0)}ms)")
    print("=============================")


def prompt_consent(auto_agree: bool) -> bool:
    if auto_agree:
        print("[--auto-agree set — proceeding without prompt]")
        return True
    response = input("Run locally? [Y/n] ").strip().lower()
    return response in ("", "y", "yes")


# ---------------------------------------------------------------------------
# Local ONNX runtime (the actual leaf executor)
# ---------------------------------------------------------------------------

class LocalOnnxClassifier:
    """Wraps optimum + onnxruntime for sentiment classification.

    The browser Executor uses transformers.js + ONNX Runtime Web. We use
    optimum + ONNX Runtime Python. Same ONNX model bytes from Hugging
    Face, different host runtime — exactly the kind of interop the spec
    promises.
    """

    def __init__(self, model_id: str):
        # Map browser-flavored "Xenova/X" model IDs to the same artifact.
        # The Xenova org hosts ONNX exports with both fp32 and quantized
        # weights; optimum can load either.
        print(f"[python-executor] Loading {model_id} via optimum.onnxruntime …")
        t0 = time.time()
        self.tokenizer = AutoTokenizer.from_pretrained(model_id)
        # The Xenova hub repos ship multiple ONNX variants in `onnx/`.
        # We pick `model_quantized.onnx` (q8) to match the browser
        # Executor's bytes; fall back to fp32 if the repo doesn't carry
        # it. Optimum requires file_name to be the basename and the
        # subdirectory passed via `subfolder`.
        try:
            self.model = ORTModelForSequenceClassification.from_pretrained(
                model_id, subfolder="onnx", file_name="model_quantized.onnx"
            )
            self.dtype = "q8"
        except Exception:
            self.model = ORTModelForSequenceClassification.from_pretrained(model_id)
            self.dtype = "fp32"
        self.id2label = self.model.config.id2label or {0: "NEGATIVE", 1: "POSITIVE"}
        self.load_ms = int((time.time() - t0) * 1000)
        print(f"[python-executor] Loaded in {self.load_ms}ms (dtype={self.dtype})")

    def classify(self, text: str) -> dict[str, Any]:
        inputs = self.tokenizer(text, return_tensors="pt", truncation=True, max_length=512)
        outputs = self.model(**inputs)
        logits = outputs.logits[0]
        # softmax to probabilities
        import math
        m = max(logits.tolist())
        exps = [math.exp(x - m) for x in logits.tolist()]
        s = sum(exps)
        probs = [e / s for e in exps]
        idx = probs.index(max(probs))
        return {"label": self.id2label[idx], "score": round(probs[idx], 4)}


# ---------------------------------------------------------------------------
# Protocol round-trip
# ---------------------------------------------------------------------------

def fetch_offer(client: httpx.Client, server_url: str, prompt: str) -> dict:
    r = client.post(f"{server_url}/tasks", json={"prompt": prompt}, timeout=30.0)
    r.raise_for_status()
    return r.json()


def fetch_data(client: httpx.Client, server_url: str, ref: str) -> list[dict]:
    # input_data_ref may be a path (e.g., "/tasks/<id>/data") or full URL
    url = ref if ref.startswith("http") else f"{server_url}{ref}"
    r = client.get(url, timeout=30.0)
    r.raise_for_status()
    return r.json()["items"]


def post_results(client: httpx.Client, server_url: str, task_id: str, envelope: dict) -> dict:
    r = client.post(
        f"{server_url}/tasks/{task_id}/results",
        json=envelope,
        timeout=10.0,
    )
    if not r.is_success:
        print(f"[python-executor] Server rejected envelope: {r.status_code} {r.text}", file=sys.stderr)
    r.raise_for_status()
    return r.json()


def pick_local_onnx_option(offer: dict) -> dict:
    node = offer["graph"]["nodes"][0]
    # Accept both v0 shorthand (`leaf_spec`) and v0.3 canonical (`implementation`).
    impl = node.get("implementation") or node.get("leaf_spec")
    if impl is None:
        raise ValueError("offer node has neither 'implementation' nor 'leaf_spec'")
    options = impl.get("model_options", [])
    for opt in options:
        # Old shorthand may not carry runtime_kind explicitly — assume local_onnx.
        if opt.get("runtime_kind", "local_onnx") == "local_onnx":
            return opt
    raise ValueError("no local_onnx model option in offer; this Executor only supports local_onnx")


def build_envelope(
    offer: dict,
    per_item_labels: list[dict],
    model_id: str,
    dtype: str,
    model_load_ms: int,
    inference_ms_total: int,
) -> dict:
    distribution = {"positive": 0, "negative": 0}
    for r in per_item_labels:
        key = r["label"].lower()
        distribution[key] = distribution.get(key, 0) + 1
    env = {
        "protocol_version": PROTOCOL_VERSION,
        "task_id": offer["task"]["id"],
        "status": "completed",
        "execution": {
            "runtime": "client",
            "runtime_kind": "local_onnx",
            "model_used": model_id,
            "device": f"python-onnxruntime-cpu/{dtype}",
            "model_load_ms": model_load_ms,
            "inference_ms_total": inference_ms_total,
            "items_processed": len(per_item_labels),
            "nodes_executed": [offer["graph"]["nodes"][0]["id"]],
        },
        "results": {
            "sentiment_distribution": distribution,
            "per_item_labels": per_item_labels,
        },
    }
    # §6.2: enforce data_locality whitelist on the way out.
    allowed = set(offer["data_locality"]["returns_to_originator"])
    env["results"] = {k: v for k, v in env["results"].items() if k in allowed}
    return env


def build_decline(task_id: str, reason: str = "user_declined", code: str = "EX-201") -> dict:
    return {
        "protocol_version": PROTOCOL_VERSION,
        "task_id": task_id,
        "status": "declined",
        "reason_code": code,
        "reason": reason,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="NeoProtocol/0 Python Executor (Level 0, Model A, local_onnx).")
    ap.add_argument("--server", required=True, help="Originator base URL, e.g. http://localhost:3001")
    ap.add_argument("--prompt", default="analyze sentiment of these reviews",
                    help="Natural-language prompt for the Originator's decomposer")
    ap.add_argument("--auto-agree", action="store_true",
                    help="Skip the consent prompt (for CI and smoke testing)")
    args = ap.parse_args()

    with httpx.Client() as client:
        # 1. Offer
        print(f"[python-executor] POST {args.server}/tasks")
        offer = fetch_offer(client, args.server, args.prompt)
        task_id = offer["task"]["id"]
        print(f"[python-executor] Got task {task_id}")

        # 2. Data
        items = fetch_data(client, args.server, offer["input_data_ref"])
        print(f"[python-executor] Fetched {len(items)} input items")

        # 3. Consent surface
        render_consent(offer, len(items))
        if not prompt_consent(args.auto_agree):
            print("[python-executor] Declining.")
            envelope = build_decline(task_id)
            post_results(client, args.server, task_id, envelope)
            print(json.dumps(envelope, indent=2))
            return 0

        # 4. Pick local_onnx option, load model
        opt = pick_local_onnx_option(offer)
        clf = LocalOnnxClassifier(opt["model_id"])

        # 5. Run leaves
        print(f"[python-executor] Classifying {len(items)} items …")
        per_item_labels = []
        t0 = time.time()
        for it in items:
            out = clf.classify(it["text"])
            per_item_labels.append({"id": it["id"], "label": out["label"], "score": out["score"]})
        inference_ms_total = int((time.time() - t0) * 1000)
        print(f"[python-executor] Inference done in {inference_ms_total}ms "
              f"({inference_ms_total / max(len(items), 1):.1f}ms/item)")

        # 6. Envelope
        envelope = build_envelope(
            offer, per_item_labels, opt["model_id"], clf.dtype, clf.load_ms, inference_ms_total
        )

        # 7. Post + ack
        ack = post_results(client, args.server, task_id, envelope)
        print(f"[python-executor] Server ack: {ack}")
        print()
        print("==== Result envelope (sent to Originator) ====")
        print(json.dumps(envelope, indent=2))
        return 0


if __name__ == "__main__":
    sys.exit(main())
