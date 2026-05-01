// Cowork PoC — wires the UI to peer.js (reused) + workspace.js +
// ydoc-channel.js + agent.js.

import { SignalingPeer } from "../p2p-acp-poc/peer.js";
import { YDocChannel } from "./ydoc-channel.js";
import { makeWorkspace } from "./workspace.js";
import { askAnthropic, askOpenAI, askMock, askLocal } from "./agent.js";
import { makeCrossAgentChannel, startCrossAgentReceiver, startCrossAgentSender } from "./cross-agent.js";
import { TaskRunner } from "./task-runner.js";

const $ = (id) => document.getElementById(id);
const log = (line, kind = "sys") => {
  const el = document.createElement("div");
  el.className = `l-${kind}`;
  el.textContent = `[${new Date().toLocaleTimeString()}] ${line}`;
  $("log").appendChild(el);
  $("log").scrollTop = $("log").scrollHeight;
};

// Pick a stable per-tab name + color (so the awareness layer gets
// readable cursors without us prompting).
const COLORS = ["#2962ff", "#d81b60", "#388e3c", "#f57c00", "#5e35b1", "#0097a7"];
const tabColor = COLORS[Math.floor(Math.random() * COLORS.length)];
const tabName = `User-${Math.random().toString(36).slice(2, 6)}`;
$("display-name").value = tabName;

const ws = makeWorkspace({
  container: $("editor-pane"),
  displayName: tabName,
  color: tabColor
});
log(`workspace ready as ${tabName} (${tabColor})`, "sys");

// Debug hook for smoke tests / dev tools — never relied on by the
// app itself.
window.__cowork = {
  ws,
  get peer()   { return peer; },
  get chan()   { return chan; },
  get peerId() { return ourPeerId; }
};

// Restore API key from sessionStorage so the demo survives a reload.
const savedKey = sessionStorage.getItem("cowork.apiKey");
if (savedKey) $("api-key").value = savedKey;
$("api-key").addEventListener("change", (e) => {
  sessionStorage.setItem("cowork.apiKey", e.target.value);
});

// Show / hide the local-model-id row based on the agent mode and
// adjust the API-key field's placeholder per provider.
function refreshAgentModeUi() {
  const mode = $("agent-mode").value;
  $("local-model-row").style.display = mode === "local" ? "" : "none";
  const needsKey = mode === "anthropic" || mode === "openai";
  $("api-key").style.display = needsKey ? "" : "none";
  $("api-key").placeholder =
    mode === "openai"     ? "sk-... (OpenAI key, sessionStorage only)"
  : mode === "anthropic"  ? "sk-ant-... (Anthropic key, sessionStorage only)"
  : "(no key needed)";
}
$("agent-mode").addEventListener("change", refreshAgentModeUi);
refreshAgentModeUi();

// Per-tab cache for the loaded local-model pipeline. We keep one
// model loaded at a time; switching model IDs in the UI evicts via
// transformers.js's own internal cache.
function makeLocalProgressReporter() {
  let lastPct = -1;
  return (info) => {
    if (!info) return;
    if (info.status === "progress" && typeof info.progress === "number") {
      const pct = Math.round(info.progress);
      if (pct !== lastPct) {
        lastPct = pct;
        $("local-model-progress").textContent =
          `Loading ${info.file || ""}… ${pct}% (${(info.loaded / 1e6).toFixed(1)} / ${(info.total / 1e6).toFixed(1)} MB)`;
      }
    } else if (info.status === "ready") {
      $("local-model-progress").textContent = `Model ready (cached for next session).`;
    } else if (info.status === "done") {
      // file done — keep going
    } else if (info.status === "initiate") {
      $("local-model-progress").textContent = `Fetching ${info.file}…`;
    }
  };
}

let peer = null;
let chan = null;            // YDocChannel (workspace)
let xagentSender = null;    // sender side of cross-agent ACP
let xagentReceiver = null;  // receiver side of cross-agent ACP
let taskRunner = null;      // SPEC §17.8 multi-host fan-out
let ourPeerId = null;
let abortAgent = null;
let pendingSuggestion = null;

// Stage 2 cross-agent wire labels — must match SPEC §16.3 / §17.2.
const DC_LABEL_WORKSPACE = "neoprotocol-workspace";
const DC_LABEL_ACP       = "neoprotocol-acp";

function setConnState(text, kind = "") {
  $("conn-state").textContent = text;
  $("conn-state").className = "pill " + kind;
}

function showToast(text, ms = 2400) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), ms);
}

function diffSummary(oldText, newText) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  // Trim common prefix/suffix at line granularity for a readable
  // visualization. Real diff would be Myers; this is good enough for
  // a PoC.
  let i = 0;
  while (i < oldLines.length && i < newLines.length && oldLines[i] === newLines[i]) i++;
  let j = 0;
  while (
    j < (oldLines.length - i) &&
    j < (newLines.length - i) &&
    oldLines[oldLines.length - 1 - j] === newLines[newLines.length - 1 - j]
  ) j++;
  const removed = oldLines.slice(i, oldLines.length - j);
  const added = newLines.slice(i, newLines.length - j);
  return { removed, added, contextStart: i };
}

function renderDiff(oldText, newText) {
  const { removed, added, contextStart } = diffSummary(oldText, newText);
  const lines = [];
  if (removed.length === 0 && added.length === 0) {
    lines.push("(no changes)");
  } else {
    lines.push(`@@ around line ${contextStart + 1} @@`);
    for (const r of removed) lines.push(`<span class="del">- ${escapeHtml(r) || " "}</span>`);
    for (const a of added) lines.push(`<span class="add">+ ${escapeHtml(a) || " "}</span>`);
  }
  return lines.join("\n");
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

// ---- Connection ----

$("btn-join").addEventListener("click", async () => {
  $("btn-join").disabled = true;
  setConnState("connecting", "connecting");
  peer = new SignalingPeer({
    wsUrl: $("ws-url").value,
    room: $("room").value,
    role: "host",                       // first-mover creates DCs
    dcLabels: [DC_LABEL_WORKSPACE, DC_LABEL_ACP],   // SPEC §17.2 + §16.3
    capabilities: { neoprotocol: { workspace: "v0.3", crossAgent: "v0.3" } }
  });
  // If a peer is already in the room when we join, the relay will
  // tell us — we then become the *driver* (the side that receives
  // ondatachannel) so we don't double-create the DC.
  let weAreFirstJoiner = false; // only the alone-when-we-arrived peer seeds the doc
  peer.addEventListener("joined", (e) => {
    ourPeerId = e.detail.peerId;
    log(`joined as ${ourPeerId.slice(0, 8)}; ${e.detail.peers.length} peer(s) already here`, "sys");
    if (e.detail.peers.length === 0) {
      weAreFirstJoiner = true;
    } else {
      // Drop our preemptively-created DC, swap to receive-mode. Easiest
      // way: close current pc and restart as driver. SignalingPeer
      // doesn't expose a clean role-switch, so we just close + rejoin.
      peer.close();
      peer = new SignalingPeer({
        wsUrl: $("ws-url").value,
        room: $("room").value,
        role: "driver",
        dcLabels: [DC_LABEL_WORKSPACE, DC_LABEL_ACP],
        capabilities: { neoprotocol: { workspace: "v0.3", crossAgent: "v0.3" } }
      });
      wirePeerEvents(peer);
      peer.start().catch((err) => log(`rejoin failed: ${err.message}`, "sys"));
    }
  });
  // Surface the first-joiner flag to the inner-scope `wirePeerEvents`
  // closures so the seed runs only on that side.
  peer._weAreFirstJoiner = () => weAreFirstJoiner;
  wirePeerEvents(peer);
  try {
    await peer.start();
  } catch (e) {
    log(`connect failed: ${e.message}`, "sys");
    setConnState("failed", "failed");
    $("btn-join").disabled = false;
  }
});

function wirePeerEvents(p) {
  p.addEventListener("connection-state", (e) => {
    setConnState(e.detail, e.detail === "connected" ? "connected" : e.detail === "failed" ? "failed" : "connecting");
  });
  p.addEventListener("peer-joined", (e) => log(`peer joined: ${e.detail.id.slice(0, 8)}`, "peer"));
  p.addEventListener("peer-left", () => log(`peer left`, "peer"));
  p.addEventListener("labeled-channel-open", (e) => {
    const { label, channel: dc } = e.detail;
    log(`channel open: ${label}`, "sys");

    if (label === DC_LABEL_WORKSPACE) {
      setConnState("connected", "connected");
      $("btn-leave").disabled = false;
      $("btn-ask").disabled = false;
      chan = new YDocChannel(ws.doc, dc, { awareness: ws.awareness });
      chan.addEventListener("synced", () => {
        log(`Y.Doc synced with peer`, "sys");
        if (p._weAreFirstJoiner && p._weAreFirstJoiner()) ws.seedIfEmpty();
      });

      // Stage 5 / SPEC §17.8 — task runner. One per Coworker, listening
      // on the same Y.Doc maps from both sides so leaf execution
      // distributes deterministically.
      taskRunner = new TaskRunner({
        ws,
        ourClientId: ws.doc.clientID,
        getAgentSelection: () => ({
          agentId: $("agent-mode").value,
          apiKey:  $("api-key").value.trim(),
          modelId: $("local-model-id").value.trim() || "onnx-community/Llama-3.2-1B-Instruct"
        }),
        log: (line) => log(line, "agent")
      });
      taskRunner.addEventListener("task-complete", () => {
        renderTaskState();
      });
      // Re-render the task panel on every Y.Doc map change so both
      // peers see the live leaf assignment + status.
      ws.doc.getMap("task").observe(renderTaskState);
      ws.doc.getMap("channels").observe(renderTaskState);
      ws.doc.getMap("leaf_status").observe(renderTaskState);
      $("btn-run-task").disabled = false;
      log(`task runner ready (clientId=${ws.doc.clientID})`, "sys");

      // Stage 1 attribution toast — register once when the workspace
      // channel opens. Toast fires only for the *peer's* agent edits.
      ws.onAgentEdit((v) => {
        if (!v) return;
        if (v.peerId === ourPeerId) return;
        showToast(`Peer's agent applied an edit (${v.bytesIn}+ / ${v.bytesOut}-)`);
        log(`peer's agent edit landed: +${v.bytesIn} -${v.bytesOut}`, "agent");
      });
    }

    if (label === DC_LABEL_ACP) {
      // Stage 2 — cross-agent ACP. Both halves run on every peer and
      // share ONE JsonRpcChannel: registering two channels on the same
      // RTCDataChannel makes them race each other for incoming frames
      // (the sender, with no request handlers, would reply
      // "method not found" before the receiver gets a chance).
      // We re-read agent-mode + api-key on every inbound prompt so
      // the user can flip backends mid-session without disconnecting.
      const sharedRpc = makeCrossAgentChannel(dc);
      const liveAgentId = () => $("agent-mode").value;
      xagentReceiver = startCrossAgentReceiver({
        rpc: sharedRpc,
        ourPeerId,
        ourAgentId: liveAgentId(),
        runAgent: async ({ prompt, document }) => {
          const mode = liveAgentId();
          const apiKey = $("api-key").value.trim();
          if (mode === "mock" || ((mode === "anthropic" || mode === "openai") && !apiKey)) {
            return askMock({ prompt, document });
          }
          if (mode === "local") {
            const modelId = $("local-model-id").value.trim() || "onnx-community/Llama-3.2-1B-Instruct";
            return askLocal({ modelId, prompt, document, onProgress: makeLocalProgressReporter() });
          }
          if (mode === "openai") return askOpenAI({ apiKey, prompt, document });
          return askAnthropic({ apiKey, prompt, document });
        },
        getDocument: () => ws.yText.toString(),
        requestPermission: async ({ remotePeerId, remoteAgentId, prompt }) =>
          askXAgentPermission({ remotePeerId, remoteAgentId, prompt }),
        onLog: (line) => log(line, "agent")
      });
      xagentSender = startCrossAgentSender({
        rpc: sharedRpc,
        ourPeerId,
        ourAgentId: liveAgentId(),
        onLog: (line) => log(line, "agent")
      });
      log(`cross-agent ACP ready (agentId=${liveAgentId()})`, "sys");
    }
  });
  p.addEventListener("channel-close", () => {
    log(`workspace channel closed`, "sys");
    setConnState("idle");
    $("btn-leave").disabled = true;
    $("btn-ask").disabled = true;
  });
  p.addEventListener("signaling-error", (e) => {
    log(`signaling error: ${e.detail.code} ${e.detail.reason}`, "sys");
    setConnState("failed", "failed");
  });
}

$("btn-leave").addEventListener("click", () => {
  if (peer) peer.close();
  peer = null;
  chan = null;
  setConnState("idle");
  $("btn-join").disabled = false;
  $("btn-leave").disabled = true;
  $("btn-ask").disabled = true;
});

// ---- Ask agent ----

$("btn-ask").addEventListener("click", async () => {
  const prompt = $("agent-prompt").value.trim();
  if (!prompt) return;
  const mode = $("agent-mode").value;
  const apiKey = $("api-key").value.trim();
  const askPeer = $("ask-peer").checked;
  const modelId = $("local-model-id").value.trim();
  if (!askPeer && (mode === "anthropic" || mode === "openai") && !apiKey) {
    log(`agent: API key required for ${mode} mode (or pick mock / local)`, "agent");
    return;
  }
  if (!askPeer && mode === "local" && !modelId) {
    log(`agent: local model ID required`, "agent");
    return;
  }
  if (askPeer && !xagentSender) {
    log(`cross-agent: peer not connected yet`, "agent");
    return;
  }
  $("btn-ask").disabled = true;
  $("btn-cancel").disabled = false;
  const tag = askPeer ? "peer's agent" : "my agent";
  log(`${tag} ← ${prompt.slice(0, 60)}${prompt.length > 60 ? "…" : ""}`, "agent");
  const ctrl = new AbortController();
  abortAgent = ctrl;
  const document = ws.yText.toString();
  try {
    let result;
    if (askPeer) {
      const r = await xagentSender.ask(prompt);
      if (r.denied) {
        log(`peer's agent denied: ${r.reason}`, "agent");
        return;
      }
      if (!r.newDocument) {
        log(`peer's agent returned no candidate document`, "agent");
        return;
      }
      result = {
        reasoning: `[from ${r.remoteAgentId} on peer ${(r.remotePeerId || "").slice(0, 8)}] ${r.reasoning?.trim() || "(no reasoning)"}`,
        newDocument: r.newDocument,
        // Tag the eventual apply so attribution carries the peer's identity.
        attributionAgentId: r.remoteAgentId,
        attributionPeerId:  r.remotePeerId
      };
    } else {
      if (mode === "mock") {
        result = await askMock({ prompt, document });
      } else if (mode === "local") {
        log(`local model: loading ${modelId}…`, "agent");
        result = await askLocal({
          modelId,
          prompt,
          document,
          onProgress: makeLocalProgressReporter(),
          signal: ctrl.signal
        });
      } else if (mode === "openai") {
        result = await askOpenAI({ apiKey, prompt, document, signal: ctrl.signal });
      } else {
        result = await askAnthropic({ apiKey, prompt, document, signal: ctrl.signal });
      }
    }
    log(`${tag} → ${result.reasoning.slice(0, 100)}`, "agent");
    pendingSuggestion = { ...result, basisDocument: document, fromPeer: askPeer };
    showSuggestion(result, document);
  } catch (e) {
    log(`agent failed: ${e.message}`, "agent");
  } finally {
    $("btn-ask").disabled = false;
    $("btn-cancel").disabled = true;
    abortAgent = null;
  }
});

$("btn-cancel").addEventListener("click", () => {
  if (abortAgent) abortAgent.abort();
});

function showSuggestion(result, basisDocument) {
  $("suggestion-reasoning").textContent = result.reasoning;
  $("suggestion-diff").innerHTML = renderDiff(basisDocument, result.newDocument);
  $("suggestion-card").style.display = "";
}
function hideSuggestion() {
  $("suggestion-card").style.display = "none";
  pendingSuggestion = null;
}

$("btn-apply").addEventListener("click", () => {
  if (!pendingSuggestion) return;
  const cur = ws.yText.toString();
  if (cur !== pendingSuggestion.basisDocument) {
    log(`document moved while agent was thinking — re-running diff against current state`, "agent");
  }
  // Attribution rule (SPEC §17.5):
  //   - Edits from your *own* agent are stamped with your peerId + your agentId.
  //   - Edits from a *peer's* agent (Stage 2 cross-agent) are stamped with
  //     the remote peer/agent IDs so the wire reflects who actually authored
  //     the bytes, even though it's the local user who pressed Apply.
  const agentId = pendingSuggestion.fromPeer
    ? (pendingSuggestion.attributionAgentId || "peer-agent")
    : $("agent-mode").value;
  const peerId = pendingSuggestion.fromPeer
    ? (pendingSuggestion.attributionPeerId || ourPeerId)
    : ourPeerId;
  const r = ws.applyAgentEdit({
    newText: pendingSuggestion.newDocument,
    agentId,
    peerId
  });
  log(`applied ${pendingSuggestion.fromPeer ? "peer's-agent" : "agent"} edit: +${r.insLen ?? 0} -${r.delLen ?? 0} chars`, "agent");
  hideSuggestion();
});

$("btn-discard").addEventListener("click", () => {
  log(`discarded agent suggestion`, "agent");
  hideSuggestion();
});

// ---- Cross-agent permission dialog (SPEC §17.4) ----

// ---- SPEC §17.8 task panel ----

function renderTaskState() {
  if (!taskRunner) return;
  const snap = taskRunner.snapshot();
  const stateEl = $("task-state");
  const graphEl = $("task-graph");
  if (!snap) {
    stateEl.textContent = "No task running.";
    graphEl.style.display = "none";
    graphEl.textContent = "";
    return;
  }
  const { offer, status, assignments, leafStatus, channels, ourClientId, clientIds } = snap;
  const assignedToMe = (id) => assignments[id] === ourClientId;
  const stateOf = (id) => leafStatus[id]?.state || "pending";
  const lines = [];
  lines.push(`Task ${offer.task.id.slice(0, 8)} · status=${status} · ${clientIds.length} peer(s) · clientIds=[${[...clientIds].sort().join(", ")}] · my clientId=${ourClientId}`);
  lines.push("");
  lines.push("Leaves & assignments:");
  for (const node of offer.graph.nodes) {
    const mine = assignedToMe(node.id) ? " ← MINE" : "";
    const st = stateOf(node.id);
    const dur = leafStatus[node.id]?.duration_ms;
    const agent = leafStatus[node.id]?.agentId;
    const tail = st === "done"     ? ` (${agent}, ${dur} ms)`
              : st === "running"  ? ` (${agent}, …)`
              : st === "failed"   ? ` (${leafStatus[node.id]?.error || "?"})`
              : "";
    lines.push(`  ${st === "done" ? "✓" : st === "running" ? "▸" : st === "failed" ? "✗" : "·"} ${node.kind === "reducer" ? "[R]" : "[L]"} ${node.id} → client ${assignments[node.id]}${mine}${tail}`);
    if (node.reads?.length) lines.push(`        reads: ${node.reads.join(", ")}`);
    if (node.writes?.length) lines.push(`       writes: ${node.writes.join(", ")}`);
  }
  if (Object.keys(channels).length) {
    lines.push("");
    lines.push("Channels (truncated):");
    for (const [k, v] of Object.entries(channels)) {
      const trimmed = String(v).replace(/\s+/g, " ").trim();
      lines.push(`  ${k}: ${trimmed.slice(0, 110)}${trimmed.length > 110 ? "…" : ""}`);
    }
  }
  stateEl.textContent = `Task running — ${offer.task.type}`;
  graphEl.style.display = "";
  graphEl.textContent = lines.join("\n");
}

$("btn-run-task").addEventListener("click", async () => {
  if (!taskRunner) return;
  const prompt = $("task-prompt").value.trim() || "code review this document";
  $("btn-run-task").disabled = true;
  try {
    // Use the Originator URL inferred from the signaling URL — drop
    // the ws://...//signaling tail and prepend http://
    const sig = $("ws-url").value.trim();
    const originatorUrl = sig.replace(/^wss?:\/\//, "http://").replace(/\/signaling.*$/, "");
    await taskRunner.runFromPrompt({ prompt, originatorUrl });
  } catch (e) {
    log(`task: failed to start — ${e.message}`, "agent");
  } finally {
    $("btn-run-task").disabled = false;
  }
});
$("btn-reset-task").addEventListener("click", () => {
  if (taskRunner) taskRunner.reset();
});

function askXAgentPermission({ remotePeerId, remoteAgentId, prompt }) {
  return new Promise((resolve) => {
    const card = $("xagent-perm-card");
    $("xagent-perm-text").innerHTML = `
      <strong>Peer <code>${remotePeerId.slice(0, 8)}</code>'s agent
      (<code>${remoteAgentId}</code>) wants your agent to handle:</strong>
      <pre style="white-space:pre-wrap;font-size:12px;background:#f3f3f3;padding:6px;border-radius:4px;margin-top:6px;">${escapeHtml(prompt.slice(0, 600))}${prompt.length > 600 ? "…" : ""}</pre>
    `;
    card.style.display = "";

    const close = (outcome) => {
      card.style.display = "none";
      resolve(outcome);
    };
    $("xagent-allow-once").onclick    = () => close("allow_once");
    $("xagent-allow-session").onclick = () => close("allow_session");
    $("xagent-deny-once").onclick     = () => close("deny_once");
    $("xagent-deny-session").onclick  = () => close("deny_session");
  });
}
