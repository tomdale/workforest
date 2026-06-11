import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyTemplateGenerator, copyTemplateFiles } from "./apply.ts";
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

describe("template hooks", () => {
  it("rejects a hook cwd symlink that redirects outside the workspace", async () => {
    const xdgConfigHome = await createTempDir("workforest-templates-");
    const workspaceDir = await createTempDir("workforest-workspace-");
    const outsideDir = await createTempDir("workforest-outside-");
    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;

    await createTemplate("demo", {
      repos: ["vercel/front"],
      hooks: [{ name: "unsafe", run: "touch escaped", in: "front" }],
    });
    await symlink(outsideDir, path.join(workspaceDir, "front"));
    const template = await loadTemplate("demo");
    if (!template) throw new Error("Expected template.");

    await expect(
      drain(
        applyTemplateGenerator({
          template,
          workspaceDir,
          repoDirs: [],
        }),
      ),
    ).rejects.toThrow("symbolic link");
    await expect(
      readFile(path.join(outsideDir, "escaped"), "utf8"),
    ).rejects.toThrow();
  });

  it("rejects a fileExists symlink that redirects outside the workspace", async () => {
    const xdgConfigHome = await createTempDir("workforest-templates-");
    const workspaceDir = await createTempDir("workforest-workspace-");
    const outsideDir = await createTempDir("workforest-outside-");
    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;

    await createTemplate("demo", {
      repos: ["vercel/front"],
      hooks: [
        {
          name: "unsafe",
          run: "touch ran",
          in: "front",
          if: { fileExists: "condition" },
        },
      ],
    });
    await mkdir(path.join(workspaceDir, "front"));
    const outsideFile = path.join(outsideDir, "condition");
    await writeFile(outsideFile, "present\n", "utf8");
    await symlink(outsideFile, path.join(workspaceDir, "front", "condition"));
    const template = await loadTemplate("demo");
    if (!template) throw new Error("Expected template.");

    await expect(
      drain(
        applyTemplateGenerator({
          template,
          workspaceDir,
          repoDirs: [],
        }),
      ),
    ).rejects.toThrow("symbolic link");
    await expect(
      readFile(path.join(workspaceDir, "front", "ran"), "utf8"),
    ).rejects.toThrow();
  });
});

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _value of iterable) {
    // Consume all generator states.
  }
}

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

  it("rejects destination symlinks that redirect outside the workspace", async () => {
    const xdgConfigHome = await createTempDir("workforest-templates-");
    const workspaceDir = await createTempDir("workforest-workspace-");
    const outsideDir = await createTempDir("workforest-outside-");
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
    await writeFile(
      path.join(filesDir, "front", ".env.local"),
      "FEATURE_FLAG=1\n",
      "utf8",
    );
    await symlink(outsideDir, path.join(workspaceDir, "front"));

    const template = await loadTemplate("demo");
    if (!template) throw new Error("Expected template.");

    await expect(copyTemplateFiles(template, workspaceDir)).rejects.toThrow(
      "symbolic link",
    );
    await expect(
      readFile(path.join(outsideDir, ".env.local"), "utf8"),
    ).rejects.toThrow();
  });

  it("rejects symlinks in template source files", async () => {
    const xdgConfigHome = await createTempDir("workforest-templates-");
    const workspaceDir = await createTempDir("workforest-workspace-");
    const outsideDir = await createTempDir("workforest-outside-");
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
    const outsideFile = path.join(outsideDir, "secret.txt");
    await writeFile(outsideFile, "secret\n", "utf8");
    await symlink(outsideFile, path.join(filesDir, "secret.txt"));

    const template = await loadTemplate("demo");
    if (!template) throw new Error("Expected template.");

    await expect(copyTemplateFiles(template, workspaceDir)).rejects.toThrow(
      "must not contain symlinks",
    );
    await expect(
      readFile(path.join(workspaceDir, "secret.txt"), "utf8"),
    ).rejects.toThrow();
  });

  it("rejects a symlinked template source directory", async () => {
    const xdgConfigHome = await createTempDir("workforest-templates-");
    const workspaceDir = await createTempDir("workforest-workspace-");
    const outsideDir = await createTempDir("workforest-outside-");
    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;

    await createTemplate("demo", {
      repos: ["vercel/front"],
    });
    const template = await loadTemplate("demo");
    if (!template) throw new Error("Expected template.");

    const templateDir = path.dirname(template.path);
    const displacedTemplateDir = path.join(outsideDir, "original");
    await rename(templateDir, displacedTemplateDir);
    await mkdir(path.join(outsideDir, "files"));
    await writeFile(
      path.join(outsideDir, "files", "secret.txt"),
      "secret\n",
      "utf8",
    );
    await symlink(outsideDir, templateDir);

    await expect(copyTemplateFiles(template, workspaceDir)).rejects.toThrow(
      "symbolic link",
    );
    await expect(
      readFile(path.join(workspaceDir, "secret.txt"), "utf8"),
    ).rejects.toThrow();
  });
});
