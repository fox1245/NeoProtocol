// NeoProtocol Originator skeleton (v0.2).
//
// Endpoints:
//   POST   /tasks                  body { prompt }            → Task Offer
//   GET    /tasks/:id              metadata (offer + result)
//   GET    /tasks/:id/data         input data referenced by the offer
//   POST   /tasks/:id/results      body Result Envelope       → ack
//   GET    /healthz                liveness
//
// In-memory task store. Restart wipes state. v1 swaps for a real DB.

import express from "express";
import cors from "cors";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decompose } from "./decomposer.js";
import { validateOffer, validateEnvelope, formatErrors } from "./validator.js";
import { attachSignaling } from "./signaling.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// task_id → { offer, result, createdAt }
const tasks = new Map();

// Filled in below after we attach the signaling WSS to the HTTP server.
let signalingStats = null;

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    protocol: "neoprotocol/0",
    tasks: tasks.size,
    signaling: signalingStats ? signalingStats.stats() : null
  });
});

app.post("/tasks", async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "missing or invalid 'prompt' (string)" });
  }
  try {
    const offer = await decompose(prompt);
    if (!validateOffer(offer)) {
      console.error("[POST /tasks] decomposer produced invalid offer:");
      console.error(formatErrors(validateOffer.errors));
      return res.status(500).json({
        error: "decomposer produced invalid offer",
        details: formatErrors(validateOffer.errors)
      });
    }
    tasks.set(offer.task.id, {
      offer,
      result: null,
      createdAt: new Date().toISOString()
    });
    console.log(`[POST /tasks] new task ${offer.task.id} (type=${offer.task.type})`);
    res.json(offer);
  } catch (e) {
    console.error("[POST /tasks] decompose failed:", e.message);
    res.status(e.code === "no_pattern_match" ? 422 : 500).json({ error: e.message });
  }
});

app.get("/tasks/:id", (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return res.status(404).json({ error: "task not found" });
  res.json({ task_id: req.params.id, offer: t.offer, result: t.result, createdAt: t.createdAt });
});

app.get("/tasks/:id/data", async (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return res.status(404).json({ error: "task not found" });
  // For sentiment_batch, ship the bundled reviews fixture. Real
  // deployments would look up data tied to the task in their DB.
  if (t.offer.task.type === "sentiment_batch") {
    const data = await fs.readFile(
      path.join(__dirname, "fixtures", "reviews_sample.json"),
      "utf8"
    );
    return res.type("application/json").send(data);
  }
  res.status(404).json({ error: `no data fixture for task type ${t.offer.task.type}` });
});

app.post("/tasks/:id/results", (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return res.status(404).json({ error: "task not found" });
  const envelope = req.body;
  if (!validateEnvelope(envelope)) {
    return res.status(400).json({
      error: "invalid result envelope",
      details: formatErrors(validateEnvelope.errors)
    });
  }
  if (envelope.task_id !== req.params.id) {
    return res.status(400).json({
      error: `task_id mismatch: envelope says ${envelope.task_id}, URL says ${req.params.id}`
    });
  }

  // Defense in depth: enforce data_locality.returns_to_originator
  // server-side, even though the client should already be filtering.
  // If a misbehaving (or compromised) client sends extra fields back,
  // strip them here so they never reach downstream consumers.
  if (envelope.results && typeof envelope.results === "object") {
    const allowed = new Set(t.offer.data_locality.returns_to_originator);
    const before = Object.keys(envelope.results);
    const filtered = Object.fromEntries(
      Object.entries(envelope.results).filter(([k]) => allowed.has(k))
    );
    const dropped = before.filter((k) => !allowed.has(k));
    if (dropped.length > 0) {
      console.warn(`[POST /tasks/${req.params.id}/results] dropped non-whitelisted fields:`, dropped);
    }
    envelope.results = filtered;
  }

  t.result = envelope;
  console.log(
    `[POST /tasks/${req.params.id}/results] status=${envelope.status} ` +
    `runtime_kind=${envelope.execution?.runtime_kind || "n/a"} ` +
    `items=${envelope.execution?.items_processed ?? "n/a"}`
  );
  res.json({ ack: true, task_id: req.params.id, accepted_at: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
const httpServer = http.createServer(app);
signalingStats = attachSignaling(httpServer, { path: "/signaling" });
httpServer.listen(PORT, () => {
  console.log(`NeoProtocol server v0.3 listening on http://localhost:${PORT}`);
  console.log(`  POST   /tasks                 — submit prompt → get Task Offer`);
  console.log(`  GET    /tasks/:id             — task metadata`);
  console.log(`  GET    /tasks/:id/data        — fetch input data`);
  console.log(`  POST   /tasks/:id/results     — submit Result Envelope`);
  console.log(`  WS     /signaling             — Federated Mode rendezvous (SPEC §16)`);
  console.log(`  GET    /healthz               — liveness`);
});
