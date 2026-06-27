import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, describe, expect, it } from "vitest";
import { createTemplate, deleteTemplate, loadTemplate } from "./index.ts";

const ORIGINAL_XDG_CONFIG_HOME = process.env["XDG_CONFIG_HOME"];

const tempDirs: string[] = [];

async function createTemplatesHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workforest-templates-"));
  tempDirs.push(dir);
  process.env["XDG_CONFIG_HOME"] = dir;
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

describe("templates", () => {
  it("preserves branch prefixes when loading", async () => {
    const configHome = await createTemplatesHome();
    const templatePath = path.join(
      configHome,
      "workforest",
      "templates",
      "demo",
      "template.jsonc",
    );

    await mkdir(path.dirname(templatePath), { recursive: true });
    await writeFile(
      templatePath,
      JSON.stringify({
        repos: ["vercel/front"],
        branchPrefix: "tomdale",
      }),
      "utf8",
    );

    const template = await loadTemplate("demo");

    expect(template?.config.branchPrefix).toBe("tomdale");
  });

  it("persists branch prefixes when creating templates", async () => {
    const configHome = await createTemplatesHome();

    await createTemplate("demo", {
      repos: ["vercel/front"],
      branchPrefix: "tomdale",
    });

    const templatePath = path.join(
      configHome,
      "workforest",
      "templates",
      "demo",
      "template.jsonc",
    );
    const templateConfig = parseJsonc(await readFile(templatePath, "utf8"));

    expect(templateConfig).toMatchObject({ branchPrefix: "tomdale" });
  });

  it("preserves an explicit empty override when creating templates", async () => {
    const configHome = await createTemplatesHome();

    await createTemplate("demo", {
      repos: ["vercel/front"],
      branchPrefix: "",
    });

    const templatePath = path.join(
      configHome,
      "workforest",
      "templates",
      "demo",
      "template.jsonc",
    );
    const templateConfig = parseJsonc(await readFile(templatePath, "utf8"));
    const template = await loadTemplate("demo");

    expect(templateConfig).toMatchObject({ branchPrefix: "" });
    expect(template?.config.branchPrefix).toBe("");
  });

  it("round-trips AGENTS.md generation configuration with a default TTL", async () => {
    const configHome = await createTemplatesHome();
    await createTemplate("demo", {
      repos: ["vercel/front", "vercel/api"],
      "AGENTS.md": {
        focus: "  How settings flow through the API.  ",
        paths: { front: ["app/settings"], api: ["services/settings"] },
      },
    });

    const template = await loadTemplate("demo");
    const templateDir = path.join(
      configHome,
      "workforest",
      "templates",
      "demo",
    );
    expect(template?.config["AGENTS.md"]).toEqual({
      focus: "How settings flow through the API.",
      paths: { front: ["app/settings"], api: ["services/settings"] },
      maxAgeHours: 24,
    });
    await expect(
      readFile(path.join(templateDir, "AGENTS.md"), "utf8"),
    ).rejects.toThrow();
  });

  it.each([
    { focus: "" },
    { focus: "workflow", maxAgeHours: 0 },
    { focus: "workflow", maxAgeHours: 1.5 },
    { focus: "workflow", paths: { unknown: ["src"] } },
    { focus: "workflow", paths: { front: ["../outside"] } },
  ])("rejects invalid AGENTS.md configuration %j", async (agents) => {
    const configHome = await createTemplatesHome();
    const templatePath = path.join(
      configHome,
      "workforest",
      "templates",
      "demo",
      "template.jsonc",
    );
    await mkdir(path.dirname(templatePath), { recursive: true });
    await writeFile(
      templatePath,
      JSON.stringify({ repos: ["vercel/front"], "AGENTS.md": agents }),
      "utf8",
    );
    await expect(loadTemplate("demo")).rejects.toThrow();
  });

  it.each([
    ".",
    "..",
    "../outside",
    "..\\outside",
    "/absolute",
    "C:\\tmp",
  ])("rejects unsafe template names %j", async (templateId) => {
    await createTemplatesHome();

    await expect(loadTemplate(templateId)).rejects.toThrow();
    await expect(
      createTemplate(templateId, { repos: ["vercel/front"] }),
    ).rejects.toThrow();
    await expect(deleteTemplate(templateId)).rejects.toThrow();
  });

  it("does not delete outside the templates root", async () => {
    const configHome = await createTemplatesHome();
    const sentinel = path.join(configHome, "sentinel.txt");
    await writeFile(sentinel, "keep\n", "utf8");

    await expect(deleteTemplate("../../sentinel.txt")).rejects.toThrow();

    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep\n");
  });

  it.each([
    { in: "../outside" },
    { in: "owner/repo" },
    { if: { fileExists: "../outside" } },
    { if: { fileExists: "C:\\outside" } },
  ])("rejects escaping template hook paths %j", async (hook) => {
    await createTemplatesHome();

    await expect(
      createTemplate("demo", {
        repos: ["vercel/front"],
        hooks: [{ name: "unsafe", run: "true", ...hook }],
      }),
    ).rejects.toThrow();
  });
});
