// Cross-agent ACP — SPEC §17.4 reference implementation.
//
// Pattern: ACP recursion. Each peer is BOTH an ACP client (when its
// user prompts a peer's agent) AND an ACP agent (when its user
// authorizes an inbound prompt for its own agent). The wire format
// is plain JSON-RPC 2.0 over the `neoprotocol-acp` data channel
// (SPEC §16.3 framing), reused unchanged. The permission gate sits
// at the boundary between the *user* and the *agent on the user's
// behalf*.
//
//                ┌──────── peer A's browser ───────┐    ┌──────── peer B's browser ───────┐
//   prompt ──►   │ A.user ──► A.agent              │    │ B.user receives consent dialog  │
//                │     │                            │    │     │                          │
//                │     └──ACP request─────────────► │    │     │                          │
//                │  ("I need help from peer.agent")  │    │     ▼                          │
//                │                                  │    │ permission grant decided        │
//                │                                  │ ◄──┤ B.user → B.agent runs prompt   │
//                │                                  │    │     │                          │
//                │  A.agent receives ACP response   │ ◄──┤     └──ACP response────────────│
//                │  (uses it to suggest A's edit)   │    │                                 │
//                └──────────────────────────────────┘    └─────────────────────────────────┘
//
// Permission grant variants implemented (SPEC §17.4):
//   allow_once       — this single request only
//   allow_session    — all future prompts for this active session
//   deny_once        — reject this request (FED-003); future prompts re-prompt
//   deny_session     — reject this and all future prompts for the session
//
// `allow_per_path` from §17.4 is reserved for Stage 3 when there are
// multiple Virtual Paths in flight per session; Stage 2 PoC does not
// emit it.

import { JsonRpcChannel, RpcError, ERR, STOP_REASON, ACP_PROTOCOL_VERSION } from "../p2p-acp-poc/acp.js";

export const FED_AGENT_PROTOCOL_VERSION = ACP_PROTOCOL_VERSION;

const GRANT_NONE      = 0;
const GRANT_ONCE      = 1;
const GRANT_SESSION   = 2;
const GRANT_DENY_SESS = 3;

// Per-(remote peer, agentId) grant store. Survives the session unless
// the user explicitly clears it; cleared on disconnect.
function makeGrantStore() {
  const m = new Map(); // key = `${remotePeerId}|${remoteAgentId}` → grant
  return {
    get(remotePeerId, remoteAgentId) {
      return m.get(`${remotePeerId}|${remoteAgentId}`) ?? GRANT_NONE;
    },
    set(remotePeerId, remoteAgentId, grant) {
      m.set(`${remotePeerId}|${remoteAgentId}`, grant);
    },
    clear() { m.clear(); }
  };
}

// ------------------------------------------------------------------
// Receiver side — implements the ACP "agent" half so the peer's
// driver can prompt our agent. This is what makes us a valid target
// for cross-agent calls.
// ------------------------------------------------------------------

// Build a single JsonRpcChannel that the sender + receiver halves share.
// Both halves register their own handlers / notification handlers on the
// same channel so they don't race each other for incoming frames.
export function makeCrossAgentChannel(acpChannel) {
  return new JsonRpcChannel(acpChannel);
}

export function startCrossAgentReceiver({
  rpc,                       // shared JsonRpcChannel from makeCrossAgentChannel
  ourPeerId,                 // our peer_id (string)
  ourAgentId,                // "anthropic" / "mock" / "local-gemma"
  runAgent,                  // async ({ prompt, document }) → { reasoning, newDocument }
  getDocument,               // () → string  (current Y.Text contents)
  requestPermission,         // async ({ remotePeerId, remoteAgentId, prompt }) → "allow_once" | "allow_session" | "deny_once" | "deny_session"
  onLog                      // (line) → void
} = {}) {
  const log = onLog || (() => {});
  const sessions = new Map();    // sessionId → { remotePeerId, remoteAgentId, busy }
  const grants = makeGrantStore();
  let nextSessionId = 1;

  rpc.on("initialize", async (params) => {
    log(`← initialize from ${params?.fromPeerId?.slice(0, 8) ?? "?"} (agent=${params?.fromAgentId ?? "?"})`);
    return {
      protocolVersion: FED_AGENT_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false }
      },
      // §17.5 attribution — receiver self-identifies so the asker can label edits.
      peerId: ourPeerId,
      agentId: ourAgentId
    };
  });

  rpc.on("session/new", async (params) => {
    const id = `xagent_${nextSessionId++}_${Date.now().toString(36)}`;
    sessions.set(id, {
      remotePeerId:  params?.fromPeerId  || "unknown",
      remoteAgentId: params?.fromAgentId || "unknown",
      busy: false
    });
    log(`← session/new → ${id}`);
    return { sessionId: id };
  });

  rpc.on("session/prompt", async (params) => {
    const sid = params?.sessionId;
    const s = sessions.get(sid);
    if (!s) throw new RpcError(ERR.SESSION_NOT_FOUND, `unknown session ${sid}`);
    if (s.busy) throw new RpcError(ERR.BACKPRESSURE, "session already running a prompt");

    // SPEC §17.4: permission gate.
    const standing = grants.get(s.remotePeerId, s.remoteAgentId);
    if (standing === GRANT_DENY_SESS) {
      throw new RpcError(ERR.PERMISSION_DENIED, "user denied this peer/agent for the session");
    }
    let outcome;
    if (standing === GRANT_SESSION) {
      outcome = "allow_once";  // already pre-approved; do not re-prompt
    } else {
      outcome = await requestPermission({
        remotePeerId:  s.remotePeerId,
        remoteAgentId: s.remoteAgentId,
        prompt:        String(params?.prompt ?? "")
      });
    }
    log(`  permission: ${outcome}`);

    if (outcome === "deny_session") {
      grants.set(s.remotePeerId, s.remoteAgentId, GRANT_DENY_SESS);
      throw new RpcError(ERR.PERMISSION_DENIED, "user denied (deny_session)");
    }
    if (outcome === "deny_once" || outcome === "deny") {
      throw new RpcError(ERR.PERMISSION_DENIED, "user denied (deny_once)");
    }
    if (outcome === "allow_session") {
      grants.set(s.remotePeerId, s.remoteAgentId, GRANT_SESSION);
    }

    s.busy = true;
    try {
      log(`  running our agent for ${s.remotePeerId.slice(0, 8)}…`);
      const result = await runAgent({
        prompt: String(params?.prompt ?? ""),
        document: getDocument()
      });

      // Stream the reasoning + the proposed newDocument back as ACP
      // session/update notifications, then return end_turn. This
      // matches §16.3 + the sentence-by-sentence streaming in the
      // p2p-acp-poc agent for visual continuity.
      rpc.notify("session/update", {
        sessionId: sid,
        update: { kind: "agent_message_chunk", content: { type: "text", text: result.reasoning + "\n" } }
      });
      // We carry the candidate full document in a structured trailer
      // so the asker can apply it through Stage 1's applyAgentEdit
      // pathway with attribution preserved.
      rpc.notify("session/update", {
        sessionId: sid,
        update: { kind: "candidate_document", document: result.newDocument }
      });
      log(`  → end_turn`);
      return { stopReason: STOP_REASON.END_TURN };
    } finally {
      s.busy = false;
    }
  });

  rpc.on("session/cancel", async (params) => {
    const s = sessions.get(params?.sessionId);
    if (s) s.busy = false;
    return null;
  });

  return {
    rpc,
    grants,
    onPeerLeft() { grants.clear(); }
  };
}

// ------------------------------------------------------------------
// Sender side — packages a "prompt the peer's agent" request as a
// full ACP handshake (initialize → session/new → session/prompt) and
// awaits the candidate_document trailer.
// ------------------------------------------------------------------

export function startCrossAgentSender({
  rpc,                       // shared JsonRpcChannel from makeCrossAgentChannel
  ourPeerId,
  ourAgentId,
  onLog
} = {}) {
  const log = onLog || (() => {});
  let initialized = null;     // { protocolVersion, peerId, agentId }
  let sessionId = null;
  let pendingCandidate = null; // accumulator for session/update notifications

  rpc.onNotification("session/update", (params) => {
    if (params?.sessionId !== sessionId) return;
    const update = params.update;
    if (!update) return;
    if (update.kind === "candidate_document" && typeof update.document === "string") {
      pendingCandidate = { newDocument: update.document, reasoning: pendingCandidate?.reasoning ?? "" };
    } else if (update.kind === "agent_message_chunk" && update.content?.type === "text") {
      const t = update.content.text || "";
      pendingCandidate = pendingCandidate || { reasoning: "", newDocument: null };
      pendingCandidate.reasoning = (pendingCandidate.reasoning || "") + t;
    }
  });

  async function ensureHandshake() {
    if (!initialized) {
      log(`→ initialize (peer=${ourPeerId.slice(0, 8)}, agent=${ourAgentId})`);
      initialized = await rpc.request("initialize", {
        protocolVersion: FED_AGENT_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        fromPeerId:  ourPeerId,
        fromAgentId: ourAgentId
      });
      log(`  ← peer agent (peer=${initialized.peerId?.slice(0, 8)}, agent=${initialized.agentId})`);
    }
    if (!sessionId) {
      const r = await rpc.request("session/new", {
        fromPeerId:  ourPeerId,
        fromAgentId: ourAgentId,
        mcpServers: []
      });
      sessionId = r.sessionId;
      log(`  ← sessionId=${sessionId}`);
    }
  }

  async function ask(prompt) {
    await ensureHandshake();
    log(`→ session/prompt`);
    pendingCandidate = null;
    let stopReason;
    try {
      const r = await rpc.request("session/prompt",
        { sessionId, prompt },
        { timeoutMs: 60_000 });
      stopReason = r?.stopReason;
    } catch (e) {
      if (e.code === ERR.PERMISSION_DENIED) {
        log(`  ✗ peer's user denied: ${e.message}`);
        return { denied: true, reason: e.message };
      }
      throw e;
    }
    log(`  ← stopReason=${stopReason}`);
    return {
      ...(pendingCandidate || { reasoning: "(no candidate received)", newDocument: null }),
      remotePeerId:  initialized?.peerId,
      remoteAgentId: initialized?.agentId,
      stopReason
    };
  }

  function close() {
    sessionId = null;
    initialized = null;
  }

  return { rpc, ask, close };
}
