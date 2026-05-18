import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cli } from "./cli.ts";
import { saveWorkspaceConfig } from "./config.ts";
import { WORKFOREST_CD_PATH_ENV } from "./shell.ts";
import { writeWorkspaceMetadata } from "./workspace/metadata.ts";

type PromptOption = {
  value: string;
  label: string;
  description?: string;
};

type PromptOptions = {
  options: PromptOption[];
};

const promptSelectMock = vi.hoisted(() =>
  vi.fn(async (_message: string, options: PromptOptions) => {
    return options.options[0]?.value;
  }),
);
const promptFuzzySelectMock = vi.hoisted(() =>
  vi.fn(async (_message: string, options: PromptOptions) => {
    return options.options[0]?.value;
  }),
);

vi.mock("./ui/prompts/index.ts", async () => {
  const actual = await vi.importActual<typeof import("./ui/prompts/index.ts")>(
    "./ui/prompts/index.ts",
  );

  return {
    ...actual,
    isInteractive: () => true,
    promptSelect: promptSelectMock,
    promptFuzzySelect: promptFuzzySelectMock,
  };
});

const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_CD_PATH_FILE = process.env[WORKFOREST_CD_PATH_ENV];
const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_EXIT_CODE = process.exitCode;

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.clearAllMocks();

  if (ORIGINAL_CONFIG_DIR === undefined) {
    delete process.env["WORKFOREST_CONFIG_DIR"];
  } else {
    process.env["WORKFOREST_CONFIG_DIR"] = ORIGINAL_CONFIG_DIR;
  }

  if (ORIGINAL_CD_PATH_FILE === undefined) {
    delete process.env[WORKFOREST_CD_PATH_ENV];
  } else {
    process.env[WORKFOREST_CD_PATH_ENV] = ORIGINAL_CD_PATH_FILE;
  }

  process.argv = [...ORIGINAL_ARGV];
  process.exitCode = ORIGINAL_EXIT_CODE;

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("workspace picker", () => {
  it("orders interactive wf cd choices by newest workspace modification", async () => {
    const configDir = await createTempDir("workforest-config-");
    const workspaceRoot = await createTempDir("workforest-root-");
    const cdDir = await createTempDir("workforest-cd-");
    const cdPathFile = path.join(cdDir, "target");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    process.env[WORKFOREST_CD_PATH_ENV] = cdPathFile;

    const olderWorkspace = await createWorkspace(workspaceRoot, "wf-older", [
      "front",
    ]);
    const newerWorkspace = await createWorkspace(workspaceRoot, "wf-newer", [
      "api",
    ]);

    await setTreeMtime(olderWorkspace, new Date("2024-01-01T00:00:00Z"));
    await setTreeMtime(newerWorkspace, new Date("2024-02-01T00:00:00Z"));

    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      defaultDir: workspaceRoot,
    });

    process.argv = ["node", "wf", "cd"];
    process.exitCode = undefined;

    await cli();

    expect(promptSelectMock).toHaveBeenCalledOnce();
    const options = promptSelectMock.mock.calls[0]?.[1].options ?? [];
    expect(options.map((option) => option.label)).toEqual([
      "wf-newer",
      "wf-older",
    ]);
    await expect(readFile(cdPathFile, "utf8")).resolves.toBe(
      `${path.resolve(newerWorkspace)}\n`,
    );
  });

  it("shows repo names, template id, and modified time in picker hints", async () => {
    const configDir = await createTempDir("workforest-config-");
    const workspaceRoot = await createTempDir("workforest-root-");
    const cdDir = await createTempDir("workforest-cd-");
    const cdPathFile = path.join(cdDir, "target");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    process.env[WORKFOREST_CD_PATH_ENV] = cdPathFile;

    await createWorkspace(workspaceRoot, "wf-template", ["front", "api"], {
      templateId: "nextjs-app",
    });

    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      defaultDir: workspaceRoot,
    });

    process.argv = ["node", "wf", "find"];
    process.exitCode = undefined;

    await cli();

    expect(promptFuzzySelectMock).toHaveBeenCalledOnce();
    const option = promptFuzzySelectMock.mock.calls[0]?.[1].options[0];
    expect(option?.description).toContain("front, api");
    expect(option?.description).toContain("template: nextjs-app");
    expect(option?.description).toContain("modified ");
  });

  it("keeps discovering workspaces when a metadata repo directory is missing", async () => {
    const configDir = await createTempDir("workforest-config-");
    const workspaceRoot = await createTempDir("workforest-root-");
    const cdDir = await createTempDir("workforest-cd-");
    const cdPathFile = path.join(cdDir, "target");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    process.env[WORKFOREST_CD_PATH_ENV] = cdPathFile;

    const workspaceDir = await createWorkspace(
      workspaceRoot,
      "wf-missing-repo",
      ["front", "api"],
      { createRepoDirs: false },
    );

    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      defaultDir: workspaceRoot,
    });

    process.argv = ["node", "wf", "find"];
    process.exitCode = undefined;

    await cli();

    expect(promptFuzzySelectMock).toHaveBeenCalledOnce();
    const options = promptFuzzySelectMock.mock.calls[0]?.[1].options ?? [];
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      label: "wf-missing-repo",
      value: path.resolve(workspaceDir),
    });
  });
});

async function createWorkspace(
  workspaceRoot: string,
  name: string,
  repos: string[],
  options: { templateId?: string; createRepoDirs?: boolean } = {},
): Promise<string> {
  const workspaceDir = path.join(workspaceRoot, name);
  await mkdir(workspaceDir, { recursive: true });

  if (options.createRepoDirs !== false) {
    await Promise.all(
      repos.map((repo) =>
        mkdir(path.join(workspaceDir, repo), { recursive: true }),
      ),
    );
  }

  await writeWorkspaceMetadata(workspaceDir, {
    featureName: name,
    branchName: `tomdale/${name}`,
    repos: repos.map((repo) => ({
      name: repo,
      remote: `git@github.com:vercel/${repo}.git`,
      defaultBranch: "main",
      hasLockfile: true,
    })),
    ...(options.templateId ? { templateId: options.templateId } : {}),
  });

  return workspaceDir;
}

async function setTreeMtime(workspaceDir: string, date: Date): Promise<void> {
  const metadataPath = path.join(workspaceDir, ".workforest", "workspace.json");
  const entries = await readdir(workspaceDir);
  await utimes(workspaceDir, date, date);
  await utimes(metadataPath, date, date);
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(workspaceDir, entry);
      if ((await stat(entryPath)).isDirectory()) {
        await utimes(entryPath, date, date);
      }
    }),
  );
}
