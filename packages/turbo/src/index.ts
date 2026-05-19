import path from "node:path";
import {
  hasAny,
  pathExists,
  type InitializerContext,
  type PluginDetection,
} from "@wf-plugin/core";

export async function detect(
  context: InitializerContext,
): Promise<PluginDetection> {
  const turboDir = path.join(context.repoDir, ".turbo");
  if (await pathExists(turboDir)) {
    return { activate: false };
  }

  const hasTurboJsonInRepo = await hasAny(context.repoDir, ["turbo.json"]);
  const hasTurboJsonInWorkspace = await pathExists(
    path.join(context.workspaceDir, "turbo.json"),
  );

  if (!hasTurboJsonInRepo && !hasTurboJsonInWorkspace) {
    return { activate: false };
  }

  return { activate: true, initializers: ["turbo-link"] };
}
