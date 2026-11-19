#!/usr/bin/env bash
# screen-record —— macOS 系统自带录屏的统一入口
#
# 子命令：
#   check              只做权限检测（输出 PERM=ok / PERM=denied 与授权主体）
#   start [选项]       后台开始录制，打印输出文件与停止命令
#   stop               停止当前录制（优雅收尾，等文件落盘完成）
#   status             查看当前是否在录
#   list [数量]        列出最近的录制产物
#   devices            列出可用音频输入设备（-G 用的 id 需要设备名匹配）
#
# start 选项：
#   --area x,y,w,h     只录这块矩形（全局显示坐标，单位是「点」；Retina 下成片是 2 倍像素）
#   --display N        只录第 N 块显示器（1 = 主屏）
#   --window ID        只录指定窗口（窗口 id 用 scripts/win.sh 查）
#   --audio            同时录麦克风（默认输入设备）
#   --audio-dev NAME   同时录指定音频设备（NAME 用 devices 子命令查）
#   --duration SEC     录满 SEC 秒自动停止（不填 = 手动 stop 才停）
#   --clicks           在视频里标出鼠标点击位置（做教程很有用）
#   --cursor           视频里带上鼠标指针
#   --out PATH         指定输出文件路径
#   --direct           不走 tmux，直接在当前进程后台跑（诊断用：TCC 主体可能不同）
#
# 退出码：0 成功；2 屏幕录制权限缺失；3 已有录制在进行；其它见错误信息

set -uo pipefail

STATE_DIR="${TMPDIR:-/tmp}/screen-record"
OUT_DIR="${SCREEN_RECORD_DIR:-$HOME/Movies/screen-recordings}"
CURRENT="$STATE_DIR/current"          # 记录当前录制（每次只有一条）
mkdir -p "$STATE_DIR" "$OUT_DIR"

die()  { printf '错误：%s\n' "$*" >&2; exit "${2:-1}"; }
say()  { printf '%s\n' "$*"; }

# ---------- 找出「谁在跑我」的 App 身份（授权时要勾的那个 App） ----------
app_owner_bundle() {
  local p=${PPID:-$$} comm app i=0
  while [ "$i" -lt 20 ]; do
    comm=$(ps -o comm= -p "$p" 2>/dev/null) || return 1
    case "$comm" in
      *.app/Contents/MacOS/*)
        app="${comm%%/Contents/MacOS/*}"
        defaults read "$app/Contents/Info.plist" CFBundleIdentifier 2>/dev/null && return 0
        ;;
    esac
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    [ -z "$p" ] && return 1
    [ "$p" = "0" ] && return 1
    i=$((i + 1))
  done
  return 1
}

# ---------- 权限检测：真跑一次截图，失败即无权限 ----------
# 不查 TCC 数据库（用户级库通常读不到），端到端试一次最可信。
PERM_CACHE="$STATE_DIR/perm-cache"

# 探测被拒时系统会弹授权窗。连续探测 = 连续弹窗骚扰用户，
# 所以「拒绝」结论缓存 60 秒：一时失败不必反复试探，等用户处理完再试。
cached_denied() {
  [ -f "$PERM_CACHE" ] || return 2
  local ts
  ts=$(sed -n 's/^ts=//p' "$PERM_CACHE")
  [ -z "$ts" ] && return 2
  [ $(( $(date +%s) - ts )) -gt 60 ] && return 2
  return 1
}

check_perm() {
  local force="${1:-0}"
  if [ "$force" != "1" ]; then
    cached_denied
    if [ "$?" = "1" ]; then
      say "PERM=denied"
      say "NOTE=60 秒内已探测过（不再重复请求，避免连环弹窗）"
      return 1
    fi
  fi
  local probe="$STATE_DIR/.probe-$$.png" err rc
  rm -f "$probe"
  err=$(screencapture -x "$probe" 2>&1); rc=$?
  if [ "$rc" -ne 0 ] || [ ! -s "$probe" ]; then
    rm -f "$probe"
    printf 'ts=%s\n' "$(date +%s)" > "$PERM_CACHE"
    say "PERM=denied"
    say "OWNER=$(app_owner_bundle || echo unknown)"
    [ -n "${err:-}" ] && say "DETAIL=$err"
    return 1
  fi
  # 有权限也可能录到全黑（屏幕被锁 / 显示器休眠），粗查一下亮度
  local dark=""
  if command -v python3 >/dev/null 2>&1; then
    dark=$(python3 - "$probe" <<'PY' 2>/dev/null
import sys
try:
    from PIL import Image
    im = Image.open(sys.argv[1]).convert('RGB')
    px = list(im.resize((32, 20)).getdata())
    print('dark' if len(set(px)) <= 2 and sum(sum(c) for c in px) < 2000 else 'ok')
except Exception:
    print('ok')
PY
)
  fi
  rm -f "$probe"
  rm -f "$PERM_CACHE"
  say "PERM=ok"
  say "OWNER=$(app_owner_bundle || echo unknown)"
  [ "$dark" = "dark" ] && say "NOTE=屏幕内容接近全黑，可能显示器休眠或被锁屏"
  return 0
}

perm_hint() {
  local owner
  owner=$(app_owner_bundle 2>/dev/null || echo "unknown")
  cat >&2 <<EOF

没有屏幕录制权限，录不了。一次性授权步骤：

  1. 打开 系统设置 → 隐私与安全性 → 屏幕录制
  2. 把当前跑命令的这个 App 打开（识别到的是：${owner}）
     列表里没有它，就点「+」从 /Applications 选中加入
  3. 授权后**完全退出该 App 再重开**（Cmd+Q 关掉，不是关窗口）——
     macOS 只在进程启动时读权限，不重启不生效

授权一次之后，后续所有录屏都能自动跑。
EOF
  if [ "$owner" = "unknown" ]; then
    cat >&2 <<'EOF'
（识别不出宿主 App 时：如果你在终端里跑，授权 Terminal / iTerm / cmux；
 在 pi 会话里跑，授权承载该会话的终端 App。）
EOF
  fi
}

# ---------- 音频设备 ----------
list_devices() {
  # screencapture -G 要的是「音频设备名」，不是数字 id
  system_profiler SPAudioDataType 2>/dev/null \
    | awk '/^[[:space:]]{8}[^:]+:$/ { name=$0; gsub(/^[[:space:]]+|:$/,"",name); dev=name }
           /Default Input Device: Yes/ { print "默认输入: " dev }
           /Input Channels:/ { print "  输入设备: " dev }' \
    | sort -u
  say ""
  say "提示：-G 直接传设备名，例如 --audio-dev 'MacBook Air Microphone'"
}

# ---------- 录制状态 ----------
read_current() { [ -f "$CURRENT" ] && cat "$CURRENT"; }

is_running() {
  local f pid
  f=$(read_current)
  [ -z "$f" ] && return 1
  pid=$(awk -F= '/^pid=/{print $2}' "$f")
  [ -z "$pid" ] && return 1
  kill -0 "$pid" 2>/dev/null || return 1
  # 确认还是那个 screencapture（pid 可能被复用）
  ps -o comm= -p "$pid" 2>/dev/null | grep -q screencapture || return 1
  return 0
}

# ---------- start ----------
AREA=""; DISPLAY_ID=""; WINDOW_ID=""; AUDIO=0; AUDIO_DEV=""
DURATION=""; CLICKS=0; CURSOR=0; OUT=""; DIRECT=0

parse_start_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --area)       AREA="${2:-}"; shift 2 ;;
      --display)    DISPLAY_ID="${2:-}"; shift 2 ;;
      --window)     WINDOW_ID="${2:-}"; shift 2 ;;
      --audio)      AUDIO=1; shift ;;
      --audio-dev)  AUDIO=1; AUDIO_DEV="${2:-}"; shift 2 ;;
      --duration)   DURATION="${2:-}"; shift 2 ;;
      --clicks)     CLICKS=1; shift ;;
      --cursor)     CURSOR=1; shift ;;
      --out)        OUT="${2:-}"; shift 2 ;;
      --direct)     DIRECT=1; shift ;;
      *) die "未知选项：$1（用法见 SKILL.md）" ;;
    esac
  done
}

do_start() {
  if is_running; then
    local cur; cur=$(read_current)
    die "已经在录了（$(printf '%s\n' "$cur" | sed -n 's/^file=//p')），先 stop" 3
  fi
  if ! check_perm >/dev/null 2>&1; then
    perm_hint
    exit 2
  fi

  [ -z "$OUT" ] && OUT="$OUT_DIR/rec-$(date +%Y%m%d-%H%M%S).mov"
  case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
  mkdir -p "$(dirname "$OUT")" || die "输出目录建不了：$(dirname "$OUT")"

  local args=(-v -x)
  [ -n "$AREA" ]      && args+=(-R "$AREA")
  [ -n "$DISPLAY_ID" ] && args+=(-D "$DISPLAY_ID")
  [ -n "$WINDOW_ID" ] && args+=(-l "$WINDOW_ID")
  [ "$AUDIO" = "1" ]  && args+=(-g)
  [ -n "$AUDIO_DEV" ] && args+=(-G "$AUDIO_DEV")
  [ "$CLICKS" = "1" ] && args+=(-k)
  [ "$CURSOR" = "1" ] && args+=(-C)
  [ -n "$DURATION" ]  && args+=(-V "$DURATION")
  args+=("$OUT")

  local stamp runner sess pidfile exitfile logfile pid
  stamp=$(date +%Y%m%d-%H%M%S)
  sess="pi-rec-$stamp"
  pidfile="$STATE_DIR/$sess.pid"
  exitfile="$STATE_DIR/$sess.exit"
  logfile="$STATE_DIR/$sess.log"
  runner="$STATE_DIR/$sess.sh"

  # runner 里把 screencapture 的 pid 记下来，stop 才有东西可发信号
  cat > "$runner" <<EOF
#!/bin/bash
screencapture $(printf '%q ' "${args[@]}") &
child=\$!
echo "\$child" > $(printf '%q' "$pidfile")
wait \$child
echo "\$?" > $(printf '%q' "$exitfile")
EOF
  chmod +x "$runner"

  if [ "$DIRECT" = "1" ]; then
    # 诊断用：不进 tmux。有的机器上 tmux 里的进程拿不到 TCC 授权，这条能区分是权限问题还是环境问题
    nohup "$runner" >"$logfile" 2>&1 &
    pid=$!
    for _ in $(seq 1 40); do [ -s "$pidfile" ] && break; sleep 0.05; done
  else
    command -v tmux >/dev/null 2>&1 || die "没装 tmux（装一个，或加 --direct）"
    tmux new-session -d -s "$sess" "exec $(printf '%q' "$runner")" >/dev/null 2>&1 \
      || die "tmux 会话启动失败：$sess"
    for _ in $(seq 1 60); do [ -s "$pidfile" ] && break; sleep 0.05; done
  fi

  pid=$(cat "$pidfile" 2>/dev/null)
  [ -z "$pid" ] && { perm_hint; die "录制进程没起来"; }

  cat > "$CURRENT" <<EOF
file=$OUT
pid=$pid
session=$sess
runner=$runner
pidfile=$pidfile
exitfile=$exitfile
started=$(date +%Y-%m-%dT%H:%M:%S)
mode=$([ "$DIRECT" = "1" ] && echo direct || echo tmux)
params=$(printf '%s ' "${args[@]}")
EOF

  # 起来不等于在写（可能被静默拒绝），等文件出现
  for _ in $(seq 1 60); do [ -s "$OUT" ] && break; sleep 0.1; done
  sleep 0.3
  if [ ! -s "$OUT" ]; then
    kill -INT "$pid" 2>/dev/null
    [ "$DIRECT" != "1" ] && tmux kill-session -t "$sess" 2>/dev/null
    rm -f "$CURRENT"
    perm_hint
    die "录制启动后没有产生数据——多半是权限没给到承载命令的 App"
  fi

  say "录制中"
  say "  文件：$OUT"
  say "  进程：$pid"
  [ -n "$DURATION" ] && say "  时长：${DURATION}s 后自动停止" || say "  停止：bash $SELF_DIR/record.sh stop"
}

# ---------- stop ----------
do_stop() {
  local f pid sess
  f=$(read_current)
  if [ -z "$f" ]; then
    is_running || { say "当前没有在录"; return 0; }
    die "状态文件丢了，请手动 kill 掉 screencapture 进程"
  fi
  pid=$(awk -F= '/^pid=/{print $2}' "$f")
  sess=$(awk -F= '/^session=/{print $2}' "$f")
  local out exitfile
  out=$(awk -F= '/^file=/{print substr($0,6)}' "$f")
  exitfile=$(awk -F= '/^exitfile=/{print substr($0,10)}' "$f")

  if ! kill -0 "$pid" 2>/dev/null; then
    say "录制进程已结束"
  else
    # SIGINT 是 screencapture 正常收尾信号：它会写完 moov atom 再退出，
    # 直接 SIGKILL 会留下无法播放的残片
    kill -INT "$pid" 2>/dev/null
    for _ in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -0 "$pid" 2>/dev/null && { say "正常信号没停住，改用 SIGTERM"; kill -TERM "$pid" 2>/dev/null; sleep 1; }
  fi

  [ -n "$sess" ] && tmux kill-session -t "$sess" 2>/dev/null
  rm -f "$CURRENT"

  if [ -s "${out:-/nonexistent}" ]; then
    local size dur
    size=$(du -h "$out" | awk '{print $1}')
    dur=""
    command -v ffprobe >/dev/null 2>&1 && \
      dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out" 2>/dev/null | cut -d. -f1)
    say "已保存：$out （$size${dur:+，约 ${dur} 秒}）"
    # 文件太小通常是没录到东西
    [ "$(stat -f%z "$out")" -lt 20000 ] && say "⚠️ 文件异常小，可能没录到画面（检查权限 / 是否锁屏）"
  else
    die "没找到录制文件，可能没录成功"
  fi
}

# ---------- status / list ----------
do_status() {
  if is_running; then
    local f; f=$(read_current)
    say "状态：录制中"
    say "  文件：$(awk -F= '/^file=/{print substr($0,6)}' "$f")"
    say "  进程：$(awk -F= '/^pid=/{print $2}' "$f")"
    say "  开始：$(awk -F= '/^started=/{print $2}' "$f")"
    local out; out=$(awk -F= '/^file=/{print substr($0,6)}' "$f")
    [ -s "$out" ] && say "  当前大小：$(du -h "$out" | awk '{print $1}')"
  else
    say "状态：未在录制"
    [ -n "$(read_current)" ] && say "（有一条残留状态记录，跑 stop 收尾）"
  fi
}

do_list() {
  local n="${1:-10}"
  say "录制目录：$OUT_DIR"
  ls -lt "$OUT_DIR" 2>/dev/null | head -n $((n + 1)) || say "（空）"
}

# ---------- dispatch ----------
cmd="${1:-check}"; shift 2>/dev/null || true
case "$cmd" in
  check)
    # 默认尊重 60 秒缓存：避免为了「看一眼状态」又把系统弹窗招出来。
    # 真要重新实测（比如确认授权到底有没有生效）加 --force。
    if [ "${1:-}" = "--force" ]; then check_perm 1; else check_perm; fi
    ;;
  start)   parse_start_args "$@"; do_start ;;
  stop)    do_stop ;;
  status)  do_status ;;
  list)    do_list "$@" ;;
  devices) list_devices ;;
  -h|--help|help) sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *) die "未知子命令：${cmd}（check / start / stop / status / list / devices）" ;;
esac
