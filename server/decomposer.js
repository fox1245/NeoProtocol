// v0.2 stub decomposer.
//
// Pattern-matches the user's NL prompt against known task types and
// returns a fixture Task Offer. Intentionally dumb: the contract is
// "input prompt → conformant Task Offer JSON". Once this contract is
// stable, v0.2-B will replace the body with a real frontier-model call
// (Anthropic Claude or OpenAI GPT structured-output) without changing
// the signature.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PATTERNS = [
  {
    name: "sentiment_batch",
    test: (p) => /sentiment|review|positive|negative|감성/i.test(p),
    fixture: "sentiment_batch.json"
  }
];

export async function decompose(prompt) {
  const match = PATTERNS.find((p) => p.test(prompt));
  if (!match) {
    const supported = PATTERNS.map((p) => p.name).join(", ");
    const err = new Error(
      `stub_decomposer: prompt did not match any known pattern (have: ${supported}). ` +
      `v0.2-B will replace this stub with a real LLM-based decomposer.`
    );
    err.code = "no_pattern_match";
    throw err;
  }
  const raw = await fs.readFile(path.join(__dirname, "fixtures", match.fixture), "utf8");
  const offer = JSON.parse(raw);

  // Stamp identifiers + descriptions so consecutive requests don't
  // collide on the in-memory store.
  offer.task.id = randomUUID();
  offer.task.human_description =
    `[stub-decomposer matched ${match.name}] ${prompt.slice(0, 200)}`;

  // The fixture's input_data_ref placeholder gets resolved server-side
  // (see GET /tasks/:id/data in index.js).
  offer.input_data_ref = `/tasks/${offer.task.id}/data`;

  return offer;
}
