import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSubprocess } from "./test-utils/subprocess.ts";

type CommandContractEntry = {
  name: string;
  summary: string;
};

type PublishedContract = {
  version: string;
  bins: string[];
  rootCommands: CommandContractEntry[];
  removedRootCommands: string[];
  templateSubcommands: Record<string, string[]>;
  worktreeSubcommands: string[];
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("final command contract", () => {
  it("records the complete public root command surface", async () => {
    const contract = await loadPublishedContract();

    expect(contract.rootCommands.map(({ name }) => name)).toEqual([
      "dashboard",
      "start",
      "add",
      "switch",
      "list",
      "status",
      "finish",
      "delete",
      "migrate",
      "task",
      "cache",
      "worktree",
      "review",
      "template",
      "shell",
      "config",
      "skills",
      "help",
      "version",
    ]);
    expect(contract.removedRootCommands).toEqual(["new", "clean", "workspace"]);
    expect(contract.worktreeSubcommands).toEqual([
      "list",
      "add",
      "move",
      "remove",
    ]);
  });

  it("keeps both executable names", async () => {
    const contract = await loadPublishedContract();
    const packageJson = JSON.parse(
      await readFile(path.resolve("package.json"), "utf8"),
    ) as { bin?: Record<string, string> };

    expect(Object.keys(packageJson.bin ?? {}).sort()).toEqual(
      [...contract.bins].sort(),
    );
  });

  it("keeps every public root command invocable and rejects removed roots", async () => {
    const contract = await loadPublishedContract();
    const configDir = await mkdtemp(
      path.join(os.tmpdir(), "workforest-published-contract-"),
    );
    tempDirs.push(configDir);

    for (const command of contract.rootCommands) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NO_COLOR: "1",
        WORKFOREST_USE_SOURCE_CLI: "1",
        WORKFOREST_CONFIG_DIR: configDir,
        XDG_CONFIG_HOME: configDir,
      };

      const result = await runSubprocess(
        process.execPath,
        [path.resolve("bin/workforest.js"), command.name, "--help"],
        { env },
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain(`Usage: wf ${command.name}`);
    }

    for (const command of contract.removedRootCommands) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NO_COLOR: "1",
        WORKFOREST_USE_SOURCE_CLI: "1",
        WORKFOREST_CONFIG_DIR: configDir,
        XDG_CONFIG_HOME: configDir,
      };

      const result = await runSubprocess(
        process.execPath,
        [path.resolve("bin/workforest.js"), command, "--help"],
        { env },
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(`Unknown command: ${command}`);
    }
  }, 15_000);
});

async function loadPublishedContract(): Promise<PublishedContract> {
  return JSON.parse(
    await readFile(
      path.resolve("src/test-fixtures/workforest-0.0.1-command-contract.json"),
      "utf8",
    ),
  ) as PublishedContract;
}
