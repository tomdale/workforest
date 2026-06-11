import fs from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.ts";

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
  const completionBlock = shell === "zsh" ? renderZshCompletion() : "";

  return `# workforest shell integration for ${shell}
__workforest_invoke() {
  local workforest_cmd="$1"
  shift

  case "$1" in
    new|fork|clean|delete|workspace|cd|find|template|templates|worktree|wt|review|skills) ;;
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

function renderZshCompletion(): string {
  return `_workforest_workspace_names() {
  local workspace_root
  workspace_root="$(__workforest_workspace_root)"
  local -a workspaces
  [[ -n "$workspace_root" && -d "$workspace_root" ]] || return 1

  for dir in \${workspace_root}/*(N/); do
    workspaces+=("\${dir:t}")
  done

  (( $#workspaces > 0 )) || return 1
  _describe -t workspaces 'workspace' workspaces
}

__workforest_workspace_root() {
  local config_dir config_path root
  config_dir="\${WORKFOREST_CONFIG_DIR:-}"

  if [[ -n "$config_dir" ]]; then
    config_path="$config_dir/config.json"
  elif [[ -n "\${XDG_CONFIG_HOME:-}" ]]; then
    config_path="$XDG_CONFIG_HOME/workforest/config.json"
  else
    config_path="$HOME/.workforest/config.json"
  fi

  [[ -r "$config_path" ]] || return 1

  root="$(node --input-type=module -e '
    import fs from "node:fs";
    import os from "node:os";
    import path from "node:path";

    const configPath = process.argv[1];
    let config;
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      process.exit(1);
    }

    const defaultDir = typeof config.defaultDir === "string"
      ? config.defaultDir.trim()
      : "";

    if (!defaultDir) {
      process.exit(1);
    }

    const expanded = defaultDir === "~"
      ? os.homedir()
      : defaultDir.startsWith("~/")
        ? path.join(os.homedir(), defaultDir.slice(2))
        : defaultDir;

    process.stdout.write(path.resolve(expanded));
  ' "$config_path" 2>/dev/null)" || return 1

  [[ -n "$root" ]] || return 1
  print -r -- "$root"
}

_workforest_complete() {
  local curcontext="$curcontext" state line
  typeset -A opt_args
  local -a commands
  local subcommand="\${words[2]:-}"
  commands=(
    'new:create a workspace'
    'status:monitor background repository initialization'
    'worktree:create or manage repo worktrees'
    'wt:create or manage repo worktrees'
    'review:create or manage PR review worktrees'
    'delete:infer and delete current tracked resource'
    'workspace:manage workspaces'
    'add:add repo(s) to a workspace'
    'skills:list and retrieve bundled agent skills'
    'fork:fork current workspace'
    'clean:remove a workspace'
    'cd:jump to a workspace'
    'find:fuzzy-find a workspace'
    'list:list workspaces'
    'init:print shell integration'
    'template:manage templates'
    'templates:open template manager'
    'config:manage configuration'
    'version:show version'
  )

  _arguments -C \\
    '1:command:->command' \\
    '*::arg:->args'

  case "$state" in
    command)
      _describe -t commands 'workforest command' commands
      ;;
    args)
      case "$subcommand" in
        cd|clean|delete|workspace)
          _workforest_workspace_names
          ;;
        status)
          _values 'status action' cancel retry
          ;;
        worktree|wt)
          _values 'worktree action' new promote list delete rm
          ;;
      esac
      ;;
  esac
}

__workforest_register_completion() {
  local alias_name alias_value

  (( $+functions[compdef] )) || return 0
  compdef _workforest_complete wf workforest

  for alias_name alias_value in "\${(@kv)aliases}"; do
    case "$alias_value" in
      wf|workforest)
        compdef _workforest_complete "$alias_name"
        ;;
    esac
  done
}

__workforest_register_completion`;
}
