# agent-polygraph record: store only a recognized test-runner label, timestamps,
# working directory and exit code. Never persist the shell command or its output.
# Remove with: agent-polygraph record --uninstall --shell
case $- in *i*) ;; *) return 0 2>/dev/null ;; esac
[ -n "${CLAUDECODE:-}${CODEX_SANDBOX:-}${CODEX_THREAD_ID:-}${CODEX_MANAGED_BY_NPM:-}" ] && return 0 2>/dev/null

# Substituted with an installed, persistent CLI path by record --install --shell.
__apg_node=__APG_NODE__
__apg_entry=__APG_ENTRY__
__apg_runner=

__apg_now() {
  if [ -n "${EPOCHREALTIME:-}" ]; then printf '%s' "${EPOCHREALTIME/,/.}"; else date +%s; fi
}
__apg_esc() {
  local s=$1
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\t'/\\t}; s=${s//$'\r'/\\r}
  printf '%s' "$s"
}
__apg_pre() {
  __apg_runner=
  # Conservative: do not treat compound commands (e.g. npm test; true) as proof.
  case "$1" in *';'*|*'|'*|*'&'*|*'`'*|*'$('*|*$'\n'*) return 0 ;; esac
  local c="${1#${1%%[![:space:]]*}}"
  case "$c" in
    "pytest"|"pytest "*|"python -m pytest"*|"python3 -m pytest"*) __apg_runner="pytest" ;;
    "npm test"|"npm test "*|"npm run test"|"npm run test "*|"npm run test:"*) __apg_runner="npm test" ;;
    "node --test"|"node --test "*) __apg_runner="node --test" ;;
    "go test"|"go test "*) __apg_runner="go test" ;;
    "cargo test"|"cargo test "*) __apg_runner="cargo test" ;;
    "mvn test"|"mvn test "*) __apg_runner="mvn test" ;;
    "gradle test"|"gradle test "*|"./gradlew test"|"./gradlew test "*) __apg_runner="gradle test" ;;
    "dotnet test"|"dotnet test "*) __apg_runner="dotnet test" ;;
    "vitest"|"vitest "*|"jest"|"jest "*) __apg_runner="vitest run" ;;
  esac
  [ -n "$__apg_runner" ] || return 0
  __apg_dir=$PWD
  __apg_t0=$(__apg_now)
}
__apg_post() {
  local s=$?
  if [ -n "$__apg_runner" ]; then
    # The CLI validates input and writes with O_NOFOLLOW; shell redirection
    # cannot be used here because it would follow an attacker-created symlink.
    printf '{"v":2,"kind":"terminal","start":%s,"end":%s,"exit":%s,"cwd":"%s","runner":"%s"}\n' \
      "$__apg_t0" "$(__apg_now)" "$s" "$(__apg_esc "$__apg_dir")" "$__apg_runner" |
      "$__apg_node" "$__apg_entry" record --shell-event >/dev/null 2>&1
    __apg_runner=
  fi
  return $s
}

if [ -n "${ZSH_VERSION:-}" ]; then
  autoload -Uz add-zsh-hook && add-zsh-hook preexec __apg_pre && add-zsh-hook precmd __apg_post
elif [ -n "${BASH_VERSION:-}" ]; then
  if [ -n "${bash_preexec_imported:-}${__bp_imported:-}" ]; then
    preexec_functions+=(__apg_pre)
    precmd_functions=(__apg_post "${precmd_functions[@]}")
  elif [ -z "$(trap -p DEBUG)" ]; then
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
