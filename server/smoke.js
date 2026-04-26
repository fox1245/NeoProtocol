// End-to-end smoke test for the v0.2 server.
//
// 1. POST /tasks {"prompt": "analyze sentiment..."} → offer
// 2. GET /tasks/:id/data → reviews
// 3. POST /tasks/:id/results with a fake envelope → ack
// 4. POST again with a malformed envelope → 400 with details
// 5. POST with a non-whitelisted field → server strips it

const BASE = process.env.BASE_URL || "http://localhost:3001";

async function jfetch(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("OK:  ", msg);
}

console.log(`smoke: targeting ${BASE}`);

// 1. POST /tasks
const offerResp = await jfetch("POST", "/tasks", { prompt: "analyze sentiment of these reviews" });
assert(offerResp.status === 200, "POST /tasks returns 200 on matching prompt");
assert(offerResp.body.protocol_version === "neoprotocol/0", "offer has correct protocol_version");
assert(offerResp.body.task && offerResp.body.task.id, "offer has task.id");
const taskId = offerResp.body.task.id;
console.log(`     → got task ${taskId}`);

// 1b. POST /tasks with no-match prompt
const noMatch = await jfetch("POST", "/tasks", { prompt: "do my taxes" });
assert(noMatch.status === 422, "POST /tasks returns 422 on unmatched prompt");

// 2. GET /tasks/:id/data
const dataResp = await jfetch("GET", `/tasks/${taskId}/data`);
assert(dataResp.status === 200, "GET /tasks/:id/data returns 200");
assert(Array.isArray(dataResp.body.items), "data has items[]");
assert(dataResp.body.items.length > 0, "data has at least one item");

// 3. POST a valid Result Envelope
const goodEnvelope = {
  protocol_version: "neoprotocol/0",
  task_id: taskId,
  status: "completed",
  execution: {
    runtime: "client",
    runtime_kind: "local_onnx",
    model_used: "Xenova/distilbert-base-uncased-finetuned-sst-2-english",
    device: "wasm",
    model_load_ms: 1000,
    inference_ms_total: 400,
    items_processed: 12
  },
  results: {
    sentiment_distribution: { positive: 9, negative: 3 },
    per_item_labels: [{ id: "r1", label: "POSITIVE", score: 0.99 }]
  }
};
const goodResp = await jfetch("POST", `/tasks/${taskId}/results`, goodEnvelope);
assert(goodResp.status === 200, "POST valid envelope returns 200");
assert(goodResp.body.ack === true, "ack is true");

// 4. POST a malformed envelope (missing required field)
const bad = { protocol_version: "neoprotocol/0", task_id: taskId };
const badResp = await jfetch("POST", `/tasks/${taskId}/results`, bad);
assert(badResp.status === 400, "POST malformed envelope returns 400");
assert(Array.isArray(badResp.body.details) && badResp.body.details.length > 0, "details array present");

// 5. POST with non-whitelisted field — should be silently stripped
const taintedEnvelope = {
  ...goodEnvelope,
  results: {
    sentiment_distribution: { positive: 1, negative: 1 },
    per_item_labels: [],
    raw_reviews_secret: "this should NEVER reach the server"
  }
};
const taintedResp = await jfetch("POST", `/tasks/${taskId}/results`, taintedEnvelope);
assert(taintedResp.status === 200, "tainted envelope still 200 (we strip, not reject)");
const fetched = await jfetch("GET", `/tasks/${taskId}`);
assert(
  !("raw_reviews_secret" in (fetched.body.result?.results || {})),
  "non-whitelisted field stripped from stored result"
);

// 6. task_id mismatch
const mismatch = await jfetch("POST", `/tasks/${taskId}/results`, {
  ...goodEnvelope,
  task_id: "different-id"
});
assert(mismatch.status === 400, "task_id mismatch returns 400");

console.log("\nAll smoke checks passed.");
