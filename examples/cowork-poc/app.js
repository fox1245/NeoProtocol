// Cowork PoC — wires the UI to peer.js (reused) + workspace.js +
// ydoc-channel.js + agent.js.

import { SignalingPeer } from "../p2p-acp-poc/peer.js";
import { YDocChannel } from "./ydoc-channel.js";
import { makeWorkspace } from "./workspace.js";
import { askAnthropic, askMock } from "./agent.js";

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

let peer = null;
let chan = null;
let ourPeerId = null;
let abortAgent = null;
let pendingSuggestion = null;

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
    role: "host",                       // first-mover creates DC
    dcLabel: "neoprotocol-workspace",   // SPEC §17.2
    capabilities: { neoprotocol: { workspace: "v0.3" } }
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
        dcLabel: "neoprotocol-workspace",
        capabilities: { neoprotocol: { workspace: "v0.3" } }
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
  p.addEventListener("channel-open", () => {
    log(`workspace channel open`, "sys");
    setConnState("connected", "connected");
    $("btn-leave").disabled = false;
    $("btn-ask").disabled = false;
    chan = new YDocChannel(ws.doc, p.dc, { awareness: ws.awareness });
    chan.addEventListener("synced", () => {
      log(`Y.Doc synced with peer`, "sys");
      // After sync_step2 has applied, fall through to seed only if we
      // were the first joiner and the doc is still empty (i.e. neither
      // peer has ever written). This prevents the late-joiner from
      // double-seeding when its initial sync raced with a local seed.
      if (p._weAreFirstJoiner && p._weAreFirstJoiner()) ws.seedIfEmpty();
    });

    ws.onAgentEdit((v) => {
      if (!v) return;
      if (v.peerId === ourPeerId) return; // our own edit; toast is for the *peer's* agent edits
      showToast(`Peer's agent applied an edit (${v.bytesIn}+ / ${v.bytesOut}-)`);
      log(`peer's agent edit landed: +${v.bytesIn} -${v.bytesOut}`, "agent");
    });
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
  if (mode === "anthropic" && !apiKey) {
    log(`agent: API key required for Anthropic mode (or pick mock)`, "agent");
    return;
  }
  $("btn-ask").disabled = true;
  $("btn-cancel").disabled = false;
  log(`agent ← ${prompt.slice(0, 60)}${prompt.length > 60 ? "…" : ""}`, "agent");
  const ctrl = new AbortController();
  abortAgent = ctrl;
  const document = ws.yText.toString();
  try {
    const result = mode === "mock"
      ? await askMock({ prompt, document })
      : await askAnthropic({ apiKey, prompt, document, signal: ctrl.signal });
    log(`agent → ${result.reasoning.slice(0, 100)}`, "agent");
    pendingSuggestion = { ...result, basisDocument: document };
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
  const r = ws.applyAgentEdit({
    newText: pendingSuggestion.newDocument,
    agentId: $("agent-mode").value,
    peerId: ourPeerId
  });
  log(`applied agent edit: +${r.insLen ?? 0} -${r.delLen ?? 0} chars`, "agent");
  hideSuggestion();
});

$("btn-discard").addEventListener("click", () => {
  log(`discarded agent suggestion`, "agent");
  hideSuggestion();
});
