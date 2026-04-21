import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createTemplate, loadTemplate } from "./index.ts";

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
  it("normalizes legacy branch prefixes when loading", async () => {
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

    expect(template?.config.branchPrefix).toBe("tomdale/");
  });

  it("persists normalized branch prefixes when creating templates", async () => {
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
    const contents = await readFile(templatePath, "utf8");

    expect(contents).toContain('"branchPrefix": "tomdale/"');
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
    const contents = await readFile(templatePath, "utf8");
    const template = await loadTemplate("demo");

    expect(contents).toContain('"branchPrefix": ""');
    expect(template?.config.branchPrefix).toBe("");
  });
});
