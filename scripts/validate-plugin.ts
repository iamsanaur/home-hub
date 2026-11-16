/* Validate a HomeHub plugin manifest: npx tsx scripts/validate-plugin.ts manifest.json */
import { readFileSync } from "node:fs";
import { validateManifest } from "../backend/firebase/functions/src/plugins/manifest";

const file = process.argv[2];
if (!file) { console.error("usage: validate-plugin.ts <manifest.json>"); process.exit(2); }
let json: unknown;
try { json = JSON.parse(readFileSync(file, "utf8")); } catch (e) { console.error(`Cannot read ${file}: ${(e as Error).message}`); process.exit(2); }
const r = validateManifest(json);
for (const i of r.issues) console.log(`${i.severity.toUpperCase().padEnd(7)} ${i.path || "(manifest)"}: ${i.message}`);
console.log(r.ok ? "OK: manifest is valid" : "INVALID: fix the errors above");
process.exit(r.ok ? 0 : 1);
