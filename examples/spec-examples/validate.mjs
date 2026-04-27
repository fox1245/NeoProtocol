// Validate every spec-example fixture against the canonical schemas.
// Run from repo root:
//   node examples/spec-examples/validate.mjs

import Ajv2020 from "../../server/node_modules/ajv/dist/2020.js";
import addFormats from "../../server/node_modules/ajv-formats/dist/index.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");

const ajv = new Ajv2020.default({ allErrors: true, strict: false });
addFormats.default(ajv);

const offerSchema = JSON.parse(
  await fs.readFile(path.join(repo, "server", "schemas", "task_offer.json"), "utf8")
);
const envelopeSchema = JSON.parse(
  await fs.readFile(path.join(repo, "server", "schemas", "result_envelope.json"), "utf8")
);

const validateOffer    = ajv.compile(offerSchema);
const validateEnvelope = ajv.compile(envelopeSchema);

const files = (await fs.readdir(here)).filter(f =>
  f.endsWith(".offer.json") || f.endsWith(".envelope.json"));

let failed = 0;
for (const f of files.sort()) {
  const doc = JSON.parse(await fs.readFile(path.join(here, f), "utf8"));
  const validator = f.endsWith(".offer.json") ? validateOffer : validateEnvelope;
  const ok = validator(doc);
  if (ok) {
    console.log(`OK   ${f}`);
  } else {
    console.log(`FAIL ${f}`);
    for (const e of (validator.errors || []).slice(0, 5)) {
      console.log(`     ${e.instancePath || "(root)"}: ${e.message}`);
    }
    failed++;
  }
}
process.exit(failed === 0 ? 0 : 1);
