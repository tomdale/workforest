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

  it("registers read-only planning agents with the required model settings", async () => {
    const [config, architect, detailer] = await Promise.all([
      readFile(path.resolve(".codex/config.toml"), "utf8"),
      readFile(
        path.resolve(".agents/plugins/wf/agents/plan-architect.toml"),
        "utf8",
      ),
      readFile(
        path.resolve(".agents/plugins/wf/agents/plan-detailer.toml"),
        "utf8",
      ),
    ]);

    expect(config).toContain("[agents.plan-architect]");
    expect(config).toContain(
      'config_file = "../.agents/plugins/wf/agents/plan-architect.toml"',
    );
    expect(config).toContain("[agents.plan-detailer]");
    expect(config).toContain(
      'config_file = "../.agents/plugins/wf/agents/plan-detailer.toml"',
    );

    for (const agentConfig of [architect, detailer]) {
      expect(agentConfig).toContain('model = "gpt-5.5"');
      expect(agentConfig).toContain('model_reasoning_effort = "xhigh"');
      expect(agentConfig).toContain('sandbox_mode = "read-only"');
      expect(agentConfig).toContain("Plan only.");
    }
  });

  it("documents the plan skill output contract and keeps model choice in agent config", async () => {
    const [skill, reference] = await Promise.all([
      readFile(path.resolve(".agents/plugins/wf/skills/plan/SKILL.md"), "utf8"),
      readFile(
        path.resolve(
          ".agents/plugins/wf/skills/plan/references/incremental-large-work.md",
        ),
        "utf8",
      ),
    ]);

    expect(skill).toContain("name: plan");
    expect(skill).toContain("references/incremental-large-work.md");
    expect(skill).toContain("plan-architect");
    expect(skill).toContain("plan-detailer");
    expect(skill).toContain(".agent/plans/<slug>/");
    expect(skill).toContain("plan.md");
    expect(skill).toContain("steps.md");
    expect(skill).toContain("lanes.md");
    expect(skill).toContain("integration.md");
    expect(skill).toContain("prompts/");
    expect(skill).toContain("one verification command");
    expect(skill).not.toContain("gpt-5.5");
    expect(skill).not.toContain("model_reasoning_effort");
    expect(reference).toContain("Every checkpoint should leave the repository");
    expect(reference).toContain("Give each lane exactly one responsibility");
  });
});
