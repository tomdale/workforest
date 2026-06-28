import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathExists } from "@wf-plugin/core";
import { parse as parseJsonc } from "jsonc-parser";
import {
  readEnvironmentVariable,
  STANDARD_ENVIRONMENT_VARIABLES,
  WORKFOREST_ENVIRONMENT_VARIABLES,
} from "../environment.ts";
import { validateRepositoryComponent } from "../repository-components.ts";
import type { TemplateConfig, TemplateConfigOverride } from "../types.ts";
import { ensureDir } from "../utils/fs.ts";
import {
  resolveContainedPath,
  validateResourceName,
} from "../utils/path-safety.ts";
import { isSlug } from "../utils/slug.ts";

const XDG_TEMPLATES_DIR = "workforest/templates";
const TEMPLATE_FILENAME_JSONC = "template.jsonc";
const TEMPLATE_FILENAME_JSON = "template.json";
const VARIANTS_DIR = "variants";

export type Template = {
  id: string;
  path: string;
  directory: string;
  parentId: string;
  variantId?: string;
  parentPath?: string;
  config: TemplateConfig;
};

export type TemplateIdentifier = Readonly<{
  parent: string;
  variant?: string | undefined;
}>;

export function getTemplatesDir(): string {
  const configDir = readEnvironmentVariable(
    WORKFOREST_ENVIRONMENT_VARIABLES.configDir,
  );
  if (configDir) {
    return path.join(configDir, "templates");
  }

  const xdgHome =
    readEnvironmentVariable(STANDARD_ENVIRONMENT_VARIABLES.xdgConfigHome) ??
    path.join(os.homedir(), ".config");
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
      templates.push(...(await listTemplateVariants(templateId)));
    }
  }

  return templates.sort((a, b) => a.id.localeCompare(b.id));
}

export async function loadTemplate(
  templateId: string,
): Promise<Template | null> {
  const identifier = parseTemplateIdentifier(templateId);
  const templatesDir = getTemplatesDir();
  const templateDir = resolveContainedPath(templatesDir, identifier.parent);

  const templatePath = await resolveTemplateConfigPath(templateDir);
  if (!templatePath) {
    return null;
  }

  try {
    const parentConfig = await readTemplateConfig(templatePath);
    if (!identifier.variant) {
      return {
        id: identifier.parent,
        path: templatePath,
        directory: templateDir,
        parentId: identifier.parent,
        config: parentConfig,
      };
    }

    const variantDir = resolveContainedPath(
      templateDir,
      VARIANTS_DIR,
      identifier.variant,
    );
    const variantPath = await resolveTemplateConfigPath(variantDir);
    if (!variantPath) {
      return null;
    }
    const raw = await fs.readFile(variantPath, "utf8");
    const parsed: unknown = parseJsonc(raw);
    if (!isValidTemplateConfigOverride(parsed)) {
      throw new Error(
        `Invalid template variant config at ${variantPath}: expected a partial template config`,
      );
    }
    const config = mergeTemplateConfig(parentConfig, parsed);
    if (!isValidTemplateConfig(config)) {
      throw new Error(
        `Invalid template config at ${variantPath}: variant did not produce required fields`,
      );
    }
    validateTemplateConfigPaths(config);

    return {
      id: formatTemplateIdentifier(identifier),
      path: variantPath,
      directory: variantDir,
      parentId: identifier.parent,
      variantId: identifier.variant,
      parentPath: templatePath,
      config: normalizeTemplateConfig(config),
    };
  } catch (error_) {
    if ((error_ as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error_;
  }
}

async function resolveTemplateConfigPath(
  templateDir: string,
): Promise<string | null> {
  const jsoncPath = resolveContainedPath(templateDir, TEMPLATE_FILENAME_JSONC);
  if (await pathExists(jsoncPath)) {
    return jsoncPath;
  }

  const jsonPath = resolveContainedPath(templateDir, TEMPLATE_FILENAME_JSON);
  if (await pathExists(jsonPath)) {
    return jsonPath;
  }

  return null;
}

async function listTemplateVariants(parentId: string): Promise<Template[]> {
  const templatesDir = getTemplatesDir();
  const variantsDir = resolveContainedPath(
    templatesDir,
    parentId,
    VARIANTS_DIR,
  );
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = await fs.readdir(variantsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const variants: Template[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const loaded = await loadTemplate(`${parentId}+${entry.name}`);
    if (loaded) variants.push(loaded);
  }
  return variants;
}

async function readTemplateConfig(
  templatePath: string,
): Promise<TemplateConfig> {
  const raw = await fs.readFile(templatePath, "utf8");
  const parsed: unknown = parseJsonc(raw);

  if (!isValidTemplateConfig(parsed)) {
    throw new Error(
      `Invalid template config at ${templatePath}: missing required fields`,
    );
  }
  validateTemplateConfigPaths(parsed);
  return normalizeTemplateConfig(parsed);
}

export async function createTemplateVariant(
  parentId: string,
  variantId: string,
  config: TemplateConfigOverride = {},
): Promise<void> {
  const parent = validateTemplateName(parentId);
  const variant = validateTemplateName(variantId);
  if (!(await loadTemplate(parent))) {
    throw new Error(`Template "${parent}" not found.`);
  }
  if (!isValidTemplateConfigOverride(config)) {
    throw new Error("Variant config must be a partial template config.");
  }
  const templatesDir = getTemplatesDir();
  const variantDir = resolveContainedPath(
    templatesDir,
    parent,
    VARIANTS_DIR,
    variant,
  );
  const variantPath = resolveContainedPath(variantDir, TEMPLATE_FILENAME_JSONC);
  await ensureDir(variantDir);
  await fs.writeFile(variantPath, generateTemplateVariantJsonc(config), "utf8");
}

export async function createTemplate(
  templateId: string,
  config: TemplateConfig,
): Promise<void> {
  validateTemplateName(templateId);
  validateTemplateConfigPaths(config);
  const templatesDir = getTemplatesDir();
  const templateDir = resolveContainedPath(templatesDir, templateId);
  const templatePath = resolveContainedPath(
    templateDir,
    TEMPLATE_FILENAME_JSONC,
  );

  await ensureDir(templateDir);

  const contents = generateTemplateJsonc(normalizeTemplateConfig(config));
  await fs.writeFile(templatePath, contents, "utf8");
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
  lines.push(
    '  // Override the global branch prefix, e.g. "feature/" (optional)',
  );
  lines.push('  // Use "" to disable the global prefix for this template');
  if (config.branchPrefix !== undefined) {
    lines.push(`  "branchPrefix": ${JSON.stringify(config.branchPrefix)},`);
  } else {
    lines.push('  // "branchPrefix": "feature/",');
  }

  // hooks (optional)
  lines.push("");
  lines.push("  // Focused, generated workspace guidance (optional)");
  if (config["AGENTS.md"]) {
    lines.push(
      `  "AGENTS.md": ${JSON.stringify(config["AGENTS.md"], null, 2).replace(/\n/g, "\n  ")},`,
    );
  } else {
    lines.push('  // "AGENTS.md": {');
    lines.push('  //   "focus": "How a workflow crosses these repositories.",');
    lines.push('  //   "paths": { "repo": ["src/component"] },');
    lines.push('  //   "maxAgeHours": 24');
    lines.push("  // },");
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

function generateTemplateVariantJsonc(config: TemplateConfigOverride): string {
  const lines: string[] = ["{"];
  lines.push("  // Variant overrides are partial.");
  lines.push("  // Missing fields inherit from the parent template.");
  lines.push("  // Arrays and scalar values replace inherited values.");
  lines.push(
    "  // Plain objects merge recursively; null removes inherited optional fields.",
  );
  const entries = Object.entries(config);
  for (const [index, [key, value]] of entries.entries()) {
    lines.push(
      `  ${JSON.stringify(key)}: ${JSON.stringify(value, null, 2).replace(/\n/g, "\n  ")}${index === entries.length - 1 ? "" : ","}`,
    );
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function normalizeTemplateConfig(config: TemplateConfig): TemplateConfig {
  const hasBranchPrefix = Object.hasOwn(config, "branchPrefix");
  const { branchPrefix: _branchPrefix, ...rest } = config;

  if (!hasBranchPrefix) {
    return normalizeAgentsMdConfig(rest);
  }

  return normalizeAgentsMdConfig({
    ...rest,
    branchPrefix: config.branchPrefix?.trim() ?? "",
  });
}

function normalizeAgentsMdConfig(config: TemplateConfig): TemplateConfig {
  const agents = config["AGENTS.md"];
  if (!agents) return config;
  return {
    ...config,
    "AGENTS.md": {
      ...agents,
      focus: agents.focus.trim(),
      ...(agents.paths
        ? {
            paths: Object.fromEntries(
              Object.entries(agents.paths).map(([repo, paths]) => [
                repo,
                [...paths],
              ]),
            ),
          }
        : {}),
      maxAgeHours: agents.maxAgeHours ?? 24,
    },
  };
}

export async function deleteTemplate(templateId: string): Promise<void> {
  validateTemplateName(templateId);
  const templatesDir = getTemplatesDir();
  const templateDir = resolveContainedPath(templatesDir, templateId);

  const exists = await pathExists(templateDir);
  if (!exists) {
    return;
  }

  await fs.rm(templateDir, { recursive: true, force: true });
}

export function parseTemplateIdentifier(
  templateId: string,
): TemplateIdentifier {
  const parts = templateId.split("+");
  if (parts.length === 1) {
    return { parent: validateTemplateName(parts[0] ?? "") };
  }
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Template id must be <template> or <template>+<variant>.");
  }
  return {
    parent: validateTemplateName(parts[0]),
    variant: validateTemplateName(parts[1]),
  };
}

export function formatTemplateIdentifier(
  identifier: TemplateIdentifier,
): string {
  return identifier.variant
    ? `${identifier.parent}+${identifier.variant}`
    : identifier.parent;
}

export function validateTemplateName(templateId: string): string {
  validateResourceName(templateId, "Template name");
  if (templateId.includes("+")) {
    throw new Error(
      "Template name must not contain '+'. Use <template>+<variant> when referencing variants.",
    );
  }
  if (!isSlug(templateId)) {
    throw new Error(
      "Template name must be lowercase words separated by single hyphens.",
    );
  }
  return templateId;
}

export function validateTemplateIdentifier(templateId: string): string {
  return formatTemplateIdentifier(parseTemplateIdentifier(templateId));
}

function mergeTemplateConfig(
  parent: TemplateConfig,
  override: TemplateConfigOverride,
): TemplateConfig {
  return mergeConfigValues(parent, override) as TemplateConfig;
}

function mergeConfigValues(parent: unknown, override: unknown): unknown {
  if (override === null) {
    return undefined;
  }
  if (override === undefined) {
    return cloneJson(parent);
  }
  if (
    isPlainObject(parent) &&
    isPlainObject(override) &&
    !Array.isArray(parent) &&
    !Array.isArray(override)
  ) {
    const result: Record<string, unknown> = { ...parent };
    for (const [key, value] of Object.entries(override)) {
      const merged = mergeConfigValues(result[key], value);
      if (merged === undefined) {
        delete result[key];
      } else {
        result[key] = merged;
      }
    }
    return result;
  }
  return cloneJson(override);
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateTemplateConfigPaths(config: TemplateConfig): void {
  const configuredRepoNames = new Set(
    config.repos.map((repo) =>
      repo
        .replace(/\.git$/, "")
        .split(/[/:]/)
        .filter(Boolean)
        .at(-1),
    ),
  );
  for (const [repo, paths] of Object.entries(
    config["AGENTS.md"]?.paths ?? {},
  )) {
    validateRepositoryComponent(repo, "AGENTS.md paths repository");
    if (!configuredRepoNames.has(repo)) {
      throw new Error(
        `AGENTS.md paths references unknown repository "${repo}".`,
      );
    }
    for (const componentPath of paths) {
      resolveContainedPath("/workforest-agents-md-root", componentPath);
    }
  }
  for (const hook of config.hooks ?? []) {
    const hookDirs = hook.in
      ? Array.isArray(hook.in)
        ? hook.in
        : [hook.in]
      : [];
    for (const hookDir of hookDirs) {
      validateRepositoryComponent(hookDir, `Hook "${hook.name}" repository`);
    }

    if (hook.if?.fileExists) {
      resolveContainedPath("/workforest-hook-root", hook.if.fileExists);
    }
  }
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

  const agents = config["AGENTS.md"];
  if (agents !== undefined) {
    if (agents === null || typeof agents !== "object") return false;
    const value = agents as Record<string, unknown>;
    if (typeof value["focus"] !== "string" || !value["focus"].trim()) {
      return false;
    }
    if (
      value["maxAgeHours"] !== undefined &&
      (!Number.isInteger(value["maxAgeHours"]) ||
        (value["maxAgeHours"] as number) <= 0)
    ) {
      return false;
    }
    if (value["paths"] !== undefined) {
      if (value["paths"] === null || typeof value["paths"] !== "object") {
        return false;
      }
      for (const paths of Object.values(
        value["paths"] as Record<string, unknown>,
      )) {
        if (
          !Array.isArray(paths) ||
          paths.some((item) => typeof item !== "string" || !item)
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

function isValidTemplateConfigOverride(
  value: unknown,
): value is TemplateConfigOverride {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const config = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "repos",
    "description",
    "branchPrefix",
    "hooks",
    "AGENTS.md",
    "disableInitializers",
  ]);
  for (const key of Object.keys(config)) {
    if (!allowedKeys.has(key)) return false;
  }

  if (
    config["repos"] !== undefined &&
    config["repos"] !== null &&
    (!Array.isArray(config["repos"]) ||
      config["repos"].some((repo) => typeof repo !== "string"))
  ) {
    return false;
  }
  if (
    config["description"] !== undefined &&
    config["description"] !== null &&
    typeof config["description"] !== "string"
  ) {
    return false;
  }
  if (
    config["branchPrefix"] !== undefined &&
    config["branchPrefix"] !== null &&
    typeof config["branchPrefix"] !== "string"
  ) {
    return false;
  }
  if (
    config["disableInitializers"] !== undefined &&
    config["disableInitializers"] !== null
  ) {
    const value = config["disableInitializers"];
    if (typeof value !== "boolean" && !Array.isArray(value)) return false;
    if (
      Array.isArray(value) &&
      value.some((item) => typeof item !== "string")
    ) {
      return false;
    }
  }
  if (config["hooks"] !== undefined && config["hooks"] !== null) {
    if (
      !isValidTemplateConfig({
        repos: ["placeholder/repo"],
        hooks: config["hooks"],
      })
    ) {
      return false;
    }
  }
  if (config["AGENTS.md"] !== undefined && config["AGENTS.md"] !== null) {
    if (!isValidAgentsMdConfigOverride(config["AGENTS.md"])) return false;
  }
  return true;
}

function isValidAgentsMdConfigOverride(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const agents = value as Record<string, unknown>;
  const allowedKeys = new Set(["focus", "paths", "maxAgeHours"]);
  for (const key of Object.keys(agents)) {
    if (!allowedKeys.has(key)) return false;
  }
  if (
    agents["focus"] !== undefined &&
    agents["focus"] !== null &&
    (typeof agents["focus"] !== "string" || !agents["focus"].trim())
  ) {
    return false;
  }
  if (
    agents["maxAgeHours"] !== undefined &&
    agents["maxAgeHours"] !== null &&
    (!Number.isInteger(agents["maxAgeHours"]) ||
      (agents["maxAgeHours"] as number) <= 0)
  ) {
    return false;
  }
  if (agents["paths"] !== undefined && agents["paths"] !== null) {
    if (
      agents["paths"] === null ||
      typeof agents["paths"] !== "object" ||
      Array.isArray(agents["paths"])
    ) {
      return false;
    }
    for (const paths of Object.values(
      agents["paths"] as Record<string, unknown>,
    )) {
      if (
        paths !== null &&
        (!Array.isArray(paths) ||
          paths.some((item) => typeof item !== "string" || !item))
      ) {
        return false;
      }
    }
  }
  return true;
}
