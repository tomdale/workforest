import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TemplateConfig } from "../types.ts";
import { ensureDir, pathExists } from "../utils/fs.ts";

const LEGACY_TEMPLATES_DIR = ".workforest/templates";
const XDG_TEMPLATES_DIR = "workforest/templates";
const TEMPLATE_FILENAME = "template.json";

export type Template = {
  id: string;
  config: TemplateConfig;
};

export function getTemplatesDir(): string {
  const homeDir = os.homedir();
  const xdgHome = process.env["XDG_CONFIG_HOME"];

  if (xdgHome) {
    return path.join(xdgHome, XDG_TEMPLATES_DIR);
  }

  return path.join(homeDir, LEGACY_TEMPLATES_DIR);
}

export async function listTemplates(): Promise<Template[]> {
  const templatesDir = getTemplatesDir();
  const exists = await pathExists(templatesDir);

  if (!exists) {
    return [];
  }

  const entries = await fs.readdir(templatesDir, { withFileTypes: true });
  const templates: Template[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const templateId = entry.name;
    const template = await loadTemplate(templateId);

    if (template) {
      templates.push(template);
    }
  }

  return templates.sort((a, b) => a.id.localeCompare(b.id));
}

export async function loadTemplate(
  templateId: string,
): Promise<Template | null> {
  const templatesDir = getTemplatesDir();
  const templateDir = path.join(templatesDir, templateId);
  const templatePath = path.join(templateDir, TEMPLATE_FILENAME);

  const exists = await pathExists(templatePath);
  if (!exists) {
    return null;
  }

  try {
    const raw = await fs.readFile(templatePath, "utf8");
    const parsed: unknown = JSON.parse(raw);

    if (!isValidTemplateConfig(parsed)) {
      throw new Error(
        `Invalid template config at ${templatePath}: missing required fields`,
      );
    }

    return {
      id: templateId,
      config: parsed,
    };
  } catch (error_) {
    if ((error_ as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error_;
  }
}

export async function createTemplate(
  templateId: string,
  config: TemplateConfig,
): Promise<void> {
  const templatesDir = getTemplatesDir();
  const templateDir = path.join(templatesDir, templateId);
  const templatePath = path.join(templateDir, TEMPLATE_FILENAME);

  await ensureDir(templateDir);

  const contents = JSON.stringify(config, null, 2);
  await fs.writeFile(templatePath, `${contents}\n`, "utf8");
}

export async function deleteTemplate(templateId: string): Promise<void> {
  const templatesDir = getTemplatesDir();
  const templateDir = path.join(templatesDir, templateId);

  const exists = await pathExists(templateDir);
  if (!exists) {
    return;
  }

  await fs.rm(templateDir, { recursive: true, force: true });
}

function isValidTemplateConfig(value: unknown): value is TemplateConfig {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const config = value as Record<string, unknown>;

  if (typeof config["name"] !== "string" || !config["name"]) {
    return false;
  }

  if (!Array.isArray(config["repos"])) {
    return false;
  }

  if (
    config["description"] !== undefined &&
    typeof config["description"] !== "string"
  ) {
    return false;
  }

  if (
    config["defaultBranch"] !== undefined &&
    typeof config["defaultBranch"] !== "string"
  ) {
    return false;
  }

  if (config["postInstallHooks"] !== undefined) {
    if (!Array.isArray(config["postInstallHooks"])) {
      return false;
    }

    for (const hook of config["postInstallHooks"]) {
      if (hook === null || typeof hook !== "object") {
        return false;
      }

      const hookObj = hook as Record<string, unknown>;

      if (typeof hookObj["name"] !== "string" || !hookObj["name"]) {
        return false;
      }

      if (typeof hookObj["command"] !== "string" || !hookObj["command"]) {
        return false;
      }

      if (!Array.isArray(hookObj["args"])) {
        return false;
      }

      for (const arg of hookObj["args"]) {
        if (typeof arg !== "string") {
          return false;
        }
      }

      if (hookObj["condition"] !== undefined) {
        if (
          hookObj["condition"] === null ||
          typeof hookObj["condition"] !== "object"
        ) {
          return false;
        }

        const condition = hookObj["condition"] as Record<string, unknown>;

        if (condition["fileExists"] !== undefined) {
          if (!Array.isArray(condition["fileExists"])) {
            return false;
          }

          for (const file of condition["fileExists"]) {
            if (typeof file !== "string") {
              return false;
            }
          }
        }
      }
    }
  }

  return true;
}
