// Demo agent — implements the ACP "agent" half over a WebRTC
// RTCDataChannel.
//
// What it does:
//   1. Driver calls `session/new`, gets a sessionId.
//   2. Driver calls `session/prompt` with a prompt.
//   3. The agent calls back into the driver via `fs/read_text_file`
//      to fetch a virtual document the driver is hosting (np://session/
//      <id>/notes.txt). This is the "raw data stays client-side" pattern
//      from §16.4.1 — the agent never has the data, it has to ask.
//   4. The agent sends streamed `session/update` notifications with
//      a deterministic mock summary of the doc + the prompt.
//   5. Returns { stopReason: "end_turn" }.
//
// Note: this uses a deterministic mock summarizer (word count, first
// sentence, lowercase keyword tally) so the demo runs offline with no
// model dependency. The point is the protocol, not the AI.

import { JsonRpcChannel, RpcError, ERR, STOP_REASON, ACP_PROTOCOL_VERSION, isVirtualPath } from "./acp.js";

function makeSummary(text, prompt) {
  if (!text) return `(no document) you asked: "${prompt}"`;
  const words = text.split(/\s+/).filter(Boolean);
  const firstSentence = (text.match(/[^.!?]+[.!?]/) || [text.slice(0, 120)])[0].trim();
  const tally = {};
  for (const w of words) {
    const k = w.toLowerCase().replace(/[^a-z가-힣0-9]/g, "");
    if (k.length < 4) continue;
    tally[k] = (tally[k] || 0) + 1;
  }
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([k, v]) => `${k}(${v})`).join(", ");
  return [
    `Prompt: ${prompt}`,
    `Document length: ${words.length} words`,
    `First sentence: ${firstSentence}`,
    `Top terms: ${top || "(none)"}`
  ].join("\n");
}

function streamChunks(text, chunkSize = 24) {
  const out = [];
  for (let i = 0; i < text.length; i += chunkSize) out.push(text.slice(i, i + chunkSize));
  return out;
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function startAgent(dataChannel, { onLog } = {}) {
  const log = onLog || (() => {});
  const rpc = new JsonRpcChannel(dataChannel);
  const sessions = new Map();   // sessionId → { createdAt, busy }
  let nextSessionId = 1;
  let initialized = false;
  let clientCaps = null;

  rpc.on("initialize", async (params) => {
    log(`← initialize (proto=${params?.protocolVersion})`);
    initialized = true;
    clientCaps = params?.clientCapabilities || {};
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false }
      }
    };
  });

  rpc.on("session/new", async (params) => {
    if (!initialized) throw new RpcError(ERR.INVALID_REQUEST, "must initialize first");
    void params;
    const id = `s_${nextSessionId++}_${Date.now().toString(36)}`;
    sessions.set(id, { createdAt: Date.now(), busy: false });
    log(`← session/new → ${id}`);
    return { sessionId: id };
  });

  rpc.on("session/prompt", async (params) => {
    const sid = params?.sessionId;
    const s = sessions.get(sid);
    if (!s) throw new RpcError(ERR.SESSION_NOT_FOUND, `unknown session: ${sid}`);
    if (s.busy) throw new RpcError(ERR.BACKPRESSURE, "session already running a prompt");
    s.busy = true;
    const prompt = String(params?.prompt ?? "");
    log(`← session/prompt (${prompt.length} chars)`);

    try {
      // Step 1: ask driver for the virtual notes document.
      const docPath = `np://session/${sid}/notes.txt`;
      log(`→ fs/read_text_file ${docPath}`);
      let docContent = "";
      try {
        const r = await rpc.request("fs/read_text_file", { sessionId: sid, path: docPath });
        docContent = r?.content || "";
        log(`  ✓ got ${docContent.length} chars`);
      } catch (e) {
        log(`  ✗ ${e.code ?? "?"}: ${e.message}`);
        if (e.code === ERR.PERMISSION_DENIED) {
          // user said no — return a refusal stop reason.
          rpc.notify("session/update", {
            sessionId: sid,
            update: { kind: "agent_message_chunk", content: { type: "text", text: "(permission denied — cannot summarize without document)" } }
          });
          s.busy = false;
          return { stopReason: STOP_REASON.REFUSAL };
        }
        // other errors → proceed without the doc
      }

      // Step 2: stream the summary back as session/update chunks.
      const summary = makeSummary(docContent, prompt);
      for (const chunk of streamChunks(summary)) {
        rpc.notify("session/update", {
          sessionId: sid,
          update: { kind: "agent_message_chunk", content: { type: "text", text: chunk } }
        });
        await sleep(40);
      }
      rpc.notify("session/update", {
        sessionId: sid,
        update: { kind: "agent_message_chunk", content: { type: "text", text: "\n" } }
      });
      log(`→ end_turn`);
      return { stopReason: STOP_REASON.END_TURN };
    } finally {
      s.busy = false;
    }
  });

  rpc.on("session/cancel", async (params) => {
    const s = sessions.get(params?.sessionId);
    if (!s) throw new RpcError(ERR.SESSION_NOT_FOUND, "unknown session");
    s.busy = false;
    return null;
  });

  return { rpc, sessions };
}
