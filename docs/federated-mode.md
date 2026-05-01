# Federated Mode — Design + Security Note

This document accompanies [SPEC §16](../SPEC.md). The SPEC defines
the wire — what frames are exchanged in what order, what fields are
required, what error codes apply. This note explains **why** the
design landed where it did, what alternatives were considered, and
what the security boundary actually buys.

If you only read one section, read **§3 (Trust roles)** and
**§4 (The Virtual Path namespace)**. Those are the parts most likely
to bite a careless implementer.

---

## 1. The problem

NeoProtocol's original v0.x story was **partition-and-delegate**:

- Originator (server) decomposes a user request into a graph.
- Executor (browser) runs the leaves with consent.
- Raw data stays on the Executor; only `data_locality.returns_to_
  originator` whitelisted fields flow back.

This works for "one user, one server, one browser." It does not, by
itself, let two browsers' agents talk to each other. Yet the natural
next demo is exactly that: my browser is running an agent (BYOK,
Chrome Built-in AI, or local model), your browser is running another,
and we want them to coordinate on a task without raw data moving to
either Originator or each other unbidden.

That's Federated Mode.

## 2. Why ACP, not A2A

We have two industry-relevant agent-communication wire formats:

| Aspect | A2A (Google) | ACP (Zed) |
|---|---|---|
| Symmetry | peer-to-peer | client ↔ agent (asymmetric) |
| Transport | HTTP + SSE | NDJSON over stdio |
| Bidirectional callbacks | none (task lifecycle only) | first-class (`fs/*`, `session/request_permission`) |
| Permission model | external | built into the wire |
| Discovery | `/.well-known/agent.json` AgentCard | none (client spawns agent) |

A2A's HTTP+SSE assumes both peers are HTTP servers. Browsers cannot
accept inbound HTTP, so any A2A-in-browsers solution needs a relay or
WebRTC. Once you're on WebRTC anyway, A2A's HTTP framing fights the
transport — you'd be tunneling chunked HTTP responses inside SCTP
messages with no real benefit.

ACP is **NDJSON line-delimited**, which maps 1:1 to WebRTC
`RTCDataChannel.send()`: each `send()` carries one JSON-RPC frame,
and SCTP preserves message boundaries (unlike TCP's byte stream). No
reassembly layer.

ACP's bidirectional callbacks are also the right shape: a browser
agent that needs data has to **ask** the data-owner, with a
permission gate. That semantic is exactly NeoProtocol's "raw data
stays client-side" thesis expressed at the message level.

(`neograph::acp` already implements ACP fully — including the
StopReason 5-value Zed-conformant enum, dual permission/cancel
handling, and per-session single-flight backpressure. We reuse the
wire format verbatim and only re-implement transport in JS for the
browser side.)

## 3. Trust roles

Three actors. Their data access differs sharply:

```
┌──────────────┐                         ┌──────────────┐
│ Originator   │                         │              │
│ (server)     │   relays SDP + ICE      │              │
│              │ ◄─────────────────────► │              │
│ ❶ DECOMPOSER │   (signaling only)      │              │
│ ❷ SIGNALING  │                         │              │
└──────────────┘                         │              │
                                         │              │
   Driver browser                        │   Host browser
┌──────────────┐                         │   ┌──────────────┐
│              │ ═══════════════════════ │ ═ │              │
│ ACP "client" │  RTCDataChannel (DTLS)  │   │ ACP "agent"  │
│ End User UI  │  ACP NDJSON frames      │   │ runs leaves  │
│ owns data    │                         │   │              │
└──────────────┘                         │   └──────────────┘
```

**Originator** knows:
- Room name (chosen by peers).
- Peer IDs (server-assigned UUIDs, opaque).
- Capabilities (declared by peers; the SPEC does not require this to
  be truthful in v0.3).
- SDP and ICE bytes (fingerprints, candidate IPs/ports). Cannot
  decrypt traffic.

**Originator does NOT know:**
- ACP frame contents.
- Virtual Path contents.
- Prompt text or agent output.

This is the same trust class as a TURN server, a SIP proxy, or DNS:
**rendezvous-only, not content-authoritative.** If you're comfortable
with the Originator decomposing your task (which the v0 protocol
already requires), you should be comfortable with the Originator
relaying signaling — it sees strictly less.

**Driver** knows:
- Everything in its own browser session (ACP frames it sends and
  receives, virtual document contents).
- Agent's prompt outputs.

**Host** knows:
- Prompt text the driver sent.
- Whatever Virtual Path content the driver chose to expose via
  `fs/read_text_file`.
- **Nothing else.** Notably: cannot enumerate the driver's filesystem,
  cannot probe other Virtual Paths, cannot bypass the permission gate.

The data containment story is: the driver decides, per request, what
data the host gets. Host's only access vector is asking; driver's
permission UI is the gate.

## 4. The Virtual Path namespace

The single most dangerous instinct in cross-network ACP would be:
"the host asked for `/etc/passwd`, let me read that and send it back."
The wire format makes this look natural — `fs/read_text_file` takes a
`path: string`. **NeoProtocol forbids this categorically.**

In Federated Mode, every `fs/*` path MUST match:

```
np://session/<sessionId>/<key>[/<key>...]
```

Any path that does not match this pattern is rejected with `FED-001`
(`path_not_virtual`). Any path whose `<sessionId>` does not match the
active session is rejected with `FED-002` (`path_out_of_scope`).
Path traversal (`..`) is rejected pre-emptively even though the
namespace is virtual — defense in depth.

This is enforced by the **driver**, because the driver is the one
with privileges. If a misbehaving driver implementation maps a
Virtual Path to a real file (e.g. forwards
`np://session/X/notes.txt` to `~/.bash_history`), that's the driver
choosing to leak its own data — outside the protocol's authority but
clearly identified at the boundary.

Why namespace-based instead of capability-based (e.g. opaque handles
returned by some `fs/grant_handle`)? Two reasons:

1. **Auditability.** A user reviewing the permission dialog sees a
   path that looks like a path. Opaque handles fail the eyeball test
   ("the agent wants to read `0xa31be4f`...?").

2. **Implementation simplicity.** Drivers maintain a `Map<path,
   contents>`. No handle table, no expiration logic, no per-handle
   permission state. The reference driver is ~80 lines.

The cost is that path collisions across sessions are possible if a
driver re-uses keys; the session-scoping in the path defangs this
(each session has a unique `<sessionId>`).

## 5. Why two signaling modes

A protocol that names a server in its happy path ("just connect to
your Originator") gets accused of being a service-with-a-spec. We
felt this risk was real enough to address head-on.

**Standard Mode** (Originator-as-signaling) is the practical default.
UX is one click, peers pair by room name. Originator is a dumb relay,
trust class identical to a TURN/STUN/SIP rendezvous.

**Minimal Mode** (SDP-via-URL) is the cypherpunk fallback. Zero
runtime server. Both peers wait for ICE gathering, encode the full
SDP into a URL hash fragment, and exchange URLs out-of-band (chat,
email, QR). The URL is ~1.5–2.5 KB — long but still copy-pasteable.

Critically, the **data plane is identical** between the two modes:
both produce an `RTCDataChannel` over which ACP frames flow. A peer
can advertise `signaling_modes: ["standard", "manual"]` and its
counterpart picks whichever it supports. Conformance to one mode is
enough to be a conformant Federated Mode peer.

This is the same pattern as Tor (directory authorities + bridges):
named happy-path infrastructure plus a documented escape hatch for
deployments that won't tolerate the named infrastructure.

## 6. What the implementation does NOT do

- **No TURN server.** v0.3 ships STUN only. Symmetric-NAT cases
  (~5–10% of network setups, mostly enterprise) will fail to connect
  in Standard Mode. The graceful answer is to fall back to Minimal
  Mode, which doesn't help with NAT either but at least doesn't lie
  about why. v1 may add TURN policy, but TURN servers are operational
  cost the project can't yet afford to specify.

- **No multi-host fan-out.** The wire format already supports
  multiple peers in a room (the `peers:` array on `joined`), and
  Federated Mode in principle supports `1 driver → N hosts` to
  parallelize leaf execution. The v0.3 reference implementation does
  not — it pairs the first host with the first driver and ignores
  the rest. Wire-level forward compatibility is preserved.

- **No room authentication.** Anyone who knows your room name can
  join. This is fine for private deployments and demos; v1 will add
  room tokens.

- **No signed Capability Statements.** A misbehaving host can lie
  about what it implements. The driver's only recourse is to
  disconnect. Cross-org adversarial attestation is v2 territory.

- **No data channel resumption.** If the data channel closes
  mid-session, the session is over. Tying this to §13.5 (cancellation
  + resumption tokens) is v1 work.

## 7. Smoke-testable claims

The PoC should make the following claims observably true:

1. With no Originator running at all, two browsers (or two tabs) can
   complete an ACP session by exchanging two URLs. (Minimal Mode.)
2. With an Originator running, two browsers can complete an ACP
   session by entering the same room name. The Originator's logs
   never reveal prompt or document content. (Standard Mode +
   rendezvous-only claim.)
3. The driver's permission dialog shows the Virtual Path before any
   `fs/*` data leaves the driver. Denying the dialog returns
   `FED-003` to the host, which then surfaces a refusal stop reason.
4. A host that requests `fs/read_text_file` for `/etc/passwd` gets
   `FED-001` back. (Virtual Path enforcement.)
5. A driver hosting one session and a host belonging to another
   cannot cross-read each other's documents. (Path scope check.)

## 8. Where to read the code

| Concern | File | LOC |
|---|---|---|
| Signaling relay (server) | `server/signaling.js` | ~180 |
| ACP JSON-RPC framing (browser) | `examples/p2p-acp-poc/acp.js` | ~190 |
| WebRTC peer (both modes) | `examples/p2p-acp-poc/peer.js` | ~220 |
| Demo agent | `examples/p2p-acp-poc/agent.js` | ~115 |
| Demo driver | `examples/p2p-acp-poc/driver.js` | ~85 |
| Wiring + UI | `examples/p2p-acp-poc/index.html`, `app.js` | ~360 |

Total Federated Mode reference implementation: under 1200 lines.
Most of that is UI. The actual protocol logic is ~600 lines.

## 9. Open questions for v1

1. Should the `joined` frame from the signaling relay include peer
   capabilities, or should peers exchange capabilities in a separate
   ACP-level handshake? Current PoC does both, which is redundant.
2. How does multi-host fan-out interact with the `data_locality`
   field in the parent Task Offer? If the driver is itself an
   Executor under an Originator, `data_locality` constraints inherit;
   the wire doesn't currently carry that downward.
3. Should `fs/*` callbacks be subject to cumulative rate limits, or
   only per-call permission? A pathological host could spam
   permission dialogs.
4. TURN policy: prefer-relay vs. prefer-direct, who pays.

These are open by design — the right answers come from real
deployments, and Federated Mode is a v0.3 feature.
