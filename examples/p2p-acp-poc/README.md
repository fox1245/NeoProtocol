# Federated Mode PoC — Browser↔Browser ACP over WebRTC

Two browsers run agents and talk to each other over a P2P WebRTC
data channel using the **ACP wire format** (Zed Agent Client Protocol
— JSON-RPC 2.0, NDJSON-style framing). No central agent service.
The Originator is involved only in signaling (and only optionally —
SDP-via-URL mode runs with zero runtime server).

This is the reference implementation for [SPEC §16](../../SPEC.md).
For the design rationale + cross-network safety profile, see
[docs/federated-mode.md](../../docs/federated-mode.md).

## What it shows

- Two peers establish a WebRTC `RTCDataChannel` and exchange ACP
  JSON-RPC 2.0 frames over it.
- The driver sends `session/prompt` to the host's agent.
- The agent calls back via `fs/read_text_file` with a Virtual Path
  (`np://session/<id>/notes.txt`); the driver shows a permission
  dialog before exposing the document.
- The agent streams a deterministic mock summary back via
  `session/update` notifications, then returns
  `{ stopReason: "end_turn" }`.
- Both Standard Mode (Originator-as-signaling) and Minimal Mode
  (SDP-via-URL, no server) work in the same UI — toggle via the
  "Mode" dropdown.

## Run

You'll want two browser windows. They can be on the same machine
(two tabs / two browsers / private window + normal window) or on two
machines on the same LAN.

### Option A — Standard Mode (Originator signaling)

```bash
# 1. Originator (also serves the demo HTML)
cd server
npm install
npm start                                    # → :3001

# 2. Static file server for the demo (any will do)
cd ../examples/p2p-acp-poc
python3 -m http.server 8800                  # → :8800
```

Open `http://localhost:8800` in two browser windows:

- **Window 1:** Role = `Host`, Mode = `Standard`. Click **Connect**.
- **Window 2:** Role = `Driver`, Mode = `Standard`. Click **Connect**.

Both windows show "connected" once SDP/ICE complete. In the Driver
window, edit the virtual document if you wish, type a prompt, and
click **Send prompt**. The Driver shows a permission dialog when the
agent asks to read the document; click **Allow** to see the streamed
summary.

### Option B — Minimal Mode (zero server)

```bash
# Just a static file server. No Originator.
cd examples/p2p-acp-poc
python3 -m http.server 8800
```

Open `http://localhost:8800` in two browser windows:

- **Window 1:** Role = `Host`, Mode = `Minimal`. Click
  **Create offer URL**. Copy the URL shown.
- **Window 2:** Role = `Driver`, Mode = `Minimal` is auto-selected
  if you just paste the offer URL into your address bar. Click
  **Generate answer URL**. Copy the URL shown.
- **Window 1:** Paste the answer URL into the textarea, click
  **Connect using answer**.

The connection completes once both peers' ICE candidates converge.
Then the prompt flow is identical to Standard Mode.

## What's in this directory

| File | Purpose |
|---|---|
| `index.html` | UI — role + mode toggle, prompt input, permission dialog, stream output, RPC log |
| `app.js`     | Wires the UI to the modules below |
| `peer.js`    | `SignalingPeer` (Standard Mode) + `ManualPeer` (Minimal Mode); SDP encode/decode; ICE gathering wait |
| `acp.js`     | ACP wire format — `JsonRpcChannel` over `RTCDataChannel`, `STOP_REASON` enum, Virtual Path validators, `RpcError` |
| `agent.js`   | The "host" half — implements `initialize`, `session/new`, `session/prompt`, calls back into `fs/read_text_file`, streams `session/update` |
| `driver.js`  | The "client" half — runs handshake, serves `fs/read_text_file` for Virtual Paths only, gates each call through a permission dialog |

## What it doesn't do

The PoC is a faithful but minimal reference. Notably:

- No TURN — symmetric-NAT cases will fail in Standard Mode. Fall
  back to Minimal Mode (which has the same NAT problem, but at least
  a different failure path) or run on a LAN.
- 1:1 only — multi-host fan-out is wire-format-supported but not
  implemented in the demo. (See SPEC §16.8.)
- No room authentication — anyone who knows the room name can join.
- The agent is a deterministic mock summarizer (word count, first
  sentence, top terms), not a real model. The point is the
  protocol; swap in a real model later.

## Where to look first if it doesn't work

1. **Browser console.** Both windows. WebRTC errors are logged there.
2. **The RPC log panel.** Each frame the driver sends/receives is
   printed there with a timestamp.
3. **Originator logs (Standard Mode).** The server prints
   `[signaling] peer X joined room Y` for each peer; if you don't
   see two of those for the same room, the peers aren't pairing.
4. **DTLS fingerprint mismatch.** Won't normally happen, but if a
   browser cached an old PeerConnection's certificate, force-reload
   both windows.
