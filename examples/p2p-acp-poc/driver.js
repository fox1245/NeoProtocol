// ACP "client/driver" half — drives a remote agent over WebRTC.
//
// Responsibilities:
//   - `initialize` handshake on connect.
//   - `session/new`, `session/prompt`.
//   - Serve `fs/read_text_file` callbacks for virtual paths only,
//     gating each one through a permission dialog (§16.4.2).
//   - Render `session/update` notifications as a streaming text panel.

import { JsonRpcChannel, RpcError, ERR, ACP_PROTOCOL_VERSION, isVirtualPath, virtualPathSession } from "./acp.js";

export function startDriver(dataChannel, {
  virtualDocs,            // Map<path, string>  — what the driver is willing to expose
  onChunk,                // (text) → void
  onLog,                  // (line) → void
  requestPermission       // async ({ path }) → boolean
} = {}) {
  const log = onLog || (() => {});
  const rpc = new JsonRpcChannel(dataChannel);
  let sessionId = null;

  rpc.on("fs/read_text_file", async (params) => {
    const { path, sessionId: sid } = params || {};
    log(`← fs/read_text_file ${path}`);

    if (!isVirtualPath(path)) {
      log(`  ✗ rejected: not a Virtual Path`);
      throw new RpcError(ERR.PATH_NOT_VIRTUAL, "only np://session/... paths are allowed in Federated Mode");
    }
    const pathSid = virtualPathSession(path);
    if (sessionId && pathSid !== sessionId) {
      log(`  ✗ rejected: session scope mismatch (${pathSid} ≠ ${sessionId})`);
      throw new RpcError(ERR.PATH_OUT_OF_SCOPE, "path session does not match active session");
    }

    const ok = await requestPermission({ path });
    if (!ok) {
      log(`  ✗ permission denied`);
      throw new RpcError(ERR.PERMISSION_DENIED, "user denied fs/read_text_file");
    }
    if (!virtualDocs || !virtualDocs.has(path)) {
      throw new RpcError(ERR.INVALID_PARAMS, `no document at ${path}`);
    }
    const content = virtualDocs.get(path);
    log(`  → ${content.length} chars`);
    return { content };
  });

  rpc.on("fs/write_text_file", async (params) => {
    const { path } = params || {};
    if (!isVirtualPath(path)) {
      throw new RpcError(ERR.PATH_NOT_VIRTUAL, "only np://session/... paths are allowed");
    }
    // PoC does not implement write — surface as method not allowed.
    throw new RpcError(ERR.METHOD_NOT_FOUND, "fs/write_text_file not implemented in PoC");
  });

  rpc.onNotification("session/update", (params) => {
    const text = params?.update?.content?.text;
    if (typeof text === "string" && onChunk) onChunk(text);
  });

  async function handshake() {
    log(`→ initialize`);
    const init = await rpc.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } }
    });
    log(`  ← agent proto=${init?.protocolVersion}`);
    log(`→ session/new`);
    const s = await rpc.request("session/new", { mcpServers: [] });
    sessionId = s.sessionId;
    log(`  ← sessionId=${sessionId}`);
  }

  async function prompt(text) {
    if (!sessionId) await handshake();
    log(`→ session/prompt`);
    const r = await rpc.request("session/prompt", { sessionId, prompt: text }, { timeoutMs: 60_000 });
    log(`  ← ${JSON.stringify(r)}`);
    return r;
  }

  return { rpc, handshake, prompt, getSessionId: () => sessionId };
}
