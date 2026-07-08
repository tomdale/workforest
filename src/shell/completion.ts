export function renderZshCompletion(): string {
  return `_workforest_completion_command() {
  local command_name="$words[1]"
  local alias_value

  if [[ "$command_name" != "wf" && "$command_name" != "workforest" ]]; then
    alias_value="\${aliases[$command_name]:-}"
    case "$alias_value" in
      wf|workforest)
        command_name="$alias_value"
        ;;
    esac
  fi

  printf '%s\\n' "$command_name"
}

_workforest_complete() {
  local command_name
  local -a candidates completion_words

  command_name="$(_workforest_completion_command)"
  completion_words=("\${(@)words[2,-1]}")
  candidates=("\${(@f)$(command "$command_name" _complete -- "$((CURRENT - 2))" "\${completion_words[@]}" 2>/dev/null)}")
  (( $#candidates > 0 )) || return 0
  compadd -- "\${candidates[@]}"
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

export function renderBashCompletion(): string {
  return `_workforest_completion_command() {
  local command_name="$1"
  local alias_value

  if [[ "$command_name" != "wf" && "$command_name" != "workforest" ]]; then
    alias_value="\${BASH_ALIASES[$command_name]:-}"
    case "$alias_value" in
      wf|workforest)
        command_name="$alias_value"
        ;;
    esac
  fi

  printf '%s\\n' "$command_name"
}

_workforest_complete() {
  local command_name
  local candidate

  command_name="$(_workforest_completion_command "\${COMP_WORDS[0]}")"
  COMPREPLY=()
  while IFS= read -r candidate; do
    COMPREPLY+=("$candidate")
  done < <(command "$command_name" _complete -- "$((COMP_CWORD - 1))" "\${COMP_WORDS[@]:1}" 2>/dev/null)
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
