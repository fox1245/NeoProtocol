// JSON Schema validation for Task Offer + Result Envelope, ajv-based.

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const offerSchema = JSON.parse(
  await fs.readFile(path.join(__dirname, "schemas", "task_offer.json"), "utf8")
);
const envelopeSchema = JSON.parse(
  await fs.readFile(path.join(__dirname, "schemas", "result_envelope.json"), "utf8")
);

export const validateOffer = ajv.compile(offerSchema);
export const validateEnvelope = ajv.compile(envelopeSchema);

export function formatErrors(errors) {
  return (errors || []).map((e) => `${e.instancePath || "(root)"}: ${e.message}`);
}
