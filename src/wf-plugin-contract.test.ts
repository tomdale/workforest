import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("wf plugin contracts", () => {
  it("requires integration auditor progress updates in the role and handoff skill", async () => {
    const [auditorContract, integrateSkill] = await Promise.all([
      readFile(
        path.resolve(".agents/plugins/wf/agents/integration-auditor.toml"),
        "utf8",
      ),
      readFile(
        path.resolve(".agents/plugins/wf/skills/integrate/SKILL.md"),
        "utf8",
      ),
    ]);
    const normalizedIntegrateSkill = integrateSkill.replace(/\s+/g, " ");

    expect(auditorContract).toContain(
      "After the initial diff scan, send a progress update",
    );
    expect(auditorContract).toContain("Repeat that cadence every 60 seconds");
    expect(auditorContract).toContain(
      "Do not save progress updates for the final response",
    );

    expect(normalizedIntegrateSkill).toContain(
      "When spawning or prompting the auditor, include this progress contract",
    );
    expect(normalizedIntegrateSkill).toContain(
      "after the initial diff scan, send a progress update",
    );
    expect(normalizedIntegrateSkill).toContain("repeat every 60 seconds");
  });
});
