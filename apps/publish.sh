#!/usr/bin/env bash
# 把本机生效的 App 配置收进仓库镜像（系统位置是权威源、仓库是镜像）。
#
# 什么时候跑：改了终端设置（字体 / 主题 / 光标 / 快捷键 / cmux 偏好）之后，提交之前。
#   cd apps && ./publish.sh
# 它做三件事：按 mappings.conf 把系统文件复制回仓库 → 刷新 UserDefaults 快照 → 跑敏感检查。
# 不收进 git、不推送——确认 diff 后用正常的提交流程提交。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAP="$REPO/mappings.conf"
collisions=()

echo "== 1. 敏感检查（先查系统文件，通过才写镜像）=="
while IFS=$'\t' read -r repo_rel sys_path mode note; do
  case "$repo_rel" in
    ''|'#'*) continue ;;
  esac
  sys_path="${sys_path/#\~/$HOME}"
  [ -f "$sys_path" ] && collisions+=("$sys_path")
done < "$MAP"
python3 "$REPO/scripts/check-secrets.py" "${collisions[@]}"

echo
echo "== 2. 系统配置 → 仓库镜像 =="
while IFS=$'\t' read -r repo_rel sys_path mode note; do
  case "$repo_rel" in
    ''|'#'*) continue ;;
  esac
  sys_path="${sys_path/#\~/$HOME}"
  repo_file="$REPO/$repo_rel"

  if [ ! -f "$sys_path" ]; then
    echo "跳过：系统上没有 $sys_path"
    continue
  fi

  mkdir -p "$(dirname "$repo_file")"
  if [ -f "$repo_file" ] && cmp -s "$sys_path" "$repo_file"; then
    echo "无变化 $repo_rel"
    continue
  fi
  cp -p "$sys_path" "$repo_file"
  echo "收集 $sys_path -> ${repo_rel}（镜像）"
done < "$MAP"

echo
echo "== 3. cmux 的 UserDefaults 快照 =="
if [ -f "$REPO/scripts/export-defaults.py" ]; then
  python3 "$REPO/scripts/export-defaults.py"
else
  echo "跳过：没有 scripts/export-defaults.py"
fi

echo
echo "== 4. 仓库里的变更 =="
if [ -z "$(git -C "$REPO" status --porcelain -- .)" ]; then
  echo "✅ 镜像已与系统一致，没有待提交的改动"
else
  git -C "$REPO" status --porcelain -- . | sed 's/^/    /'
  echo
  echo "确认 diff 无误后，用团队提交流程提交（apps/ 下这些文件）。"
fi
