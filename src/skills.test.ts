import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderCommandResult } from "./cli/output.ts";
import { cli } from "./cli.ts";
import {
  discoverSkills,
  getSkillContents,
  parseSkillFrontmatter,
  runSkillsCommand,
} from "./skills.ts";

const ORIGINAL_SKILLS_DIR = process.env["WORKFOREST_SKILLS_DIR"];
const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_EXIT_CODE = process.exitCode;
const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeSkill({
  root,
  dirName,
  name,
  description,
  hidden,
  body = "Content here.",
}: {
  root: string;
  dirName?: string;
  name: string;
  description: string;
  hidden?: boolean;
  body?: string;
}): Promise<string> {
  const skillDir = path.join(root, dirName ?? name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      hidden === undefined ? null : `hidden: ${String(hidden)}`,
      "---",
      "",
      `# ${name}`,
      "",
      body,
      "",
    ]
      .filter((line) => line !== null)
      .join("\n"),
    "utf8",
  );
  return skillDir;
}

afterEach(async () => {
  vi.restoreAllMocks();

  if (ORIGINAL_SKILLS_DIR === undefined) {
    delete process.env["WORKFOREST_SKILLS_DIR"];
  } else {
    process.env["WORKFOREST_SKILLS_DIR"] = ORIGINAL_SKILLS_DIR;
  }

  process.argv = [...ORIGINAL_ARGV];
  process.exitCode = ORIGINAL_EXIT_CODE;

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("skills", () => {
  it("parses frontmatter with multiline descriptions and hidden flag", () => {
    expect(
      parseSkillFrontmatter(`---
name: core
description: First line
  second line
hidden: true
---

# Core
`),
    ).toEqual({
      name: "core",
      description: "First line second line",
      hidden: true,
    });
  });

  it("discovers skills across directories and records hidden state", async () => {
    const visibleDir = await createTempDir("workforest-skills-");
    const hiddenDir = await createTempDir("workforest-skill-data-");
    await writeSkill({
      root: visibleDir,
      name: "core",
      description: "Core skill",
    });
    await writeSkill({
      root: hiddenDir,
      name: "workforest",
      description: "Discovery stub",
      hidden: true,
    });

    await expect(discoverSkills([visibleDir, hiddenDir])).resolves.toEqual([
      expect.objectContaining({
        name: "core",
        description: "Core skill",
        hidden: false,
      }),
      expect.objectContaining({
        name: "workforest",
        description: "Discovery stub",
        hidden: true,
      }),
    ]);
  });

  it("loads skill content with references for --full", async () => {
    const skillsDir = await createTempDir("workforest-skills-");
    const skillDir = await writeSkill({
      root: skillsDir,
      name: "core",
      description: "Core skill",
      body: "Skill body.",
    });
    await mkdir(path.join(skillDir, "references"));
    await writeFile(
      path.join(skillDir, "references", "commands.md"),
      "# Commands\n",
      "utf8",
    );

    await expect(
      getSkillContents({
        skillsDirs: [skillsDir],
        names: ["core"],
        all: false,
        full: true,
      }),
    ).resolves.toEqual([
      {
        name: "core",
        content: expect.stringContaining("Skill body."),
        files: [
          {
            path: "references/commands.md",
            content: "# Commands\n",
          },
        ],
      },
    ]);
  });

  it("lists visible skills from WORKFOREST_SKILLS_DIR", async () => {
    const skillsDir = await createTempDir("workforest-skills-");
    const logs: string[] = [];
    process.env["WORKFOREST_SKILLS_DIR"] = skillsDir;
    await writeSkill({
      root: skillsDir,
      name: "core",
      description: "Core Workforest usage guide",
    });
    await writeSkill({
      root: skillsDir,
      name: "workforest",
      description: "Hidden stub",
      hidden: true,
    });
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    process.argv = ["node", "wf", "skills"];
    process.exitCode = undefined;

    await cli();

    expect(logs.join("\n")).toContain("core");
    expect(logs.join("\n")).not.toContain("workforest");
    expect(process.exitCode).toBeUndefined();
  });

  it("returns JSON success envelopes", async () => {
    const skillsDir = await createTempDir("workforest-skills-");
    const stdout: string[] = [];
    process.env["WORKFOREST_SKILLS_DIR"] = skillsDir;
    await writeSkill({
      root: skillsDir,
      name: "core",
      description: "Core Workforest usage guide",
    });

    const result = await runSkillsCommand({ command: "list", json: true });
    renderCommandResult(result, {
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
    });

    expect(JSON.parse(stdout.join(""))).toEqual({
      ok: true,
      data: [
        {
          name: "core",
          description: "Core Workforest usage guide",
        },
      ],
    });
  });

  it("gets a skill with full supplementary files through the CLI", async () => {
    const skillsDir = await createTempDir("workforest-skills-");
    const skillDir = await writeSkill({
      root: skillsDir,
      name: "core",
      description: "Core skill",
      body: "Skill body.",
    });
    const writes: string[] = [];
    process.env["WORKFOREST_SKILLS_DIR"] = skillsDir;
    await mkdir(path.join(skillDir, "references"));
    await writeFile(
      path.join(skillDir, "references", "commands.md"),
      "# Commands\n",
      "utf8",
    );
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    vi.spyOn(console, "log").mockImplementation((...args) => {
      writes.push(`${args.join(" ")}\n`);
    });

    process.argv = ["node", "wf", "skills", "get", "core", "--full"];
    process.exitCode = undefined;

    await cli();

    const output = writes.join("");
    expect(output).toContain("Skill body.");
    expect(output).toContain("--- references/commands.md ---");
    expect(output).toContain("# Commands");
  });

  it("prints skill paths", async () => {
    const skillsDir = await createTempDir("workforest-skills-");
    const logs: string[] = [];
    const skillDir = await writeSkill({
      root: skillsDir,
      name: "core",
      description: "Core skill",
    });
    process.env["WORKFOREST_SKILLS_DIR"] = skillsDir;
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    process.argv = ["node", "wf", "skills", "path", "core"];
    process.exitCode = undefined;

    await cli();

    expect(logs).toEqual([skillDir]);
  });

  it("prints JSON errors", async () => {
    const skillsDir = await createTempDir("workforest-skills-");
    const logs: string[] = [];
    process.env["WORKFOREST_SKILLS_DIR"] = skillsDir;
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    process.argv = ["node", "wf", "skills", "get", "missing", "--json"];
    process.exitCode = undefined;

    await cli();

    expect(JSON.parse(logs.join(""))).toEqual({
      ok: false,
      error: {
        kind: "operational",
        message: "Skill not found: missing",
      },
    });
    expect(process.exitCode).toBe(1);
  });
});
