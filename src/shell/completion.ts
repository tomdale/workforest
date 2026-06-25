import type { FlagDefinition } from "../cli/types.ts";
import type {
  ShellCommandModel,
  ShellCompletionCommand,
} from "./command-model.ts";

export function renderZshCompletion(model: ShellCommandModel): string {
  return `_workforest_complete_flags() {
  local -a flags
  flags=("$@")
  (( $#flags > 0 )) || return 1
  _values 'option' "$flags[@]"
}

_workforest_complete() {
  local root_command="\${words[2]:-}"
  local subcommand="\${words[3]:-}"

  if (( CURRENT == 2 )); then
    local -a commands
    commands=(
${renderZshDescriptions(model.commands, 6)}
    )
    _describe -t commands 'workforest command' commands
    return
  fi

  case "$root_command" in
${model.commands.map((command) => renderZshCommand(command)).join("\n")}
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

export function renderBashCompletion(model: ShellCommandModel): string {
  return `_workforest_complete_words() {
  local words="$1"
  local current="$2"
  COMPREPLY=( $(compgen -W "$words" -- "$current") )
}

_workforest_complete() {
  local current="\${COMP_WORDS[COMP_CWORD]}"
  local root_command="\${COMP_WORDS[1]:-}"
  local subcommand="\${COMP_WORDS[2]:-}"
  COMPREPLY=()

  if (( COMP_CWORD == 1 )); then
    _workforest_complete_words ${shellQuote(
      model.commands.map((command) => command.name).join(" "),
    )} "$current"
    return
  fi

  case "$root_command" in
${model.commands.map((command) => renderBashCommand(command)).join("\n")}
  esac
}

__workforest_register_completion() {
  local alias_name alias_value

  complete -F _workforest_complete wf workforest

  for alias_name in "\${!BASH_ALIASES[@]}"; do
    alias_value="\${BASH_ALIASES[$alias_name]}"
    case "$alias_value" in
      wf|workforest)
        complete -F _workforest_complete "$alias_name"
        ;;
    esac
  done
}

__workforest_register_completion`;
}

function renderZshCommand(command: ShellCompletionCommand): string {
  const lines = [`    ${command.name})`];

  if (command.children.length > 0) {
    const actionEntries = [
      renderZshDescriptions(command.children, 10),
      renderZshFlagDescriptions(command.flags, 10),
    ].filter(Boolean);

    lines.push(
      "      if (( CURRENT == 3 )); then",
      "        local -a actions",
      "        actions=(",
      ...actionEntries,
      "        )",
      "        _describe -t actions 'action' actions",
      "        return",
      "      fi",
      "",
      '      case "$subcommand" in',
      ...command.children.flatMap((child) => renderZshLeaf(child, 8)),
      "      esac",
    );

    if (command.flags.length > 0) {
      lines.push(
        `      _workforest_complete_flags ${renderFlagWords(command.flags)}`,
      );
    }
  } else {
    lines.push(...renderZshLeafBody(command, 6));
  }

  lines.push("      ;;");
  return lines.join("\n");
}

function renderZshLeaf(
  command: ShellCompletionCommand,
  indent: number,
): string[] {
  const padding = " ".repeat(indent);
  return [
    `${padding}${command.name})`,
    ...renderZshLeafBody(command, indent + 2),
    `${padding}  ;;`,
  ];
}

function renderZshLeafBody(
  command: ShellCompletionCommand,
  indent: number,
): string[] {
  const padding = " ".repeat(indent);
  const lines: string[] = [];

  if (command.flags.length > 0) {
    lines.push(
      `${padding}_workforest_complete_flags ${renderFlagWords(command.flags)}`,
    );
  }

  return lines;
}

function renderBashCommand(command: ShellCompletionCommand): string {
  const lines = [`    ${command.name})`];

  if (command.children.length > 0) {
    const defaults = flagWords(command.flags);
    const groupWords = [
      ...command.children.map((child) => child.name),
      ...defaults,
    ].join(" ");

    lines.push(
      "      if (( COMP_CWORD == 2 )); then",
      `        _workforest_complete_words ${shellQuote(groupWords)} "$current"`,
      "        return",
      "      fi",
      "",
      '      case "$subcommand" in',
      ...command.children.flatMap((child) => renderBashLeaf(child, 8)),
      "      esac",
    );
  } else {
    lines.push(...renderBashLeafBody(command, 6));
  }

  lines.push("      ;;");
  return lines.join("\n");
}

function renderBashLeaf(
  command: ShellCompletionCommand,
  indent: number,
): string[] {
  const padding = " ".repeat(indent);
  return [
    `${padding}${command.name})`,
    ...renderBashLeafBody(command, indent + 2),
    `${padding}  ;;`,
  ];
}

function renderBashLeafBody(
  command: ShellCompletionCommand,
  indent: number,
): string[] {
  const padding = " ".repeat(indent);
  const lines: string[] = [];

  const flags = flagWords(command.flags);
  if (flags.length > 0) {
    lines.push(
      `${padding}_workforest_complete_words ${shellQuote(flags.join(" "))} "$current"`,
    );
  }

  return lines;
}

function renderZshDescriptions(
  commands: readonly ShellCompletionCommand[],
  indent: number,
): string {
  const padding = " ".repeat(indent);
  return commands
    .map(
      (command) =>
        `${padding}${shellQuote(`${command.name}:${command.summary}`)}`,
    )
    .join("\n");
}

function renderZshFlagDescriptions(
  flags: readonly FlagDefinition[],
  indent: number,
): string {
  const padding = " ".repeat(indent);
  return flagWords(flags)
    .map((flag) => `${padding}${shellQuote(`${flag}:option`)}`)
    .join("\n");
}

function renderFlagWords(flags: readonly FlagDefinition[]): string {
  return flagWords(flags).map(shellQuote).join(" ");
}

function flagWords(flags: readonly FlagDefinition[]): string[] {
  return flags.flatMap((flag) =>
    flag.short ? [flag.short, flag.long] : [flag.long],
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
