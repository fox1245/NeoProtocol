// Smoke test for the signaling relay. Spins up two WebSocket clients
// against a running server, joins them to the same room, sends a fake
// SDP-shaped payload one way and an ICE-shaped payload back, and
// verifies both peers see the right frames.
//
// Run:
//   PORT=3099 node index.js &
//   node signaling_smoke.js          # exits 0 on success

import { WebSocket } from "ws";

const URL = process.env.URL || "ws://localhost:3001/signaling";
const ROOM = `smoke-${Date.now().toString(36)}`;
const TIMEOUT_MS = 4000;

function open(role) {
  const ws = new WebSocket(URL);
  const seen = [];
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${role} timeout`)), TIMEOUT_MS);
    ws.on("open", () => {
      ws.send(JSON.stringify({ kind: "join", room: ROOM, role, capabilities: { tag: role } }));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString("utf8"));
      seen.push(msg);
      if (msg.kind === "joined") { clearTimeout(t); resolve({ ws, seen, peerId: msg.peer_id }); }
    });
    ws.on("error", reject);
  });
  return ready;
}

function waitFor(seen, predicate, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`waitFor(${label}) timed out. Seen: ${JSON.stringify(seen)}`)), TIMEOUT_MS);
    const tick = setInterval(() => {
      const m = seen.find(predicate);
      if (m) { clearInterval(tick); clearTimeout(t); resolve(m); }
    }, 25);
  });
}

async function main() {
  const host = await open("host");
  const driver = await open("driver");

  // host should see peer_joined for driver (after driver joined).
  await waitFor(host.seen, (m) => m.kind === "peer_joined" && m.peer.role === "driver", "host peer_joined");

  // host → driver: fake SDP
  host.ws.send(JSON.stringify({
    kind: "signal", to: driver.peerId,
    payload: { kind: "sdp", sdp: { type: "offer", sdp: "v=0\r\nfake\r\n" } }
  }));
  const got = await waitFor(driver.seen, (m) => m.kind === "signal" && m.payload?.kind === "sdp", "driver got sdp");
  if (got.from !== host.peerId) throw new Error("from mismatch on relay");

  // driver → host: fake ICE
  driver.ws.send(JSON.stringify({
    kind: "signal", to: host.peerId,
    payload: { kind: "ice", candidate: { candidate: "candidate:1 1 udp 1 1.2.3.4 1234 typ host" } }
  }));
  await waitFor(host.seen, (m) => m.kind === "signal" && m.payload?.kind === "ice", "host got ice");

  // driver leaves; host should see peer_left.
  driver.ws.send(JSON.stringify({ kind: "leave" }));
  driver.ws.close();
  await waitFor(host.seen, (m) => m.kind === "peer_left" && m.peer_id === driver.peerId, "host peer_left");

  host.ws.close();
  console.log("✓ signaling relay smoke test passed");
}

main().catch((e) => { console.error("✗ FAIL:", e.message); process.exit(1); });
