#!/usr/bin/env bash
# pa-main-guard.sh —— 私有仓库的 local main 不许承载提交（提交 / 合并 / 变基三类入口）
#
# 为什么要：local main 只承担两件事——① 生成 worktree、② 被 origin/main 快进同步。
# 在 main 上落提交（含 merge commit、rebase 改写），之后 pa-merge 的快进就会失败、
# 要人工收拾；而且这类提交天然绕过了「分支 → 门禁 → 合并」这条唯一通路。
#
# 用法（由 ~/.config/git/hooks 下的分发器调用，见 pa-install-hooks.sh）：
#   pa-main-guard.sh            # 默认 = commit（pre-commit 入口）
#   pa-main-guard.sh merge      # pre-merge-commit 入口（git merge 生成合并提交前）
#   pa-main-guard.sh rebase     # pre-rebase 入口（git rebase / git pull --rebase）
#
# 为什么三类都要拦（2026-11-24 实测发现的漏洞）：githooks(5) 规定 pre-commit **只由
# git-commit 调用**，git-merge 走的是 `pre-merge-commit`、git-rebase 走 `pre-rebase`。
# 只装 pre-commit 时，`git merge --no-ff feat` 在 local main 上能成功建出合并提交、
# `git rebase` 能改写 main 的历史，两者零拦截（实测 exit=0）。
#
# 实现差异（诚实说明）：pi 端 `git-main-guard.ts` 在 tool 层拦 `git add` / `git commit`
# 与其余会移动 main 的子命令；这里用 git 钩子，能拦住**任何进程**（人、脚本、其它 agent）
# ——但 git 没有 pre-add / pre-reset 钩子，所以那两类只能靠 tool 层。
#
# 判据：远端仓库是私有仓库（与 pre-push 守卫同一口径、共用可见性缓存）。
# 逃生门：PA_ALLOW_COMMIT_MAIN=1（受控例外，自己承担后果）。
set -uo pipefail

[ "${PA_ALLOW_COMMIT_MAIN:-0}" = "1" ] && exit 0

MODE="${1:-commit}"
case "$MODE" in
  merge)
    ACTION="合并（会生成合并提交）"
    HOOK="pre-merge-commit"
    EXAMPLE="PA_ALLOW_COMMIT_MAIN=1 git merge ..."
    ;;
  rebase)
    ACTION="变基（会改写 main 的历史）"
    HOOK="pre-rebase"
    EXAMPLE="PA_ALLOW_COMMIT_MAIN=1 git rebase ..."
    ;;
  *)
    MODE=commit
    ACTION="提交"
    HOOK="pre-commit"
    EXAMPLE="PA_ALLOW_COMMIT_MAIN=1 git commit ..."
    ;;
esac

branch=$(git symbolic-ref --short -q HEAD 2>/dev/null) || exit 0
case "$branch" in main|master) ;; *) exit 0 ;; esac

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
remote_url=$(git -C "$repo_root" remote get-url origin 2>/dev/null || true)
[ -n "$remote_url" ] || exit 0

CACHE="${PA_VISIBILITY_CACHE:-$HOME/.pi/agent/state/repo-visibility.json}"
TTL="${PA_VISIBILITY_TTL:-86400}"
slug=$(printf '%s' "$remote_url" | sed -e 's#^git@[^:]*:##' -e 's#^https\{0,1\}://[^/]*/##' -e 's#\.git$##' -e 's#/*$##')

vis=unknown
case "$slug" in
  */*/*|"") vis=unknown ;;
  */*)
    mkdir -p "$(dirname "$CACHE")"
    vis=$(CACHE="$CACHE" SLUG="$slug" TTL="$TTL" python3 - <<'PY' 2>/dev/null
import json, os, time
cache, slug, ttl = os.environ["CACHE"], os.environ["SLUG"], int(os.environ["TTL"])
try:
    d = json.load(open(cache, encoding="utf-8"))
except Exception:
    d = {}
e = d.get(slug) or {}
if e.get("visibility") in ("private", "public") and time.time() - int(e.get("checked", 0)) < ttl:
    print(e["visibility"])
PY
)
    if [ -z "$vis" ]; then
      api=$(gh api "repos/$slug" --jq '.private' 2>/dev/null || true)
      case "$api" in
        true) vis=private ;;
        false) vis=public ;;
        *) vis=unknown ;;
      esac
      CACHE="$CACHE" SLUG="$slug" VIS="$vis" python3 - <<'PY' 2>/dev/null
import json, os, time
path, slug, vis = os.environ["CACHE"], os.environ["SLUG"], os.environ["VIS"]
try:
    d = json.load(open(path, encoding="utf-8"))
except Exception:
    d = {}
d[slug] = {"visibility": vis, "checked": int(time.time())}
with open(path, "w", encoding="utf-8") as f:
    json.dump(d, f, ensure_ascii=False, indent=2, sort_keys=True)
    f.write("\n")
PY
    fi
    ;;
  *) vis=unknown ;;
esac

[ "$vis" = "public" ] && exit 0

cat >&2 <<EOF
❌ 拒绝在 ${branch} 上${ACTION}：$([ "$vis" = "private" ] && echo "这是私有仓库" || echo "无法判定可见性，按私有处理")，
   而 local ${branch} 只承担两件事：① 生成 worktree、② 被 origin/main 快进同步。

   正确做法：
     git switch -c <分支>        # 或者先用 pa-worktree.sh <slug> 建工作树
     # 在分支上提交 / 合并 / 变基，然后
     pa-merge.sh <分支> --push   # 走门禁合入 main

   同步 main 本身用快进（不受影响）：
     git merge --ff-only origin/main
     git pull --ff-only origin main

   受控例外（仓库恢复等）：
     ${EXAMPLE}

   说明：本守卫由 git 的 ${HOOK} 钩子触发（2026-11-24 起覆盖
   commit / merge / rebase 三类入口，此前只覆盖 commit）。
EOF
exit 1
