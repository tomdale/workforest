import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyTemplateFiles } from "./apply.ts";
import { createTemplate, loadTemplate } from "./index.ts";

const ORIGINAL_XDG_CONFIG_HOME = process.env["XDG_CONFIG_HOME"];

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  if (ORIGINAL_XDG_CONFIG_HOME === undefined) {
    delete process.env["XDG_CONFIG_HOME"];
  } else {
    process.env["XDG_CONFIG_HOME"] = ORIGINAL_XDG_CONFIG_HOME;
  }

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("copyTemplateFiles", () => {
  it("copies defaults into the workspace tree", async () => {
    const xdgConfigHome = await createTempDir("workforest-templates-");
    const workspaceDir = await createTempDir("workforest-workspace-");
    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;

    await createTemplate("demo", {
      repos: ["vercel/front"],
    });

    const filesDir = path.join(
      xdgConfigHome,
      "workforest",
      "templates",
      "demo",
      "files",
    );
    await mkdir(path.join(filesDir, "front"), { recursive: true });
    await writeFile(path.join(filesDir, ".envrc"), "use workforest\n", "utf8");
    await writeFile(
      path.join(filesDir, "front", ".env.local"),
      "FEATURE_FLAG=1\n",
      "utf8",
    );

    const template = await loadTemplate("demo");
    expect(template).not.toBeNull();
    if (!template) {
      throw new Error("Expected template.");
    }

    await copyTemplateFiles(template, workspaceDir);

    expect(await readFile(path.join(workspaceDir, ".envrc"), "utf8")).toBe(
      "use workforest\n",
    );
    expect(
      await readFile(path.join(workspaceDir, "front", ".env.local"), "utf8"),
    ).toBe("FEATURE_FLAG=1\n");
  });

  it("fails when a copied file would overwrite an existing file", async () => {
    const xdgConfigHome = await createTempDir("workforest-templates-");
    const workspaceDir = await createTempDir("workforest-workspace-");
    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;

    await createTemplate("demo", {
      repos: ["vercel/front"],
    });

    const filesDir = path.join(
      xdgConfigHome,
      "workforest",
      "templates",
      "demo",
      "files",
    );
    await mkdir(filesDir, { recursive: true });
    await writeFile(path.join(filesDir, ".envrc"), "template\n", "utf8");
    await writeFile(path.join(workspaceDir, ".envrc"), "existing\n", "utf8");

    const template = await loadTemplate("demo");
    expect(template).not.toBeNull();
    if (!template) {
      throw new Error("Expected template.");
    }

    await expect(copyTemplateFiles(template, workspaceDir)).rejects.toThrow();
    expect(await readFile(path.join(workspaceDir, ".envrc"), "utf8")).toBe(
      "existing\n",
    );
  });
});
