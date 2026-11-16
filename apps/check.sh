#!/usr/bin/env bash
# 检查 App 配置是否处于一致状态（系统位置是权威源、本仓库是镜像）：
#   1. mappings.conf 里每条：系统文件存在、不是软链（旧机制残留）、内容与镜像一致
#   2. UserDefaults 快照是否与当前值有差异（差异只提示，不自动改）
#   3. 本目录本身是否有未提交改动
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAP="$REPO/mappings.conf"
fail=0

check_pair() {
  local repo_rel="$1"
  local target="$2"
  local repo_file="$REPO/$1"

  if [ ! -e "$target" ]; then
    echo "❌ $target 不存在——跑 ./install.sh 从镜像部署一次"
    fail=1
    return
  fi

  if [ -L "$target" ]; then
    echo "❌ $target 仍是软链（旧机制残留）——跑 ./install.sh 换成实体文件"
    fail=1
    return
  fi

  if [ ! -f "$repo_file" ]; then
    echo "❌ 镜像缺 ${repo_rel}——系统上有、仓库里没有，跑 ./publish.sh 收集"
    fail=1
    return
  fi

  if cmp -s "$target" "$repo_file"; then
    echo "✅ $target 与镜像一致"
  else
    echo "⚠️  $target 与镜像不同（系统改过、还没收集）——跑 ./publish.sh"
  fi
}

echo "== 配置与镜像 =="
while IFS=$'\t' read -r repo_rel sys_path mode note; do
  case "$repo_rel" in
    ''|'#'*) continue ;;
  esac
  sys_path="${sys_path/#\~/$HOME}"
  check_pair "$repo_rel" "$sys_path"
done < "$MAP"

echo
echo "== UserDefaults 快照 =="
if [ -f "$REPO/cmux/defaults.plist" ]; then
  tmp="$(mktemp)"
  python3 "$REPO/scripts/export-defaults.py" "$tmp" >/dev/null
  if diff -q "$tmp" "$REPO/cmux/defaults.plist" >/dev/null; then
    echo "✅ 与仓库快照一致"
  else
    echo "⚠️  当前值与仓库快照不同（改过设置？）——确认无误后跑 ./publish.sh 更新镜像"
  fi
  rm -f "$tmp"
else
  echo "跳过：没有 cmux/defaults.plist"
fi

echo
echo "== git 状态 =="
# 只看本目录：agents-infra 的 pi/agent/ 是发布生成物，它有待发布的改动不该算进这里。
if git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
  if [ -z "$(git -C "$REPO" status --porcelain -- .)" ]; then
    echo "✅ 本目录干净（所有改动都已提交）"
  else
    echo "⚠️  本目录有未提交改动："
    git -C "$REPO" status --porcelain -- . | sed 's/^/    /'
  fi
else
  echo "提示：仓库尚未 git init"
fi

exit "$fail"
