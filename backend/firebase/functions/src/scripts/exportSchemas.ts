/** Writes shared/schemas/*.json from the server's zod contracts (single source of truth). */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { SCHEMAS } from "../core/schemas";

const out = resolve(__dirname, "../../../../../shared/schemas");
mkdirSync(out, { recursive: true });
for (const [name, schema] of Object.entries(SCHEMAS)) {
  writeFileSync(resolve(out, `${name}.schema.json`), JSON.stringify(z.toJSONSchema(schema as z.ZodTypeAny, { io: "input" }), null, 2) + "\n");
}
console.log(`Wrote ${Object.keys(SCHEMAS).length} schemas to ${out}`);
