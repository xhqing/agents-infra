#!/bin/bash
# ghostty-watch 安装 / 卸载
#
#   install.sh            安装 LaunchAgent + 往 ~/.zshrc 挂 shell hook（幂等）
#   install.sh --uninstall 卸载（保留事件日志）
#   install.sh --status    看运行状态
#
# 只在本机生效：ghostty 是 GUI app，macmini 上不存在，装上去也只是空跑。

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.xhq.ghostty-watch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ZSHRC="$HOME/.zshrc"
HOOK_LINE="[[ -r \"$HERE/shell-hook.zsh\" ]] && source \"$HERE/shell-hook.zsh\""
BEGIN_MARK="# >>> ghostty-watch >>>"
END_MARK="# <<< ghostty-watch <<<"
PY=/usr/bin/python3
STATE_DIR="${GHOSTTY_WATCH_STATE:-$HOME/.local/state/ghostty-watch}"

die() { echo "[ERR] $*" >&2; exit 1; }

case "${1:-install}" in
  --status)
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && echo "LaunchAgent: 已加载" || echo "LaunchAgent: 未加载"
    "$PY" "$HERE/watch.py" status
    exit 0
    ;;
  --uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
    rm -f "$PLIST"
    if [[ -f "$ZSHRC" ]]; then
      "$PY" - "$ZSHRC" "$BEGIN_MARK" "$END_MARK" <<'PY'
import sys
path, begin, end = sys.argv[1:4]
lines = open(path).read().splitlines(keepends=True)
out, skip = [], False
for ln in lines:
    if ln.strip() == begin:
        skip = True
        continue
    if ln.strip() == end:
        skip = False
        continue
    if not skip:
        out.append(ln)
open(path, "w").writelines(out)
PY
    fi
    echo "[OK] 已卸载 LaunchAgent 与 .zshrc hook（事件日志保留在 ${STATE_DIR}）"
    exit 0
    ;;
esac

[[ -x "$PY" ]] || die "找不到 $PY"
[[ -f "$HERE/watch.py" ]] || die "缺少 watch.py"
[[ -d /Applications/Ghostty.app ]] || echo "[WARN] 没找到 /Applications/Ghostty.app —— 仍会安装，但没有 ghostty 时只空跑"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$STATE_DIR"

# 1) LaunchAgent
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$HERE/watch.py</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/ghostty-watch.out.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/ghostty-watch.err.log</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null || die "plist 校验失败"

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
launchctl bootstrap "gui/$(id -u)" "$PLIST" || die "LaunchAgent 加载失败"
echo "[OK] LaunchAgent 已加载（${LABEL}）"

# 2) .zshrc hook（幂等：先把旧的块删掉再追加）
touch "$ZSHRC"
"$PY" - "$ZSHRC" "$BEGIN_MARK" "$END_MARK" <<'PY'
import sys
path, begin, end = sys.argv[1:4]
lines = open(path).read().splitlines(keepends=True)
out, skip = [], False
for ln in lines:
    if ln.strip() == begin:
        skip = True
        continue
    if ln.strip() == end:
        skip = False
        continue
    if not skip:
        out.append(ln)
open(path, "w").writelines(out)
PY
{
  echo ""
  echo "$BEGIN_MARK"
  echo "$HOOK_LINE"
  echo "$END_MARK"
} >> "$ZSHRC"
echo "[OK] 已挂到 ~/.zshrc（已开着的 shell 需要新开一个才生效）"

echo ""
echo "试试看："
echo "  $HERE/watch.py status      # 当前 ghostty 与各会话"
echo "  $HERE/watch.py log         # 历史事件"
echo "  $HERE/install.sh --status  # 运行状态"
