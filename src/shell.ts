import fs from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.ts";
import {
  renderBashCompletion,
  renderZshCompletion,
} from "./shell/completion.ts";
import { cdHint } from "./terminal/messages.ts";
import { compactHome } from "./utils/display-path.ts";

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

export function renderShellInit(shell: SupportedShell): string {
  const completionBlock =
    shell === "zsh" ? renderZshCompletion() : renderBashCompletion();

  // No per-command filter is needed: the CLI only writes a cd path when a
  // command actually has somewhere to go, and the wrapper only cd's when the
  // file comes back non-empty. So every invocation can safely run under the
  // temp file, including bare \`wf\`, which has no subcommand to allowlist.
  return `# workforest shell integration for ${shell}
__workforest_invoke() {
  local workforest_cmd="$1"
  shift

  local workforest_cd_file
  workforest_cd_file="$(mktemp "\${TMPDIR:-/tmp}/workforest-cd.XXXXXX")" || return 1

  ${WORKFOREST_CD_PATH_ENV}="$workforest_cd_file" command "$workforest_cmd" "$@"
  local workforest_status=$?

  if [ -s "$workforest_cd_file" ]; then
    local workforest_target
    workforest_target="$(cat "$workforest_cd_file")"
    if [ -n "$workforest_target" ]; then
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

/**
 * How a command reports its cd target: "auto" writes the shell wrapper's
 * auto-cd path and prints the manual hint only when the wrapper is absent;
 * "manual" only prints the hint; "silent" only writes the path, for surfaces
 * that already show the cd hint themselves (the setup run summary).
 */
export type ShellCdReportMode = "auto" | "manual" | "silent";

export type ShellCdReporter = (targetDir: string) => Promise<void>;

export async function reportShellCdTarget(
  targetDir: string,
  options: Readonly<{
    mode?: ShellCdReportMode;
    writeShellCdPath?: ShellCdReporter;
  }> = {},
): Promise<void> {
  const mode = options.mode ?? "auto";

  if (mode === "manual") {
    log.info(cdHint(compactHome(targetDir)));
    return;
  }

  await (options.writeShellCdPath ?? writeShellCdPath)(targetDir);
  if (mode === "auto" && !isShellAutoCdEnabled()) {
    log.info(cdHint(compactHome(targetDir)));
  }
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
