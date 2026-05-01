// ACP wire format — browser subset.
//
// NeoGraph already implements the full bidirectional Agent Client
// Protocol (Zed) over NDJSON-over-stdio in `neograph::acp`. We reuse
// the wire format verbatim — JSON-RPC 2.0 frames, line-delimited —
// but ride it over a WebRTC RTCDataChannel instead of stdio. Each
// channel `send()` carries one frame; SCTP preserves message
// boundaries, so we never have to reassemble fragments.
//
// Methods implemented in the PoC (subset of the Zed spec — see
// SPEC §16.4 for the cross-network safety profile):
//
//   driver → agent (requests)
//     initialize             { protocolVersion, clientCapabilities }
//     session/new            { mcpServers? }                  → { sessionId }
//     session/prompt         { sessionId, prompt }            → { stopReason }
//     session/cancel         { sessionId }                    → null
//
//   agent → driver (notifications + callbacks)
//     session/update         { sessionId, update: { kind, ... } }   notification
//     session/request_permission
//                            { sessionId, toolCall, options } → { outcome }
//     fs/read_text_file      { sessionId, path, line?, limit? }
//                                                            → { content }
//     fs/write_text_file     { sessionId, path, content }    → null
//
// `path` MUST be a Virtual Path (§16.4.1): begins with `np://session/`
// and is scoped to the session. Real-filesystem paths MUST be rejected
// by the driver.

export const ACP_PROTOCOL_VERSION = 1;

// Stop reasons — exact 5-value enum from the Zed schema. We mirror
// NeoGraph's `acp::StopReason` here (Round 1 audit, c3636fd).
export const STOP_REASON = Object.freeze({
  END_TURN: "end_turn",
  CANCELLED: "cancelled",
  MAX_TOKENS: "max_tokens",
  MAX_TURN_REQUESTS: "max_turn_requests",
  REFUSAL: "refusal"
});

// JSON-RPC error codes used by the wire (subset).
export const ERR = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  // Application-level (NeoProtocol Federated Mode extensions):
  PATH_NOT_VIRTUAL: -32001,
  PATH_OUT_OF_SCOPE: -32002,
  PERMISSION_DENIED: -32003,
  SESSION_NOT_FOUND: -32004,
  BACKPRESSURE: -32000
});

const VIRTUAL_PATH_PREFIX = "np://session/";

export function isVirtualPath(p) {
  if (typeof p !== "string") return false;
  if (!p.startsWith(VIRTUAL_PATH_PREFIX)) return false;
  // Reject any '..' segment — defense in depth even though we don't
  // touch a real filesystem.
  return !p.split("/").includes("..");
}

export function virtualPathSession(p) {
  if (!isVirtualPath(p)) return null;
  // np://session/<id>/<rest>
  const tail = p.slice(VIRTUAL_PATH_PREFIX.length);
  const slash = tail.indexOf("/");
  return slash < 0 ? tail : tail.slice(0, slash);
}

// JSON-RPC framer over a WebRTC RTCDataChannel. Each `send()` writes
// exactly one JSON frame; messages arrive whole because SCTP preserves
// boundaries (unlike a TCP byte stream).
export class JsonRpcChannel extends EventTarget {
  constructor(dataChannel) {
    super();
    this.dc = dataChannel;
    this.nextId = 1;
    this.pending = new Map(); // id → { resolve, reject, method }
    this.handlers = new Map(); // method → async (params, ctx) → result
    this.notificationHandlers = new Map();
    this.closed = false;

    this.dc.addEventListener("message", (e) => this._onMessage(e));
    this.dc.addEventListener("close", () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        p.reject(new Error("data channel closed"));
      }
      this.pending.clear();
      this.dispatchEvent(new Event("close"));
    });
    this.dc.addEventListener("error", (e) => {
      this.dispatchEvent(new CustomEvent("error", { detail: e }));
    });
  }

  on(method, handler) {
    this.handlers.set(method, handler);
  }

  onNotification(method, handler) {
    this.notificationHandlers.set(method, handler);
  }

  request(method, params, { timeoutMs = 30_000 } = {}) {
    if (this.closed) return Promise.reject(new Error("channel closed"));
    const id = this.nextId++;
    const frame = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        method
      });
      this.dc.send(JSON.stringify(frame));
    });
  }

  notify(method, params) {
    if (this.closed) return;
    this.dc.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  async _onMessage(ev) {
    let frame;
    try {
      frame = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data));
    } catch {
      this.dispatchEvent(new CustomEvent("warning", { detail: "non-JSON frame discarded" }));
      return;
    }
    if (frame.jsonrpc !== "2.0") {
      this.dispatchEvent(new CustomEvent("warning", { detail: "missing jsonrpc:2.0" }));
      return;
    }
    // Response (has id, no method)
    if ("id" in frame && !("method" in frame)) {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      if (frame.error) {
        const err = new Error(frame.error.message || "rpc error");
        err.code = frame.error.code;
        err.data = frame.error.data;
        p.reject(err);
      } else {
        p.resolve(frame.result);
      }
      return;
    }
    // Notification (no id)
    if ("method" in frame && !("id" in frame)) {
      const h = this.notificationHandlers.get(frame.method);
      if (h) {
        try { await h(frame.params); }
        catch (e) { this.dispatchEvent(new CustomEvent("warning", { detail: `notification handler threw: ${e.message}` })); }
      }
      return;
    }
    // Request
    if ("method" in frame && "id" in frame) {
      const handler = this.handlers.get(frame.method);
      if (!handler) {
        this.dc.send(JSON.stringify({
          jsonrpc: "2.0", id: frame.id,
          error: { code: ERR.METHOD_NOT_FOUND, message: `method not found: ${frame.method}` }
        }));
        return;
      }
      try {
        const result = await handler(frame.params || {});
        this.dc.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: result ?? null }));
      } catch (e) {
        this.dc.send(JSON.stringify({
          jsonrpc: "2.0", id: frame.id,
          error: {
            code: typeof e.code === "number" ? e.code : ERR.INTERNAL,
            message: e.message || "handler error",
            ...(e.data !== undefined ? { data: e.data } : {})
          }
        }));
      }
      return;
    }
    this.dispatchEvent(new CustomEvent("warning", { detail: "malformed JSON-RPC frame" }));
  }
}

// Throw-able RPC error helper for handlers.
export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}
