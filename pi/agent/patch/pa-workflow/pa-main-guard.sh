#!/usr/bin/env bash
# pa-main-guard.sh —— 私有仓库的 local main 不许承载提交（pre-commit 阶段拦截）
#
# 为什么要：local main 只承担两件事——① 生成 worktree、② 被 origin/main 快进同步。
# 在 main 上提交，之后 pa-merge 的快进就会失败、要人工收拾；而且这类提交天然绕过了
# 「分支 → 门禁 → 合并」这条唯一通路。
#
# 实现差异（诚实说明）：pi 端 `git-main-guard.ts` 在 tool 层拦 `git add` / `git commit`；
# 这里用 git 钩子，能拦住**任何进程**（人、脚本、其它 agent）——但 git 没有 pre-add 钩子，
# 所以只能拦 commit。
#
# 判据：远端仓库是私有仓库（与 pre-push 守卫同一口径、共用可见性缓存）。
# 逃生门：PA_ALLOW_COMMIT_MAIN=1（受控例外，自己承担后果）。
set -uo pipefail

[ "${PA_ALLOW_COMMIT_MAIN:-0}" = "1" ] && exit 0

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
❌ 拒绝在 ${branch} 上提交：$([ "$vis" = "private" ] && echo "这是私有仓库" || echo "无法判定可见性，按私有处理")，
   而 local ${branch} 只承担两件事：① 生成 worktree、② 被 origin/main 快进同步。

   正确做法：
     git switch -c <分支>        # 或者先用 pa-worktree.sh <slug> 建工作树
     # 在分支上提交，然后
     pa-merge.sh <分支> --push   # 走门禁合入 main

   受控例外（仓库恢复等）：
     PA_ALLOW_COMMIT_MAIN=1 git commit ...
EOF
exit 1
