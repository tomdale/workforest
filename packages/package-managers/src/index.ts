import {
  hasAny,
  type InitializerContext,
  type PluginDetection,
} from "@wf-plugin/core";

const PNPM_LOCK_FILES = ["pnpm-lock.yaml", "pnpm-lock.yml"];

export async function detect(
  context: InitializerContext,
): Promise<PluginDetection> {
  if (await hasAny(context.repoDir, PNPM_LOCK_FILES)) {
    return { activate: true, initializers: ["pnpm-install"] };
  }

  if (await hasAny(context.repoDir, ["yarn.lock"])) {
    return { activate: true, initializers: ["yarn-install"] };
  }

  if (await hasAny(context.repoDir, ["package-lock.json"])) {
    return { activate: true, initializers: ["npm-install"] };
  }

  return { activate: false };
}
