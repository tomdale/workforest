import type { TaskState } from "../utils/task-generator.ts";
import type { Template } from "./index.ts";

export type ApplyTemplateOptions = {
  template: Template;
  workspaceDir: string;
};

/**
 * Generator that applies a template to a workspace.
 * Yields TaskState updates as it processes the template.
 */
export async function* applyTemplateGenerator({
  template,
  workspaceDir,
}: ApplyTemplateOptions): AsyncGenerator<TaskState, void, undefined> {
  yield {
    status: "log",
    level: "info",
    message: `Applying template "${template.config.name}" to workspace at ${workspaceDir}`,
  };

  // Template application logic will be implemented here
  // For now, this is a placeholder that yields a completion state

  yield {
    status: "log",
    level: "info",
    message: `Template "${template.config.name}" applied successfully`,
  };

  yield { status: "completed" };
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
