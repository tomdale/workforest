import { describe, expect, it } from "vitest";
import { commandRegistry } from "../cli/commands.ts";
import type { InventoryEntry } from "../workspace/inventory.ts";
import {
  selectorCandidateWords,
  shellCompletionCandidates,
} from "./candidates.ts";

describe("shell completion candidates", () => {
  it("completes visible root commands and hides internal commands", async () => {
    await expect(complete(0, ["s"])).resolves.toEqual([
      "shell",
      "skills",
      "status",
      "switch",
    ]);
    await expect(complete(0, ["_"])).resolves.toEqual([]);
  });

  it("walks nested command groups from the registry", async () => {
    await expect(complete(2, ["cache", "worktree", ""])).resolves.toEqual([
      "add",
      "list",
      "move",
      "remove",
    ]);
    await expect(complete(2, ["template", "agents-md", ""])).resolves.toEqual([
      "refresh",
      "status",
    ]);
  });

  it("completes selector operands for worktrees and workspaces", async () => {
    await expect(
      complete(1, ["status", ""], ["cli-redesign", "workforest/cli-redesign"]),
    ).resolves.toEqual(
      expect.arrayContaining([
        "--json",
        "--wait",
        "--watch",
        "cli-redesign",
        "workforest/cli-redesign",
      ]),
    );
  });

  it("does not complete selector operands while a string flag value is expected", async () => {
    await expect(
      complete(2, ["status", "--timeout", ""], ["workforest/cli-redesign"]),
    ).resolves.toEqual([]);
  });

  it("keeps selector words aligned with selector resolution rules", () => {
    expect(selectorCandidateWords(selectorEntries())).toEqual([
      "_adhoc/auth-fix",
      "cli-redesign",
      "vercel-agent/auth-fix",
      "workforest/cli-redesign",
    ]);
  });
});

function complete(
  cursorIndex: number,
  words: readonly string[],
  selectors: readonly string[] = [],
) {
  return shellCompletionCandidates(commandRegistry, cursorIndex, words, {
    selectorCandidates: async () => selectors,
  });
}

function selectorEntries(): readonly InventoryEntry[] {
  return [
    {
      type: "template-workspace",
      selector: "vercel-agent/auth-fix",
      groupName: "vercel-agent",
      changeName: "auth-fix",
      repos: ["web"],
      repoSummary: "web",
      state: "ready",
      modifiedAt: "2026-01-01T00:00:00.000Z",
      modifiedAtMs: 1,
      path: "/tmp/workspaces/vercel-agent/auth-fix",
    },
    {
      type: "adhoc-workspace",
      selector: "_adhoc/auth-fix",
      groupName: "_adhoc",
      changeName: "auth-fix",
      repos: ["api"],
      repoSummary: "api",
      state: "ready",
      modifiedAt: "2026-01-01T00:00:00.000Z",
      modifiedAtMs: 2,
      path: "/tmp/workspaces/_adhoc/auth-fix",
    },
    {
      type: "worktree",
      selector: "workforest/cli-redesign",
      groupName: "workforest",
      changeName: "cli-redesign",
      repository: "workforest",
      state: "ready",
      modifiedAt: "2026-01-01T00:00:00.000Z",
      modifiedAtMs: 3,
      path: "/tmp/repos/workforest/cli-redesign",
    },
  ];
}
