# Cowork PoC — Stage 1: Living document with two agents

Reference implementation for [SPEC §17](../../SPEC.md) Stage 1 of the
[Collaborative Workspace roadmap](../../docs/roadmap-collaborative-workspace.md).

## What it shows

Two browsers open the same URL, join a room, and share a single
JavaScript document via Y.js CRDT over WebRTC. Each user has their
own BYOK agent panel (Anthropic in v0.3, more later). When a user
asks their agent to make an edit, the agent sees the current buffer,
returns a suggested replacement, the user previews + applies, and the
edit propagates to the peer with attribution metadata so the peer's
UI can flash a "this came from User A's agent" toast.

The Originator only signals — it never sees the document, the prompt,
the agent output, or the attribution. ACP and Y.js traffic both ride
DTLS-protected SCTP, e2e between peer browsers.

## Run

```bash
# Terminal 1 — Originator (provides /signaling for room rendezvous)
cd server
npm install
npm start                                    # → :3001

# Terminal 2 — static file server for the demo HTML
cd examples
python3 -m http.server 8801                  # → :8801
```

Open `http://localhost:8801/cowork-poc/index.html` in two browser
windows (two tabs / two browsers / two LAN-peers). In each window:

1. Edit the **Name** field if you like (used for the cursor flag).
2. Use the same **Room** name in both windows.
3. Click **Join**.

Within ~1s both windows show "connected" and the seeded starter
document. Type in either window to confirm live cursor sync.

To exercise the agent flow:

1. Pick **Mock (offline; for testing)** in one window's agent
   dropdown — no API key needed; runs a deterministic stub agent so
   the demo works without network.
2. Type a prompt (e.g. *"add JSDoc above each function"*).
3. Click **Ask my agent** → suggestion card appears with a diff preview.
4. Click **Apply** → the edit lands locally and propagates to the peer.
5. The peer's window flashes a toast and adds an "agent edit landed"
   line to its activity log.

For real model output, switch the dropdown to **Anthropic**, paste
your `sk-ant-…` key, and ask non-trivial questions. The key lives in
this browser's `sessionStorage` and is sent only to
`api.anthropic.com` directly from your browser — never to the
Originator, never to the peer.

## Files

| File | What |
|---|---|
| `index.html` | UI shell — header, two-pane layout, agent panel, suggestion card, activity log |
| `app.js` | Wiring — Join/Leave, peer handshake, agent prompt flow, suggestion → apply |
| `peer.js` | Reused from `../p2p-acp-poc/peer.js` (with parameterized data-channel label) |
| `ydoc-channel.js` | Y.js sync + awareness over an `RTCDataChannel` (sync_step1 / step2 / update + awareness.update frames). ~110 LOC |
| `workspace.js` | CodeMirror 6 + `yCollab` binding + `applyAgentEdit` (CRDT-friendly minimal-change apply with attribution metadata) |
| `agent.js` | BYOK Anthropic Messages API client + offline mock agent |

## How it relates to Federated Mode (§16)

Stage 1 reuses the §16 Federated Mode primitives whole:

| Federated Mode primitive | Cowork Stage 1 use |
|---|---|
| Originator signaling (`/signaling`) | Same. Same trust class. |
| `SignalingPeer` from `p2p-acp-poc` | Reused with `dcLabel: "neoprotocol-workspace"` |
| `RTCDataChannel` over DTLS/SCTP | Same; just a different label so Stage 2 can multiplex ACP |
| §16.4 trust class (Originator never sees content) | Inherited unchanged |

What's new in Stage 1:
- Y.js Doc + CodeMirror + `yCollab` binding
- A custom Y.js provider (`ydoc-channel.js`) over the existing data
  channel — no separate y-webrtc signaling, no separate Yjs server.
- Edit attribution metadata (`agentId`, `peerId`) traveling with each
  agent-applied transaction.
- First-joiner seed rule (SPEC §17.2.2) — preventing a CRDT
  double-seed race the PoC verification caught.

## What's NOT in Stage 1

(Stages 2+ — see roadmap.)

- Cross-agent ACP (User A's agent → User B's agent with consent)
- Real workspace folder via `FileSystemDirectoryHandle`
- Multi-buffer / file tree
- Local-model agent (transformers.js + WebGPU)
- Multi-peer (>2 Coworkers) mesh
- TURN fallback for symmetric NAT

## Known limits

- **Diff preview is naive** (line-level prefix/suffix trim, not Myers).
  When the agent inserts content mid-document the preview marks much
  of the file as removed-and-readded; the actual `applyAgentEdit`
  uses a character-level minimal change, so what lands in the editor
  is correct, just the visualization is over-conservative.
- **Browser support**: WebRTC + DataChannel + ESM modules + import
  maps. Tested on Chromium-based browsers. Other modern browsers
  *should* work but Stage 1 hasn't been verified on them.
- **Symmetric NAT** breaks WebRTC connection establishment. STUN-only
  in v0.3. TURN policy is on the v1 roadmap.
- **No persistence** — refresh either tab and the doc is reset (the
  remaining peer keeps its copy; the rejoining peer re-syncs from
  whoever's still connected). Closing the *last* peer loses the doc.
