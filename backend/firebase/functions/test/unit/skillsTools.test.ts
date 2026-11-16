import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOLS } from "../../src/mcp/tools";

const DIR = join(__dirname, "../../../../../agents/hermes/skills");
const real = new Set(TOOLS.map((t) => t.name));

describe("skills only name tools that exist", () => {
  for (const skill of readdirSync(DIR)) {
    it(skill, () => {
      const text = readFileSync(join(DIR, skill, "SKILL.md"), "utf8");
      const line = /## Allowed tools\n([\s\S]*?)\n\n/.exec(text)?.[1] ?? "";
      const names = line.replace(/\.$/, "").split(",").map((s) => s.trim()).filter(Boolean);
      expect(names.length).toBeGreaterThan(0);
      expect(names.filter((n) => !real.has(n))).toEqual([]);
    });
  }
  it("every write tool is reachable from at least one skill", () => {
    const allowed = new Set<string>();
    for (const skill of readdirSync(DIR)) {
      const t = readFileSync(join(DIR, skill, "SKILL.md"), "utf8");
      (/## Allowed tools\n([\s\S]*?)\n\n/.exec(t)?.[1] ?? "").replace(/\.$/, "").split(",").forEach((n) => allowed.add(n.trim()));
    }
    expect(TOOLS.map((t) => t.name).filter((n) => !allowed.has(n))).toEqual([]);
  });
});
