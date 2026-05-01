// WebRTC peer setup for both Federated Mode signaling modes:
//
//   Standard mode (Originator-as-signaling):
//     Both peers open a WebSocket to the Originator's /signaling
//     endpoint. Server is a dumb relay — forwards SDP offer/answer
//     and ICE candidates between peers in the same room. Once SDP
//     is exchanged and ICE finds a working path, the data channel
//     is P2P over DTLS/SCTP and the server is no longer involved.
//
//   Minimal mode (SDP-via-URL):
//     Zero runtime server. Each peer waits for ICE gathering to
//     complete (non-trickle), then encodes the full SDP into a URL
//     hash and shares it out-of-band (chat, email, QR). The other
//     peer pastes the URL, generates the answer, and the originator
//     pastes the answer URL back. No relay, no signaling server.
//
// In both modes the resulting RTCPeerConnection + RTCDataChannel are
// identical — only the bootstrap differs.

const DEFAULT_ICE = [{ urls: "stun:stun.l.google.com:19302" }];

const DEFAULT_DC_LABEL = "neoprotocol-acp";

function newPeerConnection(iceServers) {
  return new RTCPeerConnection({ iceServers: iceServers || DEFAULT_ICE });
}

// ------------------------------------------------------------------
// Standard mode — Originator-as-signaling.
// ------------------------------------------------------------------

export class SignalingPeer extends EventTarget {
  constructor({ wsUrl, room, role, capabilities, iceServers, dcLabel, dcLabels }) {
    super();
    this.wsUrl = wsUrl;
    this.room = room;
    this.role = role;
    this.capabilities = capabilities || {};
    this.iceServers = iceServers || DEFAULT_ICE;
    // Single label (back-compat) → single-element array. Multiple labels
    // (Stage 2 cowork) → host opens one DC per label, driver receives
    // them via ondatachannel and routes by label.
    this.dcLabels = dcLabels && dcLabels.length > 0 ? dcLabels.slice() : [dcLabel || DEFAULT_DC_LABEL];
    this.pc = null;
    this.dc = null;                       // primary channel (first label) — back-compat
    this.channels = new Map();            // label → RTCDataChannel
    this.peerId = null;
    this.remotePeerId = null;
    this.ws = null;
    this._iceQueue = []; // remote candidates received before remoteDescription
  }

  async start() {
    this.pc = newPeerConnection(this.iceServers);
    this._wirePeerEvents();

    if (this.role === "host") {
      // Host pre-creates one data channel per declared label; driver
      // receives them via ondatachannel and routes by label. For SPEC
      // §17 Cowork Stage 2 we open both `neoprotocol-workspace` (Y.js)
      // and `neoprotocol-acp` (cross-agent ACP) on the same RTCPeerConnection.
      for (const label of this.dcLabels) {
        this._attachDataChannel(this.pc.createDataChannel(label, { ordered: true }));
      }
    } else {
      this.pc.addEventListener("datachannel", (e) => this._attachDataChannel(e.channel));
    }

    await this._openSocket();
  }

  _attachDataChannel(dc) {
    if (!this.channels) this.channels = new Map();
    this.channels.set(dc.label, dc);
    if (!this.dc) this.dc = dc;  // first attached channel is the primary (back-compat for single-channel consumers)
    dc.addEventListener("open", () => {
      this.dispatchEvent(new Event("channel-open"));
      this.dispatchEvent(new CustomEvent("labeled-channel-open", { detail: { label: dc.label, channel: dc } }));
    });
    dc.addEventListener("close", () => {
      this.dispatchEvent(new Event("channel-close"));
      this.dispatchEvent(new CustomEvent("labeled-channel-close", { detail: { label: dc.label } }));
    });
  }

  // Look up a data channel by its label (Stage 2 multi-channel mode).
  channel(label) {
    return this.channels && this.channels.get(label) || null;
  }

  _wirePeerEvents() {
    this.pc.addEventListener("icecandidate", (e) => {
      if (e.candidate && this.remotePeerId) {
        this._sendSignal({ kind: "ice", candidate: e.candidate.toJSON() });
      }
    });
    this.pc.addEventListener("connectionstatechange", () => {
      this.dispatchEvent(new CustomEvent("connection-state", { detail: this.pc.connectionState }));
    });
  }

  _openSocket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({
          kind: "join", room: this.room, role: this.role, capabilities: this.capabilities
        }));
      });
      ws.addEventListener("message", async (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        await this._handleSignaling(msg, resolve, reject);
      });
      ws.addEventListener("error", () => {
        reject(new Error("signaling socket error"));
      });
      ws.addEventListener("close", () => {
        this.dispatchEvent(new Event("signaling-closed"));
      });
    });
  }

  _sendSignal(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.remotePeerId) return;
    this.ws.send(JSON.stringify({ kind: "signal", to: this.remotePeerId, payload }));
  }

  async _handleSignaling(msg, resolveJoin, rejectJoin) {
    switch (msg.kind) {
      case "joined": {
        this.peerId = msg.peer_id;
        this.dispatchEvent(new CustomEvent("joined", { detail: { peerId: msg.peer_id, peers: msg.peers } }));
        // If we're the driver and the host is already there, kick off offer.
        const host = msg.peers.find((p) => p.role === "host");
        const driver = msg.peers.find((p) => p.role === "driver");
        if (this.role === "host" && driver) {
          this.remotePeerId = driver.id;
          await this._sendOffer();
        } else if (this.role === "driver" && host) {
          this.remotePeerId = host.id;
          // Wait for host to send offer.
        }
        resolveJoin();
        break;
      }
      case "peer_joined": {
        // The other side just arrived. If we're host, we send offer.
        if (this.role === "host" && msg.peer.role === "driver" && !this.remotePeerId) {
          this.remotePeerId = msg.peer.id;
          await this._sendOffer();
        } else if (this.role === "driver" && msg.peer.role === "host" && !this.remotePeerId) {
          this.remotePeerId = msg.peer.id;
        }
        this.dispatchEvent(new CustomEvent("peer-joined", { detail: msg.peer }));
        break;
      }
      case "peer_left": {
        if (msg.peer_id === this.remotePeerId) {
          this.remotePeerId = null;
          this.dispatchEvent(new Event("peer-left"));
        }
        break;
      }
      case "signal": {
        await this._handlePayload(msg.from, msg.payload);
        break;
      }
      case "error": {
        this.dispatchEvent(new CustomEvent("signaling-error", { detail: msg }));
        if (rejectJoin) rejectJoin(new Error(`signaling: ${msg.code} ${msg.reason}`));
        break;
      }
    }
  }

  async _sendOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this._sendSignal({ kind: "sdp", sdp: { type: offer.type, sdp: offer.sdp } });
  }

  async _handlePayload(from, payload) {
    if (!payload || typeof payload !== "object") return;
    if (payload.kind === "sdp") {
      const desc = new RTCSessionDescription(payload.sdp);
      await this.pc.setRemoteDescription(desc);
      // drain any ICE we got before remoteDescription was set
      for (const c of this._iceQueue) {
        try { await this.pc.addIceCandidate(c); } catch (e) { console.warn("queued ICE add failed:", e); }
      }
      this._iceQueue = [];
      if (desc.type === "offer") {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this._sendSignal({ kind: "sdp", sdp: { type: answer.type, sdp: answer.sdp } });
      }
    } else if (payload.kind === "ice") {
      const c = new RTCIceCandidate(payload.candidate);
      if (this.pc.remoteDescription && this.pc.remoteDescription.type) {
        try { await this.pc.addIceCandidate(c); } catch (e) { console.warn("ICE add failed:", e); }
      } else {
        this._iceQueue.push(c);
      }
    }
  }

  close() {
    if (this.ws) try { this.ws.send(JSON.stringify({ kind: "leave" })); } catch {}
    if (this.ws) try { this.ws.close(); } catch {}
    if (this.dc) try { this.dc.close(); } catch {}
    if (this.pc) try { this.pc.close(); } catch {}
  }
}

// ------------------------------------------------------------------
// Minimal mode — SDP via URL.
// ------------------------------------------------------------------

// Encode an SDP description into a URL-safe string. We pack only
// {type, sdp} (the only fields RTCSessionDescription needs) and run
// through encodeURIComponent of base64 to keep it copy/pasteable.
export function encodeSdp(desc) {
  const json = JSON.stringify({ type: desc.type, sdp: desc.sdp });
  // base64url
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeSdp(s) {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const json = atob(padded);
  return JSON.parse(json);
}

// Wait for ICE gathering to finish — turns trickle ICE into one-shot
// non-trickle, so the entire SDP fits in a single URL exchange.
function waitIceGatheringComplete(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const onChange = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", onChange);
    // Belt-and-suspenders: time out after 4s and use whatever we have.
    setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }, 4000);
  });
}

export class ManualPeer extends EventTarget {
  constructor({ role, iceServers, dcLabel } = {}) {
    super();
    this.role = role;
    this.pc = newPeerConnection(iceServers);
    this.dc = null;
    this.dcLabel = dcLabel || DEFAULT_DC_LABEL;
    if (role === "host") {
      this._attachDataChannel(this.pc.createDataChannel(this.dcLabel, { ordered: true }));
    } else {
      this.pc.addEventListener("datachannel", (e) => this._attachDataChannel(e.channel));
    }
    this.pc.addEventListener("connectionstatechange", () => {
      this.dispatchEvent(new CustomEvent("connection-state", { detail: this.pc.connectionState }));
    });
  }

  _attachDataChannel(dc) {
    if (!this.channels) this.channels = new Map();
    this.channels.set(dc.label, dc);
    if (!this.dc) this.dc = dc;  // first attached channel is the primary (back-compat for single-channel consumers)
    dc.addEventListener("open", () => {
      this.dispatchEvent(new Event("channel-open"));
      this.dispatchEvent(new CustomEvent("labeled-channel-open", { detail: { label: dc.label, channel: dc } }));
    });
    dc.addEventListener("close", () => {
      this.dispatchEvent(new Event("channel-close"));
      this.dispatchEvent(new CustomEvent("labeled-channel-close", { detail: { label: dc.label } }));
    });
  }

  // Look up a data channel by its label (Stage 2 multi-channel mode).
  channel(label) {
    return this.channels && this.channels.get(label) || null;
  }

  // Host: produce an offer URL fragment.
  async createOfferBlob() {
    if (this.role !== "host") throw new Error("createOfferBlob is host-only");
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await waitIceGatheringComplete(this.pc);
    return encodeSdp(this.pc.localDescription);
  }

  // Driver: consume host's offer, produce an answer URL fragment.
  async consumeOfferProduceAnswer(offerBlob) {
    if (this.role !== "driver") throw new Error("consumeOfferProduceAnswer is driver-only");
    const offer = decodeSdp(offerBlob);
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await waitIceGatheringComplete(this.pc);
    return encodeSdp(this.pc.localDescription);
  }

  // Host: paste driver's answer to complete the handshake.
  async consumeAnswer(answerBlob) {
    if (this.role !== "host") throw new Error("consumeAnswer is host-only");
    const answer = decodeSdp(answerBlob);
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  close() {
    if (this.dc) try { this.dc.close(); } catch {}
    if (this.pc) try { this.pc.close(); } catch {}
  }
}

// Compute the SHA-256 fingerprint of the local DTLS cert from an SDP
// string — useful for out-of-band verification (display in UI, user
// reads it to peer over a side channel to confirm no MITM on the
// signaling path).
export function dtlsFingerprintFromSdp(sdp) {
  const m = sdp.match(/a=fingerprint:[^ ]+ ([0-9A-Fa-f:]+)/);
  return m ? m[1] : null;
}
