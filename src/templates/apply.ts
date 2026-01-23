import path from "node:path";
import { runHook } from "../services/hooks.ts";
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

/**
 * Generator that applies a template to a workspace.
 * Runs hooks defined in the template.
 */
export async function* applyTemplateGenerator({
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
      const hookCwd = dir ? path.join(workspaceDir, dir) : workspaceDir;

      try {
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

/**
 * @deprecated Use applyTemplateGenerator for generator-based workflows.
 */
export async function applyTemplate(
  options: ApplyTemplateOptions,
): Promise<void> {
  const gen = applyTemplateGenerator(options);
  let result = await gen.next();
  while (!result.done) {
    result = await gen.next();
  }
}
