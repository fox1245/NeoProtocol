// Per-user BYOK agent — Anthropic only in Stage 1, OpenAI to follow
// when the demo grows.
//
// Mental model: this code lives in the user's browser. The API key
// the user pasted into the prompt panel is stored in sessionStorage
// and used directly against the provider's API. The Originator
// never sees it. The other peer never sees it. NeoProtocol's "raw
// data stays client-side" thesis applies to the API key too.
//
// The agent's contract for Stage 1:
//   - input:  { document, prompt }
//   - output: { reasoning, newDocument } as JSON, no other text
//
// We ask for the full updated document rather than a structured
// patch — easier to reason about for a first PoC, and the workspace
// module computes a minimal CRDT diff so cursors are not too
// disturbed when the edit lands.

const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const OPENAI_DEFAULT_MODEL = "gpt-5.4-mini";
const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";

const SYSTEM_PROMPT = `You are a coding assistant embedded in a collaborative editor.
Two humans share the same document. Each human has their own assistant
(you are one of them). The user has asked you to make a change to the
document. Respond with valid JSON only, no prose, no markdown fences:

{
  "reasoning": "1-2 sentence explanation of what you changed",
  "newDocument": "the entire updated document as a single string"
}

Rules:
- Return the WHOLE document, not a diff.
- Preserve trailing newlines and indentation style.
- If the user's request is unclear or you cannot do it, return the
  unchanged document and explain in "reasoning" why.
- Do not add commentary inside the document beyond what the user asked.`;

function tryParseJson(text) {
  // Tolerate ```json fences in case the model adds them despite the prompt.
  const fence = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  const candidate = (fence ? fence[1] : text).trim();
  return JSON.parse(candidate);
}

export async function askAnthropic({ apiKey, model, prompt, document, signal }) {
  const body = {
    model: model || ANTHROPIC_DEFAULT_MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Document:\n\`\`\`\n${document}\n\`\`\`\n\nMy request: ${prompt}`
    }]
  };
  const r = await fetch(ANTHROPIC_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify(body),
    signal
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Anthropic ${r.status}: ${t.slice(0, 240)}`);
  }
  const j = await r.json();
  const text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  let parsed;
  try { parsed = tryParseJson(text); }
  catch (e) {
    throw new Error(`agent returned non-JSON: ${e.message}; raw: ${text.slice(0, 200)}`);
  }
  if (typeof parsed.newDocument !== "string") {
    throw new Error(`agent JSON missing 'newDocument'`);
  }
  if (typeof parsed.reasoning !== "string") parsed.reasoning = "(no reasoning provided)";
  return parsed;
}

// OpenAI BYOK — chat-completions endpoint. Browser CORS is permitted
// by OpenAI as long as the key is sent via Authorization: Bearer.
// Same {reasoning, newDocument} contract as askAnthropic so callers
// don't branch on backend.
export async function askOpenAI({ apiKey, model, prompt, document, signal }) {
  const body = {
    model: model || OPENAI_DEFAULT_MODEL,
    max_completion_tokens: 4096,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: `Document:\n\`\`\`\n${document}\n\`\`\`\n\nMy request: ${prompt}` }
    ]
  };
  const r = await fetch(OPENAI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OpenAI ${r.status}: ${t.slice(0, 240)}`);
  }
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content || "";
  let parsed;
  try { parsed = tryParseJson(text); }
  catch (e) {
    throw new Error(`agent returned non-JSON: ${e.message}; raw: ${text.slice(0, 200)}`);
  }
  if (typeof parsed.newDocument !== "string") {
    throw new Error(`agent JSON missing 'newDocument'`);
  }
  if (typeof parsed.reasoning !== "string") parsed.reasoning = "(no reasoning provided)";
  return parsed;
}

// Local-model backend re-export — single entry point per agent file
// keeps app.js's "switch by mode" pattern simple. Lazy-imports the
// transformers.js dependency only when the local mode is actually used,
// so BYOK / mock users never pay the parse cost.
export async function askLocal(opts) {
  const mod = await import("./local-model.js");
  return mod.askLocal(opts);
}

// A deterministic mock so the demo can run without an API key. Useful
// for offline testing + the Playwright smoke. Mirrors the Federated
// Mode PoC's mock-summarizer pattern.
export async function askMock({ prompt, document }) {
  await new Promise((r) => setTimeout(r, 250));
  // Trivial transformation: prepend a // commented version of the prompt
  // and tag every "function" line with a JSDoc-ish comment.
  const lines = document.split("\n");
  const out = [];
  out.push(`// [mock-agent] applied: "${prompt.slice(0, 60)}"`);
  for (const line of lines) {
    const m = line.match(/^(\s*)function\s+(\w+)\s*\(/);
    if (m) {
      out.push(`${m[1]}/** ${m[2]} — added by mock agent */`);
    }
    out.push(line);
  }
  return {
    reasoning: `Mock agent: prefixed file with a tag and added JSDoc stubs above each function.`,
    newDocument: out.join("\n")
  };
}
