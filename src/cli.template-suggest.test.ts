import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderCommandResult } from "./cli/output.ts";

const promptMultiSelectMock = vi.hoisted(() => vi.fn());
const promptConfirmMock = vi.hoisted(() => vi.fn());

vi.mock("./ui/prompts/index.ts", async () => {
  const actual = await vi.importActual<typeof import("./ui/prompts/index.ts")>(
    "./ui/prompts/index.ts",
  );

  return {
    ...actual,
    promptConfirm: promptConfirmMock,
    promptMultiSelect: promptMultiSelectMock,
  };
});

import { runTemplateSuggestCommand } from "./cli/template-suggest.ts";
import { executeCli } from "./cli.ts";
import { loadTemplate } from "./templates/index.ts";

const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_CACHE_DIR = process.env["WORKFOREST_CACHE_DIR"];
const ORIGINAL_XDG_CONFIG_HOME = process.env["XDG_CONFIG_HOME"];
const ORIGINAL_PATH = process.env["PATH"];
const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;
const ORIGINAL_CWD = process.cwd();

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  promptMultiSelectMock.mockReset();
  promptConfirmMock.mockReset();
  restoreEnv("WORKFOREST_CONFIG_DIR", ORIGINAL_CONFIG_DIR);
  restoreEnv("WORKFOREST_CACHE_DIR", ORIGINAL_CACHE_DIR);
  restoreEnv("XDG_CONFIG_HOME", ORIGINAL_XDG_CONFIG_HOME);
  restoreEnv("PATH", ORIGINAL_PATH);
  process.chdir(ORIGINAL_CWD);
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: ORIGINAL_STDIN_IS_TTY,
  });
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("wf template suggest", () => {
  it("rejects non-interactive terminals", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });

    const output = render(await executeCli(["template", "suggest"]));

    expect(output.exitCode).toBe(1);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain(
      "Template suggestions require an interactive terminal.",
    );
  });

  it("saves selected AI template suggestions after confirmation", async () => {
    const root = await createTempDir("workforest-template-suggest-cli-");
    const configDir = path.join(root, "config");
    const cacheDir = path.join(root, "cache");
    const logDir = path.join(root, ".workforest", "ai", "template-suggest");
    await Promise.all([
      mkdir(configDir),
      mkdir(cacheDir),
      mkdir(logDir, { recursive: true }),
    ]);

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    process.env["XDG_CONFIG_HOME"] = configDir;
    process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
    process.chdir(root);
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    promptMultiSelectMock.mockResolvedValue(["agent-workflow"]);
    promptConfirmMock.mockResolvedValue(true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const output = render(
      await runTemplateSuggestCommand({
        interactive: true,
        suggest: async () => ({
          logDir,
          suggestions: [
            {
              id: "agent-workflow",
              description: "Cross-repo agent workflow changes.",
              repos: ["vercel/agents", "vercel/front"],
              confidence: 0.82,
              evidenceNotes: ["Recent PRs touched both repositories."],
            },
            {
              id: "docs-workflow",
              description: "Documentation-only workflow changes.",
              repos: ["vercel/docs"],
              confidence: 0.71,
              evidenceNotes: ["Recent PRs touched docs."],
            },
          ],
          evidence: {
            generatedAt: "2026-06-25T12:00:00.000Z",
            githubUser: "tomdale",
            lookbackDays: 180,
            since: "2025-12-27",
            existingTemplates: [],
            cachedRepositories: [],
            pullRequests: [],
            summary: {
              existingTemplateCount: 0,
              cachedRepositoryCount: 0,
              pullRequestCount: 0,
              repositoriesSeenInPullRequests: [],
            },
          },
        }),
      }),
    );

    expect(output.exitCode).toBe(0);
    await expect(loadTemplate("agent-workflow")).resolves.toMatchObject({
      config: {
        repos: ["vercel/agents", "vercel/front"],
        description: "Cross-repo agent workflow changes.",
      },
    });
    await expect(loadTemplate("docs-workflow")).resolves.toBeNull();
    expect(promptMultiSelectMock).toHaveBeenCalledOnce();
    expect(promptConfirmMock).toHaveBeenCalledOnce();
  });
});

function render(result: Awaited<ReturnType<typeof executeCli>>): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const output = { exitCode: result.exitCode, stdout: "", stderr: "" };
  renderCommandResult(result, {
    stdout: (value) => {
      output.stdout += value;
    },
    stderr: (value) => {
      output.stderr += value;
    },
  });
  return output;
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
