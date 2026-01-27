import path from "node:path";
import { pathExists } from "../../utils/fs.ts";
import { runCommandGenerator } from "../../utils/task-generator.ts";
import { hasAny } from "../pnpm.ts";
import type {
  InitializerContext,
  InitializerDefinition,
  InitializerDetection,
} from "./types.ts";

/**
 * Detect if turbo link should run.
 * Conditions:
 * - Has turbo.json in repo or workspace root
 * - No .turbo directory (not already linked)
 */
async function detect(
  context: InitializerContext,
): Promise<InitializerDetection> {
  // Check if already linked
  const turboDir = path.join(context.repoDir, ".turbo");
  if (await pathExists(turboDir)) {
    return { shouldRun: false };
  }

  // Check for turbo.json in repo
  const hasTurboJsonInRepo = await hasAny(context.repoDir, ["turbo.json"]);

  // Check for turbo.json in workspace root
  const hasTurboJsonInWorkspace = await pathExists(
    path.join(context.workspaceDir, "turbo.json"),
  );

  if (!hasTurboJsonInRepo && !hasTurboJsonInWorkspace) {
    return { shouldRun: false };
  }

  return { shouldRun: true };
}

/**
 * Run turbo link.
 */
async function* execute(context: InitializerContext) {
  const { repoDir } = context;

  const args = ["link", "--yes"];

  yield { status: "running" as const, message: `turbo ${args.join(" ")}` };

  const link = runCommandGenerator("turbo", args, { cwd: repoDir });

  for await (const state of link) {
    yield state;
  }
}

export const turboLinkInitializer: InitializerDefinition = {
  id: "turbo-link",
  name: "Turbo link",
  priority: 201,
  detect,
  execute,
};
