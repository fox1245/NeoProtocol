// Y.js sync provider over an existing RTCDataChannel.
//
// Y.js's stock providers (y-webrtc, y-websocket) bring their own
// transport. Here, the WebRTC connection already exists — set up by
// the Federated Mode signaling handshake (SPEC §16) — so we ride on
// it directly. One RTCPeerConnection, one RTCDataChannel, no extra
// signaling.
//
// Wire (a length-prefixed binary stream is overkill for a PoC; we use
// JSON envelopes and base64 for the binary payloads):
//
//   { kind: "ydoc.sync_step1", sv: <base64 state vector> }
//     — sent on connect; "here is what I have, send me what's new"
//
//   { kind: "ydoc.sync_step2", update: <base64 update bytes> }
//     — reply: "here is everything you don't have"
//
//   { kind: "ydoc.update", update: <base64 update bytes> }
//     — broadcast on local document change
//
//   { kind: "awareness.update", update: <base64 awareness update> }
//     — broadcast cursor/selection state
//
// Frames are tagged so a future Stage 2 (multiplexed ACP + Workspace
// on the same channel) can discriminate. SPEC §17.2.

import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from "y-protocols/awareness";

function b64encode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class YDocChannel extends EventTarget {
  constructor(doc, dataChannel, { awareness } = {}) {
    super();
    this.doc = doc;
    this.dc = dataChannel;
    this.awareness = awareness || new Awareness(doc);
    this._origin = Symbol("remote");
    this._handshook = false;

    // Local document changes → broadcast as ydoc.update frames.
    // The `origin` filter prevents echoing remote-applied updates.
    this._onDocUpdate = (update, origin) => {
      if (origin === this._origin) return;
      this._send({ kind: "ydoc.update", update: b64encode(update) });
    };
    doc.on("update", this._onDocUpdate);

    // Local awareness changes → broadcast as awareness.update.
    this._onAwarenessUpdate = ({ added, updated, removed }, origin) => {
      if (origin === this._origin) return;
      const changedClients = added.concat(updated, removed);
      const update = encodeAwarenessUpdate(this.awareness, changedClients);
      this._send({ kind: "awareness.update", update: b64encode(update) });
    };
    this.awareness.on("update", this._onAwarenessUpdate);

    this.dc.addEventListener("message", (e) => this._onMessage(e));
    this.dc.addEventListener("open", () => this._sendStep1());
    this.dc.addEventListener("close", () => this.dispose());
    if (this.dc.readyState === "open") this._sendStep1();
  }

  _send(msg) {
    if (this.dc.readyState !== "open") return;
    this.dc.send(JSON.stringify(msg));
  }

  _sendStep1() {
    const sv = Y.encodeStateVector(this.doc);
    this._send({ kind: "ydoc.sync_step1", sv: b64encode(sv) });
    // Also send our awareness state.
    const awUpdate = encodeAwarenessUpdate(
      this.awareness,
      [...this.awareness.getStates().keys()]
    );
    this._send({ kind: "awareness.update", update: b64encode(awUpdate) });
  }

  _onMessage(e) {
    let msg;
    try { msg = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data)); }
    catch { return; }
    if (!msg || typeof msg.kind !== "string") return;

    switch (msg.kind) {
      case "ydoc.sync_step1": {
        const remoteSV = b64decode(msg.sv);
        const update = Y.encodeStateAsUpdate(this.doc, remoteSV);
        this._send({ kind: "ydoc.sync_step2", update: b64encode(update) });
        if (!this._handshook) {
          this._handshook = true;
          this.dispatchEvent(new Event("synced"));
        }
        break;
      }
      case "ydoc.sync_step2":
      case "ydoc.update": {
        Y.applyUpdate(this.doc, b64decode(msg.update), this._origin);
        break;
      }
      case "awareness.update": {
        applyAwarenessUpdate(this.awareness, b64decode(msg.update), this._origin);
        break;
      }
    }
  }

  dispose() {
    try { this.doc.off("update", this._onDocUpdate); } catch {}
    try { this.awareness.off("update", this._onAwarenessUpdate); } catch {}
  }
}
