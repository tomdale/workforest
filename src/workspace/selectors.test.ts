import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveChangeSelector } from "./selectors.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("resolveChangeSelector", () => {
  it("resolves exact group/change selectors", async () => {
    const base = await createInventoryFixture();

    await expect(
      resolveChangeSelector({ directory: { base } }, "vercel-agent/auth-fix"),
    ).resolves.toMatchObject({
      kind: "resolved",
      entry: {
        selector: "vercel-agent/auth-fix",
        type: "template-workspace",
      },
    });
  });

  it("resolves bare change names only when unique", async () => {
    const base = await createInventoryFixture();

    await expect(
      resolveChangeSelector({ directory: { base } }, "cli-redesign"),
    ).resolves.toMatchObject({
      kind: "resolved",
      entry: {
        selector: "workforest/cli-redesign",
        type: "repository-change",
      },
    });
  });

  it("reports ambiguous bare change names with matching selectors", async () => {
    const base = await createInventoryFixture();

    await expect(
      resolveChangeSelector({ directory: { base } }, "auth-fix"),
    ).resolves.toEqual({
      kind: "ambiguous",
      selector: "auth-fix",
      matches: ["_adhoc/auth-fix", "vercel-agent/auth-fix"],
    });
  });

  it("resolves the current directory inside a managed change", async () => {
    const base = await createInventoryFixture();
    const cwd = path.join(
      base,
      "Workspaces",
      "vercel-agent",
      "auth-fix",
      "agents",
      "src",
    );
    await mkdir(cwd, { recursive: true });

    await expect(
      resolveChangeSelector({ directory: { base } }, undefined, cwd),
    ).resolves.toMatchObject({
      kind: "resolved",
      entry: {
        selector: "vercel-agent/auth-fix",
      },
    });
  });

  it("treats managed roots without a change as outside a Workforest change", async () => {
    const base = await createInventoryFixture();
    const reposRoot = path.join(base, "Repos");

    await expect(
      resolveChangeSelector({ directory: { base } }, undefined, reposRoot),
    ).resolves.toEqual({ kind: "outside" });
  });
});

async function createInventoryFixture(): Promise<string> {
  const base = await createTempDir("workforest-selector-base-");
  await Promise.all([
    mkdir(path.join(base, "Workspaces", "vercel-agent", "auth-fix", "agents"), {
      recursive: true,
    }),
    mkdir(path.join(base, "Workspaces", "_adhoc", "auth-fix", "api"), {
      recursive: true,
    }),
    mkdir(path.join(base, "Repos", "workforest", "cli-redesign"), {
      recursive: true,
    }),
  ]);
  return base;
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
