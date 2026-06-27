import fs from "node:fs/promises";
import path from "node:path";
import { commandRegistry } from "./cli/commands.ts";
import type { CommandRegistry } from "./cli/types.ts";
import { log } from "./logger.ts";
import { createShellCommandModel } from "./shell/command-model.ts";
import {
  renderBashCompletion,
  renderZshCompletion,
} from "./shell/completion.ts";

export const WORKFOREST_CD_PATH_ENV = "WORKFOREST_CD_PATH_FILE";

export type SupportedShell = "bash" | "zsh";

export function normalizeShellName(
  shell: string | undefined,
): SupportedShell | null {
  const shellName = path.basename(shell ?? "");

  switch (shellName) {
    case "bash":
    case "zsh":
      return shellName;
    default:
      return null;
  }
}

export function renderShellInit(
  shell: SupportedShell,
  registry: CommandRegistry = commandRegistry,
): string {
  const commandModel = createShellCommandModel(registry);
  const completionBlock =
    shell === "zsh"
      ? renderZshCompletion(commandModel)
      : renderBashCompletion(commandModel);
  const handoffCommands =
    commandModel.handoffCommands.join("|") || "__workforest_no_handoff__";

  return `# workforest shell integration for ${shell}
__workforest_invoke() {
  local workforest_cmd="$1"
  shift

  case "$1" in
    ""|${handoffCommands}) ;;
    *)
      command "$workforest_cmd" "$@"
      return $?
      ;;
  esac

  local workforest_cd_file
  workforest_cd_file="$(mktemp "\${TMPDIR:-/tmp}/workforest-cd.XXXXXX")" || return 1

  ${WORKFOREST_CD_PATH_ENV}="$workforest_cd_file" command "$workforest_cmd" "$@"
  local workforest_status=$?

  if [ "$workforest_status" -eq 0 ] && [ -s "$workforest_cd_file" ]; then
    local workforest_target
    workforest_target="$(cat "$workforest_cd_file")"
    if [ -n "$workforest_target" ] && [ -d "$workforest_target" ]; then
      cd "$workforest_target" || workforest_status=$?
    fi
  fi

  rm -f "$workforest_cd_file"
  return "$workforest_status"
}

wf() {
  __workforest_invoke wf "$@"
}

workforest() {
  __workforest_invoke workforest "$@"
}

${completionBlock}
`;
}

export function isShellAutoCdEnabled(): boolean {
  return Boolean(process.env[WORKFOREST_CD_PATH_ENV]);
}

export function resolveCleanupCdTarget(
  currentDir: string,
  workspaceDir: string,
): string | null {
  const resolvedCurrentDir = path.resolve(currentDir);
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const relativePath = path.relative(resolvedWorkspaceDir, resolvedCurrentDir);
  const isInsideWorkspace =
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));

  if (!isInsideWorkspace) {
    return null;
  }

  return path.dirname(resolvedWorkspaceDir);
}

export async function writeShellCdPath(targetDir: string): Promise<void> {
  const cdPathFile = process.env[WORKFOREST_CD_PATH_ENV];
  if (!cdPathFile) {
    return;
  }

  try {
    await fs.writeFile(cdPathFile, `${path.resolve(targetDir)}\n`, "utf8");
  } catch (error) {
    log.warn(
      `Could not report the workspace directory back to the shell: ${toErrorMessage(error)}`,
    );
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
