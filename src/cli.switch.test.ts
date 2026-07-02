import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it } from "vitest";
import { renderCommandResult } from "./cli/output.ts";
import {
  buildSwitchCandidates,
  runSwitchCommand,
  type SwitchPrompt,
} from "./cli/switch.ts";
import type { ParsedInvocation } from "./cli/types.ts";
import { executeCli } from "./cli.ts";
import { saveWorkspaceConfig } from "./config.ts";
import {
  writeWorkspaceMetadata,
  writeWorktreeMetadata,
} from "./workspace/metadata.ts";

const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_CWD = process.cwd();
const tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(ORIGINAL_CWD);
  restoreEnv("WORKFOREST_CONFIG_DIR", ORIGINAL_CONFIG_DIR);
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("wf switch", () => {
  it("switches to an explicit repository change selector", async () => {
    const fixture = await createSwitchFixture();

    await runSwitchCommand(invocation(["workforest/cli-redesign"]), {
      interactive: false,
      writeShellCdPath: fixture.writeShellCdPath,
    });

    expect(fixture.cdTargets).toEqual([
      path.join(fixture.baseDir, "Repos", "workforest", "cli-redesign"),
    ]);
  });

  it("switches to a bare selector only when it is unique", async () => {
    const fixture = await createSwitchFixture();

    await runSwitchCommand(invocation(["cli-redesign"]), {
      interactive: false,
      writeShellCdPath: fixture.writeShellCdPath,
    });

    expect(fixture.cdTargets).toEqual([
      path.join(fixture.baseDir, "Repos", "workforest", "cli-redesign"),
    ]);
  });

  it("reports ambiguous bare selectors with candidates", async () => {
    await createSwitchFixture();

    const result = await executeCli(["switch", "auth-fix"]);
    const rendered = renderResult(result);

    expect(result.exitCode).toBe(2);
    expect(rendered.stderr).toContain('Ambiguous selector "auth-fix".');
    expect(rendered.stderr).toContain("_adhoc/auth-fix");
    expect(rendered.stderr).toContain("vercel-agent/auth-fix");
    expect(rendered.stderr).toContain("Use <group>/<name>.");
  });

  it("reports exact selector collisions with actionable paths", async () => {
    const fixture = await createSwitchFixture();
    await mkdir(
      path.join(
        fixture.baseDir,
        "Workspaces",
        "workforest",
        "cli-redesign",
        "front",
      ),
      { recursive: true },
    );
    await writeWorkspaceMetadata(
      path.join(fixture.baseDir, "Workspaces", "workforest", "cli-redesign"),
      {
        featureName: "cli-redesign",
        branchName: "tomdale/cli-redesign",
        templateId: "workforest",
        repos: [metadataRepo("front", "git@github.com:vercel/front.git")],
      },
    );

    const result = await executeCli(["switch", "workforest/cli-redesign"]);
    const rendered = renderResult(result);

    expect(result.exitCode).toBe(2);
    expect(rendered.stderr).toContain(
      'Ambiguous selector "workforest/cli-redesign".',
    );
    expect(rendered.stderr).toContain("worktree");
    expect(rendered.stderr).toContain("template-workspace");
    expect(rendered.stderr).toContain("Repos/workforest/cli-redesign");
    expect(rendered.stderr).toContain("Workspaces/workforest/cli-redesign");
    expect(rendered.stderr).toContain(
      "This selector maps to more than one path; run from the intended path or choose it in the interactive switcher.",
    );
    expect(rendered.stderr).not.toContain("Use <group>/<name>.");
  });

  it("uses all changes as fuzzy candidates when no selector is provided", async () => {
    const fixture = await createSwitchFixture();
    await pinSwitchFixtureMtimes(fixture.baseDir);
    const promptCalls: Parameters<SwitchPrompt>[1][] = [];

    await runSwitchCommand(invocation([]), {
      interactive: true,
      writeShellCdPath: fixture.writeShellCdPath,
      prompt: async (_message, options) => {
        promptCalls.push(options);
        const selected = options.options.find(
          (option) => option.label === "vercel-agent/auth-fix",
        )?.value;
        if (!selected) throw new Error("Expected vercel-agent/auth-fix option");
        return selected;
      },
    });

    expect(promptCalls).toHaveLength(1);
    const labels = promptCalls[0]?.options.map((option) => option.label);
    expect(labels).toEqual([
      "_adhoc/auth-fix",
      "workforest/cli-redesign",
      "vercel-agent/auth-fix",
    ]);
    const optionsByLabel = new Map(
      promptCalls[0]?.options.map((option) => [option.label, option]),
    );
    expect(optionsByLabel.get("_adhoc/auth-fix")?.description).toContain(
      "front, api",
    );
    expect(optionsByLabel.get("vercel-agent/auth-fix")?.description).toContain(
      "agents, api",
    );
    expect(
      optionsByLabel.get("workforest/cli-redesign")?.description,
    ).toContain("workforest");
    expect(fixture.cdTargets).toEqual([
      path.join(fixture.baseDir, "Workspaces", "vercel-agent", "auth-fix"),
    ]);
  });

  it("uses the fullscreen surface when no selector is provided", async () => {
    const fixture = await createSwitchFixture();
    await pinSwitchFixtureMtimes(fixture.baseDir);
    const surfaceCalls: string[][] = [];

    await runSwitchCommand(invocation([]), {
      interactive: true,
      fullscreen: true,
      writeShellCdPath: fixture.writeShellCdPath,
      surface: async (entries) => {
        surfaceCalls.push(entries.map((entry) => entry.selector));
        const selected = entries.find(
          (entry) => entry.selector === "vercel-agent/auth-fix",
        );
        if (!selected) throw new Error("Expected vercel-agent/auth-fix entry");
        return selected;
      },
    });

    expect(surfaceCalls).toEqual([
      ["_adhoc/auth-fix", "workforest/cli-redesign", "vercel-agent/auth-fix"],
    ]);
    expect(fixture.cdTargets).toEqual([
      path.join(fixture.baseDir, "Workspaces", "vercel-agent", "auth-fix"),
    ]);
  });

  it("passes the current scope to the fullscreen surface", async () => {
    const fixture = await createSwitchFixture();
    const scope = { kind: "repo", name: "workforest" } as const;
    let seenScope: unknown;

    await runSwitchCommand(invocation([]), {
      interactive: true,
      fullscreen: true,
      scope,
      writeShellCdPath: fixture.writeShellCdPath,
      surface: async (_entries, currentScope) => {
        seenScope = currentScope;
        return null;
      },
    });

    expect(seenScope).toEqual(scope);
    expect(fixture.cdTargets).toEqual([]);
  });
});

describe("buildSwitchCandidates", () => {
  it("includes selectors, repo names, and paths in candidate text", () => {
    const candidate = buildSwitchCandidates([
      {
        type: "template-workspace",
        selector: "template/change",
        groupName: "template",
        changeName: "change",
        repos: ["front", "api"],
        repoSummary: "front, api",
        state: "ready",
        modifiedAt: "2026-01-01T00:00:00.000Z",
        modifiedAtMs: 1,
        path: "/tmp/workforest/Workspaces/template/change",
      },
    ])[0];

    expect(candidate).toMatchObject({
      label: "template/change",
      description: expect.stringContaining("front, api"),
    });
    expect(candidate?.description).toContain("/tmp/workforest");
  });
});

async function createSwitchFixture(): Promise<{
  baseDir: string;
  cdTargets: string[];
  writeShellCdPath: (targetDir: string) => Promise<void>;
}> {
  const configDir = await createTempDir("workforest-switch-config-");
  const baseDir = await createTempDir("workforest-switch-base-");
  process.env["WORKFOREST_CONFIG_DIR"] = configDir;
  await saveWorkspaceConfig(path.join(configDir, "config.json"), {
    directory: { base: baseDir },
  });

  const adhocWorkspace = path.join(baseDir, "Workspaces", "_adhoc", "auth-fix");
  const templateWorkspace = path.join(
    baseDir,
    "Workspaces",
    "vercel-agent",
    "auth-fix",
  );
  const repoChange = path.join(baseDir, "Repos", "workforest", "cli-redesign");

  await Promise.all([
    mkdir(path.join(adhocWorkspace, "front"), { recursive: true }),
    mkdir(path.join(adhocWorkspace, "api"), { recursive: true }),
    mkdir(path.join(templateWorkspace, "agents"), { recursive: true }),
    mkdir(path.join(templateWorkspace, "api"), { recursive: true }),
    mkdir(repoChange, { recursive: true }),
  ]);
  await writeFile(path.join(repoChange, "README.md"), "fixture\n", "utf8");
  await writeWorktreeMetadata(path.dirname(repoChange), {
    featureName: "cli-redesign",
    branchName: "tomdale/cli-redesign",
    repos: [
      metadataRepo("workforest", "git@github.com:tomdale/workforest.git"),
    ],
  });
  await writeWorkspaceMetadata(adhocWorkspace, {
    featureName: "auth-fix",
    branchName: "tomdale/auth-fix",
    repos: [
      metadataRepo("front", "git@github.com:vercel/front.git"),
      metadataRepo("api", "git@github.com:vercel/api.git"),
    ],
  });
  await writeWorkspaceMetadata(templateWorkspace, {
    featureName: "auth-fix",
    branchName: "tomdale/auth-fix",
    templateId: "vercel-agent",
    repos: [
      metadataRepo("agents", "git@github.com:vercel/agents.git"),
      metadataRepo("api", "git@github.com:vercel/api.git"),
    ],
  });

  const cdTargets: string[] = [];
  return {
    baseDir,
    cdTargets,
    writeShellCdPath: async (targetDir) => {
      cdTargets.push(targetDir);
    },
  };
}

async function pinSwitchFixtureMtimes(baseDir: string): Promise<void> {
  const now = (Date.now() / 1000 + 10 * 86_400) * 1000;
  const nowSec = now / 1000;
  await Promise.all([
    utimes(
      path.join(baseDir, "Workspaces", "_adhoc", "auth-fix"),
      nowSec - 60,
      nowSec - 60,
    ),
    utimes(
      path.join(baseDir, "Repos", "workforest", "cli-redesign"),
      nowSec - 300,
      nowSec - 300,
    ),
    utimes(
      path.join(baseDir, "Workspaces", "vercel-agent", "auth-fix"),
      nowSec - 600,
      nowSec - 600,
    ),
  ]);
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function invocation(beforeDoubleDash: readonly string[]): ParsedInvocation {
  return { beforeDoubleDash, flags: {} } as ParsedInvocation;
}

function metadataRepo(
  name: string,
  remote: string,
): {
  name: string;
  remote: string;
  hasLockfile: boolean;
} {
  return { name, remote, hasLockfile: false };
}

function renderResult(result: Awaited<ReturnType<typeof executeCli>>): {
  stdout: string;
  stderr: string;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  renderCommandResult(result, {
    stdout: (chunk: string) => stdout.push(chunk),
    stderr: (chunk: string) => stderr.push(chunk),
  });
  return {
    stdout: stripAnsi(stdout.join("")),
    stderr: stripAnsi(stderr.join("")),
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
