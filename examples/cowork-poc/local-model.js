// Local-model agent backend (SPEC §17 Stage 3).
//
// Runs a small instruct-tuned LLM directly in the browser via
// transformers.js v3 + ONNX Runtime Web. The agent contract
// {prompt, document} → {reasoning, newDocument} is the same as the
// BYOK and mock backends, so callers (cross-agent receiver,
// "Ask my agent" button) don't change.
//
// Transport choice:
//   • Default: WebGPU + q4f16 (q4 weights, fp16 activations). Best
//     speed; works on Chrome / Edge with hardware acceleration.
//   • Fallback: wasm + q4 (no fp16 activations on wasm). Slower but
//     universal. Selected automatically if WebGPU unavailable.
//
// Quality note: 1–2B parameter local models are NOT Cursor-tier.
// They produce reasonable JSDoc, rename, and minor refactor edits;
// they fail at architectural reasoning. The PoC's UX framing is:
//   "Local model = explain / rename / docstring; BYOK = heavy
//    lifting; mock = offline smoke."
//
// JSON output strategy: small models are unreliable at producing
// strict JSON. Instead we prompt for "the entire updated document,
// nothing else", strip optional ``` fences, and synthesize the
// reasoning field client-side. This sidesteps the brittle JSON
// schema-following that frontier APIs handle but Gemma-2B does not.

import { pipeline, env } from "@huggingface/transformers";

// Cache: in-process pipeline per (modelId, device) pair. The first
// call triggers download (~700MB–2GB depending on model); the second
// call returns the cached pipeline instantly.
const _pipelineCache = new Map();

function cacheKey(modelId, device, dtype) { return `${modelId}|${device}|${dtype}`; }

export async function detectDevice() {
  if (typeof navigator !== "undefined" && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return "webgpu";
    } catch { /* fall through */ }
  }
  return "wasm";
}

// Default suggestions — known to work with transformers.js v3 + ONNX
// Runtime Web + WebGPU q4f16. The user can paste any other model ID
// in the UI input; setting NEOPROTOCOL_LOCAL_MODEL on window also
// overrides the default for embedded use.
export const DEFAULT_LOCAL_MODELS = Object.freeze([
  { id: "onnx-community/Llama-3.2-1B-Instruct", label: "Llama-3.2 1B (~700 MB q4f16)" },
  { id: "onnx-community/Phi-3.5-mini-instruct-onnx-web", label: "Phi-3.5 mini (~2 GB q4f16)" },
  { id: "onnx-community/gemma-2-2b-it",                  label: "Gemma 2 2B (~1.4 GB)" },
  // The user may have a Gemma 4 ONNX bundle locally (see neoclaw /
  // TransformerCPP). They can paste e.g. an http://localhost:NNNN/
  // path here and it will be honored.
  { id: "onnx-community/gemma-4-E2B-it",                 label: "Gemma 4 E2B-it (~3.4 GB) — if available" }
]);

export async function loadLocalModel({ modelId, dtype, device, onProgress, signal } = {}) {
  device = device || await detectDevice();
  if (!dtype) {
    // WebGPU: q4 weights + fp16 activations is the verified-safe combo
    //   (NeoGraph memory: q8+webgpu = silent garbage; q4f16+webgpu OK).
    // wasm: fp16 not supported, use q4 with fp32 activations.
    dtype = device === "webgpu" ? "q4f16" : "q4";
  }
  const key = cacheKey(modelId, device, dtype);
  if (_pipelineCache.has(key)) return _pipelineCache.get(key);

  // Configure ONNX Runtime Web's threading + caching. transformers.js
  // exposes these via env; we keep defaults but flip caching on so
  // repeated tab-loads use IndexedDB-cached weights.
  if (env && env.useBrowserCache !== undefined) env.useBrowserCache = true;

  const promise = pipeline("text-generation", modelId, {
    dtype,
    device,
    progress_callback: onProgress
  }).catch((err) => {
    _pipelineCache.delete(key);
    throw err;
  });
  _pipelineCache.set(key, promise);
  if (signal) {
    signal.addEventListener("abort", () => {
      _pipelineCache.delete(key);
    });
  }
  return promise;
}

const SYSTEM_PROMPT_LOCAL = `You are a coding assistant. The user is editing a document and asks you to make a change. Output ONLY the entire updated document — every line, no commentary, no markdown fences, no preamble. Preserve the original indentation and line breaks. If the request is unclear, output the document unchanged.`;

function extractAssistantText(out) {
  // transformers.js text-generation pipeline returns shapes that vary
  // by model + chat template. Be generous about what we accept.
  if (!Array.isArray(out) || out.length === 0) return "";
  const item = out[0];
  if (typeof item.generated_text === "string") return item.generated_text;
  if (Array.isArray(item.generated_text)) {
    // Chat-style: [{role, content}, ...]; take last assistant.
    for (let i = item.generated_text.length - 1; i >= 0; i--) {
      const m = item.generated_text[i];
      if (m && m.role === "assistant" && typeof m.content === "string") return m.content;
    }
    // Fallback: stringify the last entry's content.
    const last = item.generated_text[item.generated_text.length - 1];
    return (last && last.content) || "";
  }
  return "";
}

function stripCodeFence(text) {
  // Strip a single outer ```language ... ``` block if the model wrapped output.
  const m = text.match(/^\s*```[a-zA-Z0-9_+-]*\s*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1] : text;
}

export async function generateLocal({ pipe, prompt, document, maxNewTokens = 1500, signal }) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT_LOCAL },
    { role: "user",   content: `Document:\n${document}\n\n---\nRequest: ${prompt}` }
  ];
  const t0 = performance.now();
  const out = await pipe(messages, {
    max_new_tokens: maxNewTokens,
    do_sample: false,           // deterministic — code edits should not vary
    return_full_text: false,    // exclude the prompt from output
    // transformers.js does not support AbortSignal natively at the
    // pipeline level; we let the caller cancel by detaching UI.
  });
  const elapsedMs = performance.now() - t0;
  const text = stripCodeFence(extractAssistantText(out));
  return {
    reasoning: `Local model (${maxNewTokens} max_new_tokens, ${Math.round(elapsedMs)}ms) produced ${text.length} chars.`,
    newDocument: text || document    // empty output → leave doc unchanged
  };
}

// Convenience wrapper matching agent.js's other ask* signatures.
export async function askLocal({ modelId, prompt, document, onProgress, signal } = {}) {
  const pipe = await loadLocalModel({ modelId, onProgress, signal });
  return generateLocal({ pipe, prompt, document, signal });
}
