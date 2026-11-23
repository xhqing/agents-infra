#!/usr/bin/env bash
# pa-release.sh —— 私有仓库发版链（VERSION + CHANGELOG → 分支 → 门禁合并 → 打 tag → GitHub Release）
#
#   pa-release.sh patch                 # 0.6.1 → 0.6.2（默认）
#   pa-release.sh minor                 # 0.6.1 → 0.7.0
#   pa-release.sh major                 # 0.6.1 → 1.0.0
#   pa-release.sh patch --no-push       # 只准备（bump + 合并干跑 + 不推 tag）
#   pa-release.sh patch --notes-file f  # 指定 Release 说明文件
#
# 与公开仓库的 /bump → /add → /commit → /release 对应，但**不让发版绕过门禁**：
# 版本号改动走「release/v<x.y.z> 分支 → pa-merge.sh（检查全过）→ 合并提交 → 在合并提交上打 tag」。
# 前置条件：工作树干净、根有 VERSION、CHANGELOG.md 里已有本版条目（没有就停下让你先写）。
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BUMP="${1:-patch}"
shift || true
PUSH=1
NOTES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-push) PUSH=0 ;;
    --notes-file) NOTES="${2:?}"; shift ;;
    *) echo "❌ 未知参数：$1" >&2; exit 1 ;;
  esac
  shift
done
case "$BUMP" in major|minor|patch) ;; *) echo "❌ 第一参数必须是 major / minor / patch" >&2; exit 1 ;; esac

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "❌ 不在 git 仓库里" >&2; exit 1; }
cd "$REPO_ROOT" || exit 1
[ -f VERSION ] || { echo "❌ 没有 VERSION 文件：本项目不适用发版链" >&2; exit 1; }
[ -n "$(git status --porcelain)" ] && { echo "❌ 工作树要干净（先提交或清掉改动）" >&2; git status --short >&2; exit 1; }

cur=$(tr -d '[:space:]' < VERSION)
IFS=. read -r maj min pat <<< "$cur"
case "$BUMP" in
  major) maj=$((maj + 1)); min=0; pat=0 ;;
  minor) min=$((min + 1)); pat=0 ;;
  patch) pat=$((pat + 1)) ;;
esac
new="$maj.$min.$pat"
tag="v$new"

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "❌ 标签 $tag 已存在" >&2; exit 1
fi
if ! grep -qE "^#+ *\[?${new//./\\.}\]?" CHANGELOG.md 2>/dev/null; then
  echo "❌ CHANGELOG.md 里没有 ${new} 的条目。先写好（例如「## ${new} — $(date +%Y-%m-%d)」+ 改动说明），再发版。" >&2
  echo "   当前 VERSION=${cur}；本次要发的是 ${new}。" >&2
  exit 1
fi

branch="release/v$new"
git fetch -q origin
echo "── 准备分支 ${branch}（${cur} → ${new}）──"
git switch -q -c "$branch"
printf '%s\n' "$new" > VERSION
git add VERSION
PA_ALLOW_COMMIT_MAIN=1 git commit -q -m "chore(release): v$new"
echo "✅ 已提交版本号 bump"

if [ "$PUSH" = "1" ]; then
  echo "── 走门禁合并（pa-merge.sh）──"
  "$SELF_DIR/pa-merge.sh" "$branch" --push --shared || { echo "❌ 合并门禁未通过，未打 tag、未发布" >&2; exit 1; }
else
  echo "── 门禁干跑（--no-push）──"
  "$SELF_DIR/pa-merge.sh" "$branch" --shared || { echo "❌ 门禁干跑未通过" >&2; exit 1; }
  echo "（--no-push：跳过打 tag 与 Release）"
  exit 0
fi

git fetch -q origin
echo "── 在合并提交上打 tag $tag ──"
git tag -a "$tag" -m "release $new" origin/main
if PA_MERGE_GATE=1 git push -q origin "refs/tags/$tag"; then
  echo "✅ 标签已推：$tag → $(git rev-parse --short "$tag")"
else
  echo "❌ 标签推送失败" >&2; exit 1
fi

if command -v gh >/dev/null 2>&1 && [[ "$(git remote get-url origin)" == *github.com* ]]; then
  if [ -n "$NOTES" ] && [ -f "$NOTES" ]; then
    gh release create "$tag" --title "$tag" --notes-file "$NOTES" >/dev/null 2>&1 \
      && echo "✅ GitHub Release 已建：${tag}（notes: ${NOTES}）" \
      || echo "⚠️ Release 创建失败（tag 已推，可稍后手动 gh release create）" >&2
  else
    gh release create "$tag" --title "$tag" --generate-notes >/dev/null 2>&1 \
      && echo "✅ GitHub Release 已建：${tag}（自动生成 notes）" \
      || echo "⚠️ Release 创建失败（tag 已推，可稍后手动 gh release create）" >&2
  fi
fi

echo "── 收尾 ──"
git switch -q main 2>/dev/null && git merge --ff-only -q origin/main 2>/dev/null \
  && echo "✅ local main 已对齐 $(git rev-parse --short main)" || echo "⚠️ local main 未对齐，手动：git switch main && git merge --ff-only origin/main"
echo "发版完成：${cur} → ${new}（tag ${tag}）"
