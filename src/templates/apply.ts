import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import { pathExists } from "@wf-plugin/core";
import { runHook } from "../services/hooks.ts";
import {
  assertContainedPathWithoutSymlinks,
  resolveContainedPath,
} from "../utils/path-safety.ts";
import type { TaskState } from "../utils/task-generator.ts";
import type { Template } from "./index.ts";

export type ApplyTemplateOptions = {
  template: Template;
  workspaceDir: string;
  repoDirs: string[];
};

export type HookState =
  | { phase: "hook-start"; hookName: string }
  | { phase: "hook"; hookName: string; state: TaskState }
  | { phase: "hook-complete"; hookName: string };

const TEMPLATE_FILES_DIR = "files";
const DEFAULT_AGENTS_MD_FILE = "AGENTS.md";

export async function copyTemplateFiles(
  template: Template,
  workspaceDir: string,
): Promise<void> {
  const templateDirs = [
    ...(template.parentPath ? [path.dirname(template.parentPath)] : []),
    path.dirname(template.path),
  ];
  const copiedTargets = new Set<string>();
  const generatedAgentsMdFile =
    template.config["AGENTS.md"]?.file ?? DEFAULT_AGENTS_MD_FILE;
  const options = {
    ...(template.config["AGENTS.md"] !== undefined
      ? { generatedAgentsMdFile }
      : {}),
    copiedTargets,
  };
  for (const templateDir of templateDirs) {
    await copyTemplateFilesLayer(templateDir, workspaceDir, options);
  }
}

async function copyTemplateFilesLayer(
  templateDir: string,
  workspaceDir: string,
  options: { generatedAgentsMdFile?: string; copiedTargets: Set<string> },
): Promise<void> {
  const templateDirStat = await fs.lstat(templateDir);
  if (templateDirStat.isSymbolicLink()) {
    throw new Error(
      `Template path must not be a symbolic link: ${templateDir}`,
    );
  }
  if (!templateDirStat.isDirectory()) {
    throw new Error(`Template path must be a real directory: ${templateDir}`);
  }
  const templateFilesDir = resolveContainedPath(
    templateDir,
    TEMPLATE_FILES_DIR,
  );

  if (!(await pathExists(templateFilesDir))) {
    return;
  }

  const sourceStat = await fs.lstat(templateFilesDir);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error(
      `Template files path must be a real directory: ${templateFilesDir}`,
    );
  }

  await copyDirectoryContents(
    templateFilesDir,
    workspaceDir,
    workspaceDir,
    options,
  );
}

async function copyDirectoryContents(
  sourceDir: string,
  targetDir: string,
  workspaceDir: string,
  options: { generatedAgentsMdFile?: string; copiedTargets: Set<string> },
  relativeDirectory = "",
): Promise<void> {
  await assertContainedPathWithoutSymlinks(workspaceDir, targetDir);
  await fs.mkdir(targetDir, { recursive: true });
  await assertContainedPathWithoutSymlinks(workspaceDir, targetDir);

  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const workspacePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (options.generatedAgentsMdFile === workspacePath) {
      continue;
    }
    const sourcePath = resolveContainedPath(sourceDir, entry.name);
    const targetPath = resolveContainedPath(targetDir, entry.name);

    if (entry.isSymbolicLink()) {
      throw new Error(
        `Template files must not contain symlinks: ${sourcePath}`,
      );
    }
    if (entry.isDirectory()) {
      await copyDirectoryContents(
        sourcePath,
        targetPath,
        workspaceDir,
        options,
        workspacePath,
      );
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported template file type: ${sourcePath}`);
    }

    await assertContainedPathWithoutSymlinks(workspaceDir, targetPath);
    try {
      if (options.copiedTargets.has(targetPath)) {
        await fs.copyFile(sourcePath, targetPath);
      } else {
        await fs.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
        options.copiedTargets.add(targetPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `Template file already exists in workspace: ${targetPath}`,
        );
      }
      throw error;
    }
  }
}

/**
 * Applies a template to a workspace, yielding hook state as it runs.
 * Runs hooks defined in the template.
 */
export async function* applyTemplate({
  template,
  workspaceDir,
  repoDirs,
}: ApplyTemplateOptions): AsyncGenerator<HookState, void, undefined> {
  const hooks = template.config.hooks ?? [];

  if (hooks.length === 0) {
    return;
  }

  for (const hook of hooks) {
    yield { phase: "hook-start", hookName: hook.name };

    // Determine the working directories for the hook
    // If no `in` specified, run in each repo directory
    const dirs = hook.in
      ? Array.isArray(hook.in)
        ? hook.in
        : [hook.in]
      : repoDirs;

    for (const dir of dirs) {
      const hookCwd = dir
        ? resolveContainedPath(workspaceDir, dir)
        : path.resolve(workspaceDir);

      try {
        await assertContainedPathWithoutSymlinks(workspaceDir, hookCwd);
        for await (const state of runHook(hook, workspaceDir, hookCwd)) {
          yield { phase: "hook", hookName: hook.name, state };

          // Check if hook failed
          if (state.status === "failed" && !hook.continueOnError) {
            throw state.error;
          }
        }
      } catch (error) {
        if (!hook.continueOnError) {
          throw error;
        }
        // Log but continue if continueOnError is true
        yield {
          phase: "hook",
          hookName: hook.name,
          state: {
            status: "log",
            level: "warn",
            message: `Hook "${hook.name}" failed but continuing: ${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }
    }

    yield { phase: "hook-complete", hookName: hook.name };
  }
}
