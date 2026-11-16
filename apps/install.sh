#!/usr/bin/env bash
# 把仓库里的镜像部署到这台机器上（新机器恢复用）：按 mappings.conf 逐条复制到系统位置，
# 写回 UserDefaults 快照，提示重载。
#
# 方向：仓库是镜像、系统位置是权威源。部署只做一次性复制，**不建软链**——
# 软链会在程序原子写（写临时文件再 rename）时被替换成普通文件，之后仓库就不再跟着变。
#
# 新机器上的用法（clone 之后）：
#   cd apps && ./install.sh
#
# 脚本是幂等的：目标已是同样的内容就跳过；内容不同则先备份成 xxx.bak.<时间戳>。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAP="$REPO/mappings.conf"

# deploy <仓库内相对路径> <系统目标路径> <权限|->
deploy() {
  local src="$REPO/$1"
  local dst="$2"
  local mode="$3"

  if [ ! -e "$src" ]; then
    echo "跳过：镜像里没有 $1"
    return 0
  fi

  mkdir -p "$(dirname "$dst")"

  # 旧版本（仓库为权威、软链进系统）留下的软链：直接换成实体副本
  if [ -L "$dst" ]; then
    rm "$dst"
    echo "移除旧软链 ${dst}（改为实体文件）"
  elif [ -e "$dst" ]; then
    if cmp -s "$src" "$dst"; then
      [ "$mode" != "-" ] && [ -n "$mode" ] && chmod "$mode" "$dst"
      echo "已一致 $dst"
      return 0
    fi
    local bak="$dst.bak.$(date +%Y%m%d-%H%M%S)"
    mv "$dst" "$bak"
    echo "备份 $dst -> $bak"
  fi

  cp "$src" "$dst"
  if [ "$mode" != "-" ] && [ -n "$mode" ]; then
    chmod "$mode" "$dst"
  fi
  echo "部署 $dst"
}

echo "== 1. 按 App 部署配置 =="
while IFS=$'\t' read -r src dst mode note; do
  case "$src" in
    ''|'#'*) continue ;;
  esac
  dst="${dst/#\~/$HOME}"
  [ -n "$note" ] && echo "  ($note)"
  deploy "$src" "$dst" "$mode"
done < "$MAP"

echo
echo "== 2. cmux 的 UserDefaults 快照 =="
if [ -f "$REPO/cmux/defaults.plist" ]; then
  python3 "$REPO/scripts/apply-defaults.py"
else
  echo "跳过：镜像里没有 cmux/defaults.plist"
fi

echo
echo "== 3. 生效 =="
if command -v cmux >/dev/null 2>&1; then
  cmux reload-config >/dev/null 2>&1 && echo "已执行 cmux reload-config" || echo "提示：cmux reload-config 失败，可手动重载"
else
  echo "提示：本机尚未安装 cmux，装好后执行 cmux reload-config"
fi

echo
echo "完成。"
