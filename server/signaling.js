// NeoProtocol Federated Mode — WebSocket signaling relay.
//
// Pure rendezvous: server forwards SDP offer/answer + ICE candidates
// between paired peers, never inspects the WebRTC payloads. Once peers
// have exchanged SDP and ICE, traffic flows P2P over DTLS/SCTP and the
// server drops out.
//
// Wire format (each frame is one JSON object):
//
//   client → server
//   { kind: "join",   room: "<id>", role: "host"|"driver",
//                     capabilities?: { ... } }
//   { kind: "signal", to: "<peer_id>", payload: <opaque> }
//   { kind: "leave" }
//
//   server → client
//   { kind: "joined", peer_id: "<self>", peers: [{id, role, capabilities}, ...] }
//   { kind: "peer_joined", peer: {id, role, capabilities} }
//   { kind: "peer_left",   peer_id: "<id>" }
//   { kind: "signal",      from: "<peer_id>", payload: <opaque> }
//   { kind: "error",       code: "...", reason: "..." }
//
// `payload` is opaque to the relay — typically a SDP offer/answer or an
// ICE candidate object, but the server treats it as a black box.
//
// Constraints:
//   - rooms are ephemeral and unauthenticated in v0.3 (private repo,
//     local dev). v1 adds room tokens + rate limits.
//   - max 8 peers per room (sanity cap for fan-out demos).
//   - max 1 MiB per signaling frame.

import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

const MAX_PEERS_PER_ROOM = 8;
const MAX_FRAME_BYTES = 1 << 20; // 1 MiB
const PING_INTERVAL_MS = 30_000;

// roomId → Map(peerId → { ws, role, capabilities, joinedAt })
const rooms = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendError(ws, code, reason) {
  send(ws, { kind: "error", code, reason });
}

function broadcastExcept(roomId, exceptPeerId, msg) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [pid, peer] of room) {
    if (pid !== exceptPeerId) send(peer.ws, msg);
  }
}

function peerSummary(peerId, peer) {
  return { id: peerId, role: peer.role, capabilities: peer.capabilities || null };
}

function attachPeer(roomId, peerId, ws, role, capabilities) {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Map();
    rooms.set(roomId, room);
  }
  if (room.size >= MAX_PEERS_PER_ROOM) {
    sendError(ws, "SIG-429", `room full (max ${MAX_PEERS_PER_ROOM})`);
    return false;
  }
  if (room.has(peerId)) {
    sendError(ws, "SIG-409", `peer_id collision: ${peerId}`);
    return false;
  }
  room.set(peerId, {
    ws,
    role,
    capabilities: capabilities || null,
    joinedAt: new Date().toISOString()
  });
  return true;
}

function detachPeer(roomId, peerId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.delete(peerId);
  if (room.size === 0) {
    rooms.delete(roomId);
  } else {
    broadcastExcept(roomId, peerId, { kind: "peer_left", peer_id: peerId });
  }
}

export function attachSignaling(httpServer, { path = "/signaling" } = {}) {
  const wss = new WebSocketServer({ server: httpServer, path });

  // Heartbeat — drop dead peers.
  const heartbeat = setInterval(() => {
    for (const [roomId, room] of rooms) {
      for (const [peerId, peer] of room) {
        if (peer.ws.isAlive === false) {
          peer.ws.terminate();
          continue;
        }
        peer.ws.isAlive = false;
        try { peer.ws.ping(); } catch { /* socket already gone */ }
        void roomId; void peerId;
      }
    }
  }, PING_INTERVAL_MS);
  wss.on("close", () => clearInterval(heartbeat));

  wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    let myRoom = null;
    let myPeerId = null;

    ws.on("message", (raw) => {
      if (raw.length > MAX_FRAME_BYTES) {
        sendError(ws, "SIG-413", `frame exceeds ${MAX_FRAME_BYTES} bytes`);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        sendError(ws, "SIG-400", "invalid JSON");
        return;
      }
      if (!msg || typeof msg.kind !== "string") {
        sendError(ws, "SIG-400", "missing 'kind'");
        return;
      }

      switch (msg.kind) {
        case "join": {
          if (myPeerId) {
            sendError(ws, "SIG-409", "already joined");
            return;
          }
          if (typeof msg.room !== "string" || msg.room.length === 0 || msg.room.length > 64) {
            sendError(ws, "SIG-400", "room must be a string, 1..64 chars");
            return;
          }
          if (msg.role !== "host" && msg.role !== "driver") {
            sendError(ws, "SIG-400", "role must be 'host' or 'driver'");
            return;
          }
          const peerId = randomUUID();
          if (!attachPeer(msg.room, peerId, ws, msg.role, msg.capabilities)) return;
          myRoom = msg.room;
          myPeerId = peerId;
          const others = [];
          for (const [pid, p] of rooms.get(myRoom)) {
            if (pid !== myPeerId) others.push(peerSummary(pid, p));
          }
          send(ws, { kind: "joined", peer_id: myPeerId, peers: others });
          broadcastExcept(myRoom, myPeerId, {
            kind: "peer_joined",
            peer: peerSummary(myPeerId, rooms.get(myRoom).get(myPeerId))
          });
          console.log(`[signaling] peer ${myPeerId.slice(0, 8)} joined room ${myRoom} as ${msg.role} (room size: ${rooms.get(myRoom).size})`);
          break;
        }

        case "signal": {
          if (!myPeerId) {
            sendError(ws, "SIG-401", "not joined to any room");
            return;
          }
          if (typeof msg.to !== "string") {
            sendError(ws, "SIG-400", "signal.to must be a string");
            return;
          }
          const room = rooms.get(myRoom);
          const target = room && room.get(msg.to);
          if (!target) {
            sendError(ws, "SIG-404", `peer not found: ${msg.to}`);
            return;
          }
          send(target.ws, { kind: "signal", from: myPeerId, payload: msg.payload });
          break;
        }

        case "leave": {
          if (myPeerId) {
            console.log(`[signaling] peer ${myPeerId.slice(0, 8)} left room ${myRoom} (graceful)`);
            detachPeer(myRoom, myPeerId);
            myRoom = null;
            myPeerId = null;
          }
          break;
        }

        default:
          sendError(ws, "SIG-400", `unknown kind: ${msg.kind}`);
      }
    });

    ws.on("close", () => {
      if (myPeerId) {
        console.log(`[signaling] peer ${myPeerId.slice(0, 8)} left room ${myRoom}`);
        detachPeer(myRoom, myPeerId);
      }
    });

    ws.on("error", (err) => {
      console.warn("[signaling] socket error:", err.message);
    });
  });

  return {
    stats() {
      const totalPeers = [...rooms.values()].reduce((n, r) => n + r.size, 0);
      return { rooms: rooms.size, peers: totalPeers };
    }
  };
}
