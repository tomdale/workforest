import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  writeRepositoryChangeMetadata,
  writeWorkspaceMetadata,
} from "./metadata.ts";
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

  it("reports ambiguous exact selectors when a workspace group and repository collide", async () => {
    const base = await createInventoryFixture();
    await mkdir(
      path.join(base, "Workspaces", "workforest", "cli-redesign", "front"),
      {
        recursive: true,
      },
    );
    await writeWorkspaceMetadata(
      path.join(base, "Workspaces", "workforest", "cli-redesign"),
      {
        featureName: "cli-redesign",
        branchName: "tomdale/cli-redesign",
        templateId: "workforest",
        repos: [metadataRepo("front", "git@github.com:vercel/front.git")],
      },
    );

    const resolution = await resolveChangeSelector(
      { directory: { base } },
      "workforest/cli-redesign",
    );

    expect(resolution).toMatchObject({
      kind: "ambiguous",
      selector: "workforest/cli-redesign",
      hint: "This selector maps to more than one path; run from the intended path or choose it in the interactive switcher.",
    });
    if (resolution.kind !== "ambiguous") return;
    expect(resolution.matches).toEqual(
      expect.arrayContaining([
        expect.stringContaining("repository-change"),
        expect.stringContaining("template-workspace"),
      ]),
    );
    expect(resolution.matches).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          path.join(base, "Repos", "workforest", "cli-redesign"),
        ),
        expect.stringContaining(
          path.join(base, "Workspaces", "workforest", "cli-redesign"),
        ),
      ]),
    );
  });

  it("reports duplicate selectors for bare change ambiguity", async () => {
    const base = await createInventoryFixture();
    await mkdir(
      path.join(base, "Workspaces", "workforest", "cli-redesign", "front"),
      {
        recursive: true,
      },
    );
    await writeWorkspaceMetadata(
      path.join(base, "Workspaces", "workforest", "cli-redesign"),
      {
        featureName: "cli-redesign",
        branchName: "tomdale/cli-redesign",
        templateId: "workforest",
        repos: [metadataRepo("front", "git@github.com:vercel/front.git")],
      },
    );

    const resolution = await resolveChangeSelector(
      { directory: { base } },
      "cli-redesign",
    );

    expect(resolution).toMatchObject({
      kind: "ambiguous",
      selector: "cli-redesign",
      hint: "This selector maps to more than one path; run from the intended path or choose it in the interactive switcher.",
    });
    if (resolution.kind !== "ambiguous") return;
    expect(resolution.matches).toHaveLength(2);
    expect(resolution.matches.join("\n")).toContain("repository-change");
    expect(resolution.matches.join("\n")).toContain("template-workspace");
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
    mkdir(path.join(base, "Workspaces", "_adhoc", "auth-fix", "front"), {
      recursive: true,
    }),
    mkdir(path.join(base, "Repos", "workforest", "cli-redesign"), {
      recursive: true,
    }),
  ]);
  await writeWorkspaceMetadata(
    path.join(base, "Workspaces", "vercel-agent", "auth-fix"),
    {
      featureName: "auth-fix",
      branchName: "tomdale/auth-fix",
      templateId: "vercel-agent",
      repos: [
        metadataRepo("agents", "git@github.com:vercel/agents.git"),
        metadataRepo("api", "git@github.com:vercel/api.git"),
      ],
    },
  );
  await writeWorkspaceMetadata(
    path.join(base, "Workspaces", "_adhoc", "auth-fix"),
    {
      featureName: "auth-fix",
      branchName: "tomdale/auth-fix",
      repos: [
        metadataRepo("front", "git@github.com:vercel/front.git"),
        metadataRepo("api", "git@github.com:vercel/api.git"),
      ],
    },
  );
  await writeRepositoryChangeMetadata(path.join(base, "Repos", "workforest"), {
    featureName: "cli-redesign",
    branchName: "tomdale/cli-redesign",
    repos: [
      metadataRepo("workforest", "git@github.com:tomdale/workforest.git"),
    ],
  });
  return base;
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function metadataRepo(
  name: string,
  remote: string,
): {
  name: string;
  remote: string;
  defaultBranch: string;
  hasLockfile: boolean;
} {
  return { name, remote, defaultBranch: "main", hasLockfile: false };
}
