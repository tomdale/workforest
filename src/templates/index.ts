import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import type { TemplateConfig } from "../types.ts";
import { normalizeBranchPrefix } from "../utils/branch-prefix.ts";
import { ensureDir, pathExists } from "../utils/fs.ts";

const XDG_TEMPLATES_DIR = "workforest/templates";
const TEMPLATE_FILENAME_JSONC = "template.jsonc";
const TEMPLATE_FILENAME_JSON = "template.json";

export type Template = {
  id: string;
  path: string;
  config: TemplateConfig;
};

export function getTemplatesDir(): string {
  const xdgHome =
    process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config");
  return path.join(xdgHome, XDG_TEMPLATES_DIR);
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

  // Try .jsonc first, then fall back to .json for backwards compatibility
  const jsoncPath = path.join(templateDir, TEMPLATE_FILENAME_JSONC);
  const jsonPath = path.join(templateDir, TEMPLATE_FILENAME_JSON);

  let templatePath: string;
  if (await pathExists(jsoncPath)) {
    templatePath = jsoncPath;
  } else if (await pathExists(jsonPath)) {
    templatePath = jsonPath;
  } else {
    return null;
  }

  try {
    const raw = await fs.readFile(templatePath, "utf8");
    const parsed: unknown = parseJsonc(raw);

    if (!isValidTemplateConfig(parsed)) {
      throw new Error(
        `Invalid template config at ${templatePath}: missing required fields`,
      );
    }

    return {
      id: templateId,
      path: templatePath,
      config: normalizeTemplateConfig(parsed),
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
  const templatePath = path.join(templateDir, TEMPLATE_FILENAME_JSONC);

  await ensureDir(templateDir);

  const contents = generateTemplateJsonc(normalizeTemplateConfig(config));
  await fs.writeFile(templatePath, contents, "utf8");

  // Remove old .json file if it exists (migration to .jsonc)
  const oldJsonPath = path.join(templateDir, TEMPLATE_FILENAME_JSON);
  if (await pathExists(oldJsonPath)) {
    await fs.unlink(oldJsonPath);
  }
}

function generateTemplateJsonc(config: TemplateConfig): string {
  const lines: string[] = ["{"];

  // repos (required)
  lines.push("  // Repositories to clone (required)");
  lines.push('  // Format: "org/repo" (GitHub shorthand) or full git URL');
  lines.push(
    `  "repos": ${JSON.stringify(config.repos, null, 2).replace(/\n/g, "\n  ")},`,
  );

  // description (optional)
  lines.push("");
  lines.push("  // Short description shown in template list (optional)");
  if (config.description) {
    lines.push(`  "description": ${JSON.stringify(config.description)},`);
  } else {
    lines.push('  // "description": "My workspace template",');
  }

  // branchPrefix (optional)
  lines.push("");
  lines.push('  // Prefix for branch names, e.g. "feature/" (optional)');
  if (config.branchPrefix) {
    lines.push(`  "branchPrefix": ${JSON.stringify(config.branchPrefix)},`);
  } else {
    lines.push('  // "branchPrefix": "feature/",');
  }

  // hooks (optional)
  lines.push("");
  lines.push("  // Hooks run after workspace setup (optional)");
  lines.push(
    "  // Each hook has: name (required), run (required), in (optional repo filter)",
  );
  if (config.hooks && config.hooks.length > 0) {
    lines.push(
      `  "hooks": ${JSON.stringify(config.hooks, null, 2).replace(/\n/g, "\n  ")},`,
    );
  } else {
    lines.push('  // "hooks": [');
    lines.push("  //   {");
    lines.push('  //     "name": "Build project",');
    lines.push('  //     "run": "pnpm build",');
    lines.push('  //     "in": "my-org/my-repo"  // Run only in this repo');
    lines.push("  //   }");
    lines.push("  // ],");
  }

  // disableInitializers (optional)
  lines.push("");
  lines.push("  // Disable automatic initializers (optional)");
  lines.push(
    '  // Set to true to disable all, or an array like ["vercel-link"] to disable specific ones',
  );
  lines.push(
    '  // Available: "pnpm-install", "yarn-install", "npm-install", "vercel-link", "turbo-link"',
  );
  if (config.disableInitializers !== undefined) {
    lines.push(
      `  "disableInitializers": ${JSON.stringify(config.disableInitializers)}`,
    );
  } else {
    lines.push('  // "disableInitializers": false');
  }

  lines.push("}");

  return `${lines.join("\n")}\n`;
}

function normalizeTemplateConfig(config: TemplateConfig): TemplateConfig {
  const { branchPrefix: _branchPrefix, ...rest } = config;
  const branchPrefix = normalizeBranchPrefix(config.branchPrefix);

  return branchPrefix === undefined
    ? rest
    : {
        ...rest,
        branchPrefix,
      };
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

  // repos is required and must be an array of strings
  if (!Array.isArray(config["repos"])) {
    return false;
  }
  for (const repo of config["repos"]) {
    if (typeof repo !== "string") {
      return false;
    }
  }

  // description is optional but must be a string if present
  if (
    config["description"] !== undefined &&
    typeof config["description"] !== "string"
  ) {
    return false;
  }

  // branchPrefix is optional but must be a string if present
  if (
    config["branchPrefix"] !== undefined &&
    typeof config["branchPrefix"] !== "string"
  ) {
    return false;
  }

  // hooks is optional but must be an array if present
  if (config["hooks"] !== undefined) {
    if (!Array.isArray(config["hooks"])) {
      return false;
    }

    for (const hook of config["hooks"]) {
      if (hook === null || typeof hook !== "object") {
        return false;
      }

      const hookObj = hook as Record<string, unknown>;

      // name is required
      if (typeof hookObj["name"] !== "string" || !hookObj["name"]) {
        return false;
      }

      // run is required (shell command string)
      if (typeof hookObj["run"] !== "string" || !hookObj["run"]) {
        return false;
      }

      // in is optional (repo name or array of repo names to run in)
      if (hookObj["in"] !== undefined) {
        if (typeof hookObj["in"] === "string") {
          // valid
        } else if (Array.isArray(hookObj["in"])) {
          for (const item of hookObj["in"]) {
            if (typeof item !== "string") {
              return false;
            }
          }
        } else {
          return false;
        }
      }

      // continueOnError is optional boolean
      if (
        hookObj["continueOnError"] !== undefined &&
        typeof hookObj["continueOnError"] !== "boolean"
      ) {
        return false;
      }

      // if is optional condition object
      if (hookObj["if"] !== undefined) {
        if (hookObj["if"] === null || typeof hookObj["if"] !== "object") {
          return false;
        }

        const condition = hookObj["if"] as Record<string, unknown>;

        if (
          condition["fileExists"] !== undefined &&
          typeof condition["fileExists"] !== "string"
        ) {
          return false;
        }
      }
    }
  }

  // disableInitializers is optional but must be a boolean or array of strings if present
  if (config["disableInitializers"] !== undefined) {
    const val = config["disableInitializers"];
    if (typeof val !== "boolean" && !Array.isArray(val)) {
      return false;
    }
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item !== "string") {
          return false;
        }
      }
    }
  }

  return true;
}
