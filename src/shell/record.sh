# agent-polygraph record: logs test commands you run in this terminal (folder, start and end
# time, exit code; never their output) to ~/.agent-polygraph/records/terminal.jsonl, so a
# test you ran yourself counts as evidence. Stays on this machine.
# Remove with: agent-polygraph record --uninstall --shell
case $- in *i*) ;; *) return 0 2>/dev/null ;; esac
# not inside coding agents' own shells: their commands are in their logs already
[ -n "${CLAUDECODE:-}${CODEX_SANDBOX:-}${CODEX_THREAD_ID:-}${CODEX_MANAGED_BY_NPM:-}" ] && return 0 2>/dev/null

__apg_file="${AGENT_POLYGRAPH_HOME:-$HOME/.agent-polygraph}/records/terminal.jsonl"
# a cheap prefilter; agent-polygraph applies its real test-command rules when it reads the log
__apg_re='(test|spec|pytest|jest|vitest|mocha|rspec|phpunit|ctest|tox|nox|check|verify)'
__apg_cmd=

__apg_now() {
  if [ -n "${EPOCHREALTIME:-}" ]; then printf '%s' "${EPOCHREALTIME/,/.}"; else date +%s; fi
}
__apg_esc() {
  local s=$1
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\t'/\\t}; s=${s//$'\r'/}
  printf '%s' "$s"
}
__apg_pre() {
  __apg_cmd=
  [[ $1 =~ $__apg_re ]] || return 0
  __apg_cmd=$1
  __apg_dir=$PWD
  __apg_t0=$(__apg_now)
}
__apg_post() {
  local s=$?
  if [ -n "$__apg_cmd" ]; then
    printf '{"v":1,"kind":"terminal","start":%s,"end":%s,"exit":%s,"cwd":"%s","cmd":"%s"}\n' \
      "$__apg_t0" "$(__apg_now)" "$s" "$(__apg_esc "$__apg_dir")" "$(__apg_esc "$__apg_cmd")" >>"$__apg_file" 2>/dev/null
    __apg_cmd=
  fi
  return $s
}

if [ -n "${ZSH_VERSION:-}" ]; then
  autoload -Uz add-zsh-hook && add-zsh-hook preexec __apg_pre && add-zsh-hook precmd __apg_post
elif [ -n "${BASH_VERSION:-}" ]; then
  if [ -n "${bash_preexec_imported:-}${__bp_imported:-}" ]; then
    # bash-preexec is loaded: use its hooks instead of a DEBUG trap of our own
    preexec_functions+=(__apg_pre)
    precmd_functions=(__apg_post "${precmd_functions[@]}")
  elif [ -z "$(trap -p DEBUG)" ]; then
    # one DEBUG trap call per command line: $HISTCMD changes only when a new line is entered
    __apg_last=$HISTCMD
    __apg_debug() {
      [[ ${BASH_COMMAND:-} == __apg_* ]] && return
      [ -n "${COMP_LINE:-}" ] && return
      [ "$HISTCMD" = "$__apg_last" ] && return
      __apg_last=$HISTCMD
      local h
      h=$(HISTTIMEFORMAT= builtin history 1)
      [[ $h =~ ^[[:space:]]*[0-9]+[*]?[[:space:]]+(.*)$ ]] && __apg_pre "${BASH_REMATCH[1]}"
    }
    trap '__apg_debug' DEBUG
    PROMPT_COMMAND="__apg_post${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
  fi
fi
