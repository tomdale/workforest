import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  failure,
  humanOutput,
  jsonFailure,
  jsonSuccess,
  pathOutput,
  reportOutput,
  success,
} from "./cli/output.ts";
import type { CommandResult } from "./cli/types.ts";
import {
  readEnvironmentVariable,
  WORKFOREST_ENVIRONMENT_VARIABLES,
} from "./environment.ts";
import { renderReport } from "./terminal/report.ts";

const SKILL_DIR_NAMES = ["skill-data"] as const;
const SUPPLEMENTARY_DIR_NAMES = ["references", "templates"] as const;

export type SkillInfo = {
  name: string;
  description: string;
  dir: string;
  hidden: boolean;
};

export type SkillFile = {
  path: string;
  content: string;
};

export type SkillContent = {
  name: string;
  content: string;
  files?: SkillFile[];
};

export type SkillsCommandInvocation =
  | Readonly<{ command: "list"; json: boolean }>
  | Readonly<{
      command: "get";
      names: readonly string[];
      all: boolean;
      full: boolean;
      json: boolean;
    }>
  | Readonly<{
      command: "path";
      name: string | undefined;
      json: boolean;
    }>;

export function parseSkillFrontmatter(
  content: string,
): Pick<SkillInfo, "name" | "description" | "hidden"> | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return null;
  }

  const afterOpening = trimmed.slice(3);
  const end = afterOpening.indexOf("\n---");
  if (end === -1) {
    return null;
  }

  const frontmatter = afterOpening.slice(0, end);
  const lines = frontmatter.split("\n");
  let name: string | undefined;
  let description = "";
  let hidden = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.startsWith("name:")) {
      name = line.slice("name:".length).trim();
      continue;
    }

    if (line.startsWith("description:")) {
      const parts = [line.slice("description:".length).trim()];
      while (
        i + 1 < lines.length &&
        (/^\s+/.test(lines[i + 1] ?? "") || (lines[i + 1] ?? "").trim() === "")
      ) {
        i += 1;
        const continuation = (lines[i] ?? "").trim();
        if (continuation) {
          parts.push(continuation);
        }
      }
      description = parts.join(" ");
      continue;
    }

    if (line.startsWith("hidden:")) {
      const value = line.slice("hidden:".length).trim();
      hidden = value === "true" || value === "yes";
    }
  }

  if (!name) {
    return null;
  }

  return { name, description, hidden };
}

export async function findSkillsDirs(): Promise<string[]> {
  const override = readEnvironmentVariable(
    WORKFOREST_ENVIRONMENT_VARIABLES.skillsDir,
  );
  if (override) {
    return (await isDirectory(override)) ? [path.resolve(override)] : [];
  }

  const packageRoot = await findPackageRoot();
  if (!packageRoot) {
    return [];
  }

  const dirs: string[] = [];
  for (const dirName of SKILL_DIR_NAMES) {
    const candidate = path.join(packageRoot, dirName);
    if (await isDirectory(candidate)) {
      dirs.push(candidate);
    }
  }
  return dirs;
}

export async function discoverSkills(
  skillsDirs: readonly string[],
): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];

  for (const skillsDir of skillsDirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(skillsDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const dir = path.join(skillsDir, entry);
      if (!(await isDirectory(dir))) {
        continue;
      }

      const skillPath = path.join(dir, "SKILL.md");
      let content: string;
      try {
        content = await fs.readFile(skillPath, "utf8");
      } catch {
        continue;
      }

      const frontmatter = parseSkillFrontmatter(content);
      if (!frontmatter) {
        continue;
      }

      skills.push({ ...frontmatter, dir });
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSkillContents({
  skillsDirs,
  names,
  all,
  full,
}: {
  skillsDirs: readonly string[];
  names: readonly string[];
  all: boolean;
  full: boolean;
}): Promise<SkillContent[]> {
  const skills = await discoverSkills(skillsDirs);
  const targets = all
    ? skills.filter((skill) => !skill.hidden)
    : names.map((name) => {
        const skill = skills.find((candidate) => candidate.name === name);
        if (!skill) {
          throw new Error(`Skill not found: ${name}`);
        }
        return skill;
      });

  if (targets.length === 0) {
    throw new Error("No skill name provided. Usage: wf skills get <name>");
  }

  const contents: SkillContent[] = [];
  for (const skill of targets) {
    const content = await fs.readFile(path.join(skill.dir, "SKILL.md"), "utf8");
    const item: SkillContent = {
      name: skill.name,
      content,
    };

    if (full) {
      const files = await collectSupplementaryFiles(skill.dir);
      if (files.length > 0) {
        item.files = files;
      }
    }

    contents.push(item);
  }

  return contents;
}

export async function runSkillsCommand(
  invocation: SkillsCommandInvocation,
): Promise<CommandResult> {
  const skillsDirs = await findSkillsDirs();

  if (skillsDirs.length === 0) {
    return failSkillsCommand(
      "Skills directory not found. Set WORKFOREST_SKILLS_DIR or reinstall workforest.",
      invocation.json,
    );
  }

  try {
    switch (invocation.command) {
      case "list":
        return await runSkillsList(skillsDirs, invocation.json);
      case "get":
        return await runSkillsGet(skillsDirs, invocation);
      case "path":
        return await runSkillsPath(
          skillsDirs,
          invocation.name,
          invocation.json,
        );
    }
  } catch (error) {
    return failSkillsCommand(
      error instanceof Error ? error.message : String(error),
      invocation.json,
    );
  }
}

async function runSkillsList(
  skillsDirs: readonly string[],
  jsonMode: boolean,
): Promise<CommandResult> {
  const skills = (await discoverSkills(skillsDirs)).filter(
    (skill) => !skill.hidden,
  );

  if (jsonMode) {
    return jsonSuccess(
      skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
      })),
    );
  }

  if (skills.length === 0) {
    return success(humanOutput("No skills found."));
  }

  return success(
    reportOutput(
      renderReport({
        title: "Agent skills",
        sections: [
          {
            entries: skills.map((skill) => ({
              title: skill.name,
              ...(skill.description
                ? { description: truncateDescription(skill.description, 70) }
                : {}),
            })),
          },
        ],
        footer: `${skills.length} skill${skills.length === 1 ? "" : "s"}`,
      }),
    ),
  );
}

async function runSkillsGet(
  skillsDirs: readonly string[],
  invocation: Extract<SkillsCommandInvocation, { command: "get" }>,
): Promise<CommandResult> {
  const contents = await getSkillContents({
    skillsDirs,
    names: invocation.names,
    all: invocation.all,
    full: invocation.full,
  });

  if (invocation.json) {
    return jsonSuccess(contents);
  }

  return success(
    humanOutput(renderSkillContents(contents), { trailingNewline: false }),
  );
}

async function runSkillsPath(
  skillsDirs: readonly string[],
  name: string | undefined,
  jsonMode: boolean,
): Promise<CommandResult> {
  if (!name) {
    if (jsonMode) {
      return jsonSuccess({ paths: skillsDirs });
    }

    return success(pathOutput(skillsDirs.join("\n")));
  }

  const skills = await discoverSkills(skillsDirs);
  const skill = skills.find((candidate) => candidate.name === name);
  if (!skill) {
    throw new Error(`Skill not found: ${name}`);
  }

  if (jsonMode) {
    return jsonSuccess({ name: skill.name, path: skill.dir });
  }

  return success(pathOutput(skill.dir));
}

async function collectSupplementaryFiles(
  skillDir: string,
): Promise<SkillFile[]> {
  const files: SkillFile[] = [];

  for (const dirName of SUPPLEMENTARY_DIR_NAMES) {
    const dir = path.join(skillDir, dirName);
    if (!(await isDirectory(dir))) {
      continue;
    }

    const entries = (await fs.readdir(dir)).sort();
    for (const entry of entries) {
      const filePath = path.join(dir, entry);
      if (!(await isFile(filePath))) {
        continue;
      }

      files.push({
        path: `${dirName}/${entry}`,
        content: await fs.readFile(filePath, "utf8"),
      });
    }
  }

  return files;
}

async function findPackageRoot(): Promise<string | null> {
  let dir = path.dirname(fileURLToPath(import.meta.url));

  while (true) {
    if (await hasSkillDirectory(dir)) {
      return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

async function hasSkillDirectory(dir: string): Promise<boolean> {
  for (const name of SKILL_DIR_NAMES) {
    if (await isDirectory(path.join(dir, name))) {
      return true;
    }
  }
  return false;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

function failSkillsCommand(message: string, jsonMode: boolean): CommandResult {
  if (jsonMode) {
    return jsonFailure("operational", message);
  }

  return failure(1, humanOutput(message, { stream: "stderr" }));
}

function renderSkillContents(contents: readonly SkillContent[]): string {
  let output = "";
  for (let index = 0; index < contents.length; index += 1) {
    const skill = contents[index];
    if (!skill) {
      continue;
    }
    if (index > 0) {
      output += "\n---\n\n";
    }

    output += withTrailingNewline(skill.content);
    for (const file of skill.files ?? []) {
      output += `\n--- ${file.path} ---\n\n`;
      output += withTrailingNewline(file.content);
    }
  }
  return output;
}

function withTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function truncateDescription(description: string, maxLength: number): string {
  if (description.length <= maxLength) {
    return description;
  }

  const slice = description.slice(0, maxLength + 1);
  const boundary = slice.lastIndexOf(" ");
  const end = boundary > 0 ? boundary : maxLength;
  return `${description.slice(0, end)}...`;
}
