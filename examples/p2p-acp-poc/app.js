// Demo app — wires the UI to peer.js + acp.js + agent.js / driver.js.

import { SignalingPeer, ManualPeer, encodeSdp, decodeSdp, dtlsFingerprintFromSdp } from "./peer.js";
import { startAgent } from "./agent.js";
import { startDriver } from "./driver.js";

const $ = (id) => document.getElementById(id);
const log = (line, kind = "sys") => {
  const div = document.createElement("div");
  div.className = `l-${kind}`;
  const ts = new Date().toLocaleTimeString();
  div.textContent = `[${ts}] ${line}`;
  $("log").appendChild(div);
  $("log").scrollTop = $("log").scrollHeight;
};

const ui = {
  role:        $("role"),
  mode:        $("mode"),
  connState:   $("conn-state"),
  // standard
  blockStd:    $("block-standard"),
  wsUrl:       $("ws-url"),
  room:        $("room"),
  btnStdStart: $("btn-std-start"),
  btnStdDisconnect: $("btn-std-disconnect"),
  // manual
  blockManual:    $("block-manual"),
  manualHost:     $("manual-host"),
  manualDriver:   $("manual-driver"),
  btnMkOffer:     $("btn-mk-offer"),
  offerUrl:       $("offer-url"),
  answerPaste:    $("answer-paste"),
  btnConsumeAnswer: $("btn-consume-answer"),
  offerPaste:     $("offer-paste"),
  btnMkAnswer:    $("btn-mk-answer"),
  answerUrl:      $("answer-url"),
  // host
  panelHost:      $("panel-host"),
  hostConnMeta:   $("host-conn-meta"),
  // driver
  panelDriver:    $("panel-driver"),
  virtDoc:        $("virt-doc"),
  prompt:         $("prompt"),
  btnPrompt:      $("btn-prompt"),
  permHost:       $("perm-host"),
  stream:         $("stream"),
};

let peer = null;
let agentRpc = null;
let driver = null;

function setConnState(text, kind = "") {
  ui.connState.textContent = text;
  ui.connState.className = "pill " + kind;
}

function refreshLayout() {
  const role = ui.role.value;
  const mode = ui.mode.value;
  ui.blockStd.classList.toggle("hidden", mode !== "standard");
  ui.blockManual.classList.toggle("hidden", mode !== "manual");
  ui.manualHost.classList.toggle("hidden", role !== "host");
  ui.manualDriver.classList.toggle("hidden", role !== "driver");
  ui.panelHost.classList.toggle("hidden", role !== "host");
  ui.panelDriver.classList.toggle("hidden", role !== "driver");
}
ui.role.addEventListener("change", refreshLayout);
ui.mode.addEventListener("change", refreshLayout);
refreshLayout();

// Pre-fill from URL fragment if any (e.g. #offer=... or #answer=...)
(function applyUrlFragment() {
  const m = location.hash.match(/^#(offer|answer)=(.+)$/);
  if (!m) return;
  if (m[1] === "offer") {
    ui.role.value = "driver";
    ui.mode.value = "manual";
    refreshLayout();
    ui.offerPaste.value = `#offer=${m[2]}`;
  } else if (m[1] === "answer") {
    ui.role.value = "host";
    ui.mode.value = "manual";
    refreshLayout();
    ui.answerPaste.value = `#answer=${m[2]}`;
  }
})();

// ----- Wire data channel once it's open. -----

function attachChannel(dc) {
  const role = ui.role.value;
  log(`data channel open (${dc.label})`, "sys");
  if (role === "host") {
    agentRpc = startAgent(dc, { onLog: (line) => log(line, "host") });
    ui.hostConnMeta.textContent = "Connected. Waiting for the driver to send a prompt…";
  } else {
    const docs = new Map();
    driver = startDriver(dc, {
      virtualDocs: docs,
      onChunk: (text) => {
        if (ui.stream.textContent === "(awaiting agent response)") ui.stream.textContent = "";
        ui.stream.textContent += text;
      },
      onLog: (line) => log(line, "driver"),
      requestPermission: async ({ path }) => askPermission(path)
    });

    // Sync the virtual doc into the map keyed by current sessionId on every prompt.
    ui.btnPrompt.disabled = false;
    ui.btnPrompt.addEventListener("click", async () => {
      ui.btnPrompt.disabled = true;
      ui.stream.textContent = "(awaiting agent response)";
      try {
        // Make sure handshake is done so we have sessionId for the path.
        if (!driver.getSessionId()) await driver.handshake();
        docs.set(`np://session/${driver.getSessionId()}/notes.txt`, ui.virtDoc.value);
        await driver.prompt(ui.prompt.value || "summarize the document");
      } catch (e) {
        log(`prompt failed: ${e.message}`, "driver");
      } finally {
        ui.btnPrompt.disabled = false;
      }
    });
  }
}

function askPermission(path) {
  return new Promise((resolve) => {
    ui.permHost.classList.remove("hidden");
    ui.permHost.innerHTML = `
      <div class="perm-banner">
        <strong>Permission requested.</strong> The agent wants to read
        <code>${path}</code>.
        <div class="actions">
          <button class="primary" id="perm-allow">Allow</button>
          <button class="danger" id="perm-deny">Deny</button>
        </div>
      </div>
    `;
    document.getElementById("perm-allow").addEventListener("click", () => {
      ui.permHost.classList.add("hidden");
      ui.permHost.innerHTML = "";
      resolve(true);
    });
    document.getElementById("perm-deny").addEventListener("click", () => {
      ui.permHost.classList.add("hidden");
      ui.permHost.innerHTML = "";
      resolve(false);
    });
  });
}

// ----- Standard mode -----

ui.btnStdStart.addEventListener("click", async () => {
  ui.btnStdStart.disabled = true;
  setConnState("connecting", "connecting");
  const role = ui.role.value;
  peer = new SignalingPeer({
    wsUrl: ui.wsUrl.value,
    room: ui.room.value,
    role,
    capabilities: { neoprotocol: { federated: "v0.3" } }
  });
  peer.addEventListener("joined", (e) => {
    log(`signaling: joined as ${e.detail.peerId.slice(0, 8)} (other peers: ${e.detail.peers.length})`, "sys");
  });
  peer.addEventListener("peer-joined", (e) => {
    log(`signaling: peer joined ${e.detail.id.slice(0, 8)} (${e.detail.role})`, "sys");
  });
  peer.addEventListener("connection-state", (e) => {
    setConnState(e.detail, e.detail === "connected" ? "connected" : e.detail === "failed" ? "failed" : "connecting");
  });
  peer.addEventListener("channel-open", () => {
    setConnState("connected", "connected");
    ui.btnStdDisconnect.disabled = false;
    attachChannel(peer.dc);
  });
  peer.addEventListener("channel-close", () => setConnState("closed"));
  peer.addEventListener("signaling-error", (e) => {
    log(`signaling error: ${e.detail.code} ${e.detail.reason}`, "sys");
    setConnState("failed", "failed");
  });
  try {
    await peer.start();
  } catch (e) {
    log(`connect failed: ${e.message}`, "sys");
    setConnState("failed", "failed");
    ui.btnStdStart.disabled = false;
  }
});

ui.btnStdDisconnect.addEventListener("click", () => {
  if (peer) peer.close();
  peer = null;
  setConnState("idle");
  ui.btnStdStart.disabled = false;
  ui.btnStdDisconnect.disabled = true;
});

// ----- Manual mode -----

ui.btnMkOffer.addEventListener("click", async () => {
  ui.btnMkOffer.disabled = true;
  setConnState("gathering ICE", "connecting");
  peer = new ManualPeer({ role: "host" });
  peer.addEventListener("connection-state", (e) => {
    setConnState(e.detail, e.detail === "connected" ? "connected" : e.detail === "failed" ? "failed" : "connecting");
  });
  peer.addEventListener("channel-open", () => {
    setConnState("connected", "connected");
    attachChannel(peer.dc);
  });
  const blob = await peer.createOfferBlob();
  const url = `${location.origin}${location.pathname}#offer=${blob}`;
  ui.offerUrl.textContent = url;
  log(`offer URL ready (${url.length} chars). DTLS fp: ${dtlsFingerprintFromSdp(peer.pc.localDescription.sdp)}`, "sys");
});

ui.btnConsumeAnswer.addEventListener("click", async () => {
  const txt = ui.answerPaste.value.trim();
  const m = txt.match(/#answer=(.+)$/);
  if (!m) { log("paste an answer URL containing #answer=...", "sys"); return; }
  await peer.consumeAnswer(m[1]);
  log("answer applied — waiting for ICE to converge…", "sys");
});

ui.btnMkAnswer.addEventListener("click", async () => {
  ui.btnMkAnswer.disabled = true;
  const txt = ui.offerPaste.value.trim();
  const m = txt.match(/#offer=(.+)$/);
  if (!m) { log("paste an offer URL containing #offer=...", "sys"); ui.btnMkAnswer.disabled = false; return; }
  setConnState("gathering ICE", "connecting");
  peer = new ManualPeer({ role: "driver" });
  peer.addEventListener("connection-state", (e) => {
    setConnState(e.detail, e.detail === "connected" ? "connected" : e.detail === "failed" ? "failed" : "connecting");
  });
  peer.addEventListener("channel-open", () => {
    setConnState("connected", "connected");
    attachChannel(peer.dc);
  });
  const answerBlob = await peer.consumeOfferProduceAnswer(m[1]);
  const url = `${location.origin}${location.pathname}#answer=${answerBlob}`;
  ui.answerUrl.textContent = url;
  log(`answer URL ready (${url.length} chars). DTLS fp: ${dtlsFingerprintFromSdp(peer.pc.localDescription.sdp)}`, "sys");
});
