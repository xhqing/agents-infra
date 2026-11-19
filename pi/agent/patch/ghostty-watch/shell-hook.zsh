# ghostty-watch —— 由 ~/.zshrc 在交互式 shell 里 source。
#
# 做两件事：
#   1) 新 shell 一启动，就把「上次 ghostty 是否被系统杀掉、丢了哪几个会话」打印出来
#      （pending 存在即说明 watch.py 捕到过终止事件、而用户还没看到）。这是「一定知道」
#      的兜底：你总要再开终端。
#   2) 每次显示提示符前写一份心跳（pid / 父进程 / tty / cwd / 最近一条命令），
#      ghostty 被杀时 watch.py 靠它还原「丢的是哪几个窗口、各自在哪个目录」；
#      正常退出时由 zshexit 打 clean 标记，从而把「手工 Cmd+Q」和「被强制杀掉」区分开。
#
# 移除方法：删掉 ~/.zshrc 里 source 这一行即可（不残留任何全局状态）。

[[ -o interactive ]] || return 0
[[ -n "${GHOSTTY_WATCH_DISABLE:-}" ]] && return 0

typeset -g _GW_DIR="${GHOSTTY_WATCH_STATE:-$HOME/.local/state/ghostty-watch}"

# ---- 1. 上次的终止事件（只在真有 pending 时输出）----
if [[ -r "$_GW_DIR/pending.json" ]]; then
  /usr/bin/python3 - "$_GW_DIR/pending.json" <<'PY' 2>/dev/null
import json, sys
try:
    items = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
if not isinstance(items, list) or not items:
    sys.exit(0)
for ev in items:
    print("")
    print("\033[1;31m╔══════════════════════════════════════════════════════════════╗\033[0m")
    print("\033[1;31m║  ⚠  ghostty 上次不是正常退出的\033[0m")
    print("\033[1;31m╚══════════════════════════════════════════════════════════════╝\033[0m")
    print(f"  时间：{ev.get('time')}")
    print(f"  原因：{ev.get('reason')}")
    peak = ev.get("peak_mb")
    if peak:
        print(f"  峰值内存：{peak}MB")
    sess = ev.get("sessions") or []
    if sess:
        print(f"  丢失的会话（{len(sess)} 个）：")
        for s in sess:
            print(f"    └─ {s}")
    notes = ev.get("notes") or []
    for n in notes:
        print(f"  · {n}")
    print("  完整记录：ghostty-watch log")
PY
  /bin/rm -f "$_GW_DIR/pending.json" 2>/dev/null
  # 让用户处在一个干净的提示符环境
  /usr/bin/tput sgr0 2>/dev/null
fi

# ---- 2. 心跳 + 退出标记 ----
typeset -g _GW_TTY="${TTY:t}"
typeset -g _GW_PPID="$PPID"

_gw_esc() {
  # zsh 的 ${v//a/b} 里反斜杠转义不可靠（实测 \\\\ 不生效），改用 sed 做 JSON 字符串转义
  print -rn -- "$1" | /usr/bin/sed 's/\\/\\\\/g; s/"/\\"/g' 2>/dev/null
}

typeset -g _GW_LAST=""

_gw_write_beat() {
  local kind="$1"   # 运行中 -> none；主动 exit -> exit
  [[ -n "$_GW_TTY" ]] || return 0
  local last="$_GW_LAST"
  last=$(print -rn -- "$last" | /usr/bin/head -c 200)
  local e_cwd e_last
  e_cwd=$(_gw_esc "$PWD")
  e_last=$(_gw_esc "$last")
  /bin/mkdir -p "$_GW_DIR/shells" 2>/dev/null
  printf '{"pid":%d,"ppid":%s,"tty":"%s","cwd":"%s","last":"%s","exit_kind":"%s","time":"%s"}\n' \
    "$$" "${_GW_PPID:-0}" "$_GW_TTY" "$e_cwd" "$e_last" "$kind" \
    "$(/bin/date '+%Y-%m-%d %H:%M:%S')" > "$_GW_DIR/shells/$_GW_TTY.json" 2>/dev/null
  return 0
}

_gw_precmd() { _gw_write_beat none }
# last 取本 shell 真正执行过的命令（preexec 记录），不用 fc：fc 在刚开的 shell 里会读到
# 历史文件里的旧命令，把上一天的命令当成「最近执行」（2026-11-19 踩到）。
_gw_preexec() { _GW_LAST="$1" }
# 正常退出（用户在 shell 里 exit / 关窗口触发 SIGHUP 时 zsh 不会执行这里）留一条 exit 记录，
# 但**不删除文件**——监控要在进程消失后读它，删了就丢证据了。旧文件由 watch.py 定期清理。
_gw_exit()   { _gw_write_beat exit }

autoload -Uz add-zsh-hook 2>/dev/null && {
  add-zsh-hook precmd _gw_precmd
  add-zsh-hook preexec _gw_preexec
  add-zsh-hook zshexit _gw_exit
} || {
  precmd_functions+=(_gw_precmd)
  preexec_functions+=(_gw_preexec)
}

_gw_precmd
