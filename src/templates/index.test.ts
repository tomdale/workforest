import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTemplate,
  createTemplateVariant,
  deleteTemplate,
  formatTemplateIdentifier,
  listTemplates,
  loadTemplate,
  parseTemplateIdentifier,
  validateTemplateIdentifier,
} from "./index.ts";

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
  it("parses and formats canonical template variant identifiers", () => {
    expect(parseTemplateIdentifier("vercel-agent+chat")).toEqual({
      parent: "vercel-agent",
      variant: "chat",
    });
    expect(
      formatTemplateIdentifier({ parent: "vercel-agent", variant: "chat" }),
    ).toBe("vercel-agent+chat");
    expect(validateTemplateIdentifier("vercel-agent")).toBe("vercel-agent");
    expect(validateTemplateIdentifier("vercel-agent+chat")).toBe(
      "vercel-agent+chat",
    );

    for (const invalid of [
      "vercel-agent+chat+extra",
      "vercel-agent+",
      "+chat",
      "vercel-agent/chat",
    ]) {
      expect(() => validateTemplateIdentifier(invalid)).toThrow();
    }
  });

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

  it("loads legacy template.json configs when template.jsonc is absent", async () => {
    const configHome = await createTemplatesHome();
    const templatePath = path.join(
      configHome,
      "workforest",
      "templates",
      "demo",
      "template.json",
    );

    await mkdir(path.dirname(templatePath), { recursive: true });
    await writeFile(
      templatePath,
      JSON.stringify({
        repos: ["vercel/front"],
        description: "Legacy template",
      }),
      "utf8",
    );

    const template = await loadTemplate("demo");

    expect(template).toMatchObject({
      id: "demo",
      path: templatePath,
      config: {
        repos: ["vercel/front"],
        description: "Legacy template",
      },
    });
  });

  it("prefers template.jsonc when both template config files exist", async () => {
    const configHome = await createTemplatesHome();
    const templateDir = path.join(
      configHome,
      "workforest",
      "templates",
      "demo",
    );

    await mkdir(templateDir, { recursive: true });
    await writeFile(
      path.join(templateDir, "template.json"),
      JSON.stringify({ repos: ["vercel/api"], description: "Legacy" }),
      "utf8",
    );
    await writeFile(
      path.join(templateDir, "template.jsonc"),
      JSON.stringify({ repos: ["vercel/front"], description: "Canonical" }),
      "utf8",
    );

    const template = await loadTemplate("demo");

    expect(template).toMatchObject({
      path: path.join(templateDir, "template.jsonc"),
      config: {
        repos: ["vercel/front"],
        description: "Canonical",
      },
    });
  });

  it("continues creating templates as template.jsonc", async () => {
    const configHome = await createTemplatesHome();

    await createTemplate("demo", { repos: ["vercel/front"] });

    const templateDir = path.join(
      configHome,
      "workforest",
      "templates",
      "demo",
    );
    await expect(
      readFile(path.join(templateDir, "template.jsonc"), "utf8"),
    ).resolves.toContain('"repos"');
    await expect(
      readFile(path.join(templateDir, "template.json"), "utf8"),
    ).rejects.toThrow();
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

  it("loads variants as effective merged templates", async () => {
    await createTemplatesHome();
    await createTemplate("vercel-agent", {
      repos: ["vercel/front", "vercel/api"],
      description: "Parent template",
      branchPrefix: "tomdale/",
      disableInitializers: ["pnpm-install", "vercel-link"],
      hooks: [
        { name: "parent", run: "pnpm install", in: "front" },
        { name: "other", run: "pnpm test", in: "api" },
      ],
      "AGENTS.md": {
        focus: "Parent workflow",
        paths: { front: ["app"], api: ["src"] },
        maxAgeHours: 12,
      },
    });
    await createTemplateVariant("vercel-agent", "chat", {
      description: "Chat workflow",
      branchPrefix: null,
      hooks: [{ name: "chat", run: "pnpm chat", in: "front" }],
      disableInitializers: ["pnpm-install"],
      "AGENTS.md": {
        focus: "Chat workflow",
        paths: { api: null, front: ["app/chat"] },
      },
    });

    const template = await loadTemplate("vercel-agent+chat");

    expect(template).toMatchObject({
      id: "vercel-agent+chat",
      parentId: "vercel-agent",
      variantId: "chat",
    });
    expect(template?.config).toEqual({
      repos: ["vercel/front", "vercel/api"],
      description: "Chat workflow",
      disableInitializers: ["pnpm-install"],
      hooks: [{ name: "chat", run: "pnpm chat", in: "front" }],
      "AGENTS.md": {
        focus: "Chat workflow",
        paths: { front: ["app/chat"] },
        maxAgeHours: 12,
      },
    });
  });

  it("loads legacy template.json variant configs when template.jsonc is absent", async () => {
    const configHome = await createTemplatesHome();
    await createTemplate("vercel-agent", {
      repos: ["vercel/front"],
      description: "Parent template",
    });
    const variantPath = path.join(
      configHome,
      "workforest",
      "templates",
      "vercel-agent",
      "variants",
      "chat",
      "template.json",
    );
    await mkdir(path.dirname(variantPath), { recursive: true });
    await writeFile(
      variantPath,
      JSON.stringify({ description: "Legacy variant" }),
      "utf8",
    );

    const template = await loadTemplate("vercel-agent+chat");

    expect(template).toMatchObject({
      id: "vercel-agent+chat",
      path: variantPath,
      config: {
        repos: ["vercel/front"],
        description: "Legacy variant",
      },
    });
  });

  it("lists parent templates and variants by canonical id", async () => {
    await createTemplatesHome();
    await createTemplate("vercel-agent", { repos: ["vercel/front"] });
    await createTemplateVariant("vercel-agent", "chat");

    await expect(listTemplates()).resolves.toMatchObject([
      { id: "vercel-agent" },
      { id: "vercel-agent+chat" },
    ]);
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
