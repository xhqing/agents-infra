#!/usr/bin/env bash
# 全局 pre-push 守卫：私有仓库的 main 锁 + tag 不可改写（工具强制，钩子层）。
#
# 判定依据（唯一）：**远端仓库是不是私有仓库**。
#   - 私有仓库 → main 只能经 `pa-merge.sh` 合入；tag 一旦推出不许移动 / 删除
#   - 公开仓库 → 不管（那是 GitHub 服务端 branch protection + CI 的范围）
#   - 判定不出来（离线 / 无 gh / 非 GitHub 远端）→ 按私有处理（fail-closed），
#     受控例外用 `PA_MERGE_GATE=1`
#
# 为什么本地拦：GitHub Free 的私有仓库没有 branch protection（403 Upgrade to GitHub Pro），
# 服务端不会替我们挡。
#
# 放行条件：环境变量 PA_MERGE_GATE=1（只有 `pa-merge.sh` 会设）。
# 另外仍会委派给仓库自己的 `.githooks/pre-push`（项目级附加规则）。
set -uo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
ZERO="0000000000000000000000000000000000000000"
gate="${PA_MERGE_GATE:-0}"

REMOTE_NAME="${1:-origin}"
REMOTE_URL="${2:-}"
CACHE="${PA_VISIBILITY_CACHE:-$HOME/.pi/agent/state/repo-visibility.json}"
TTL_SECONDS="${PA_VISIBILITY_TTL:-86400}"

slugify() {
  # git@github.com:OWNER/REPO.git → OWNER/REPO ; https://github.com/OWNER/REPO → OWNER/REPO
  printf '%s' "$1" | sed -e 's#^git@[^:]*:##' -e 's#^https\{0,1\}://[^/]*/##' \
    -e 's#\.git$##' -e 's#/*$##'
}

visibility() {
  # 输出 private / public / unknown
  local slug vis now
  slug="$(slugify "$REMOTE_URL")"
  # 只处理 GitHub 的 owner/repo（本地裸仓、file:// 等一律 unknown → 按私有对待）
  case "$slug" in
    ""|*/*/*) echo unknown; return ;;
    */*) ;;
    *) echo unknown; return ;;
  esac
  mkdir -p "$(dirname "$CACHE")"
  now=$(date +%s)
  vis=$(CACHE="$CACHE" SLUG="$slug" NOW="$now" TTL="$TTL_SECONDS" python3 - <<'PY' 2>/dev/null
import json, os
cache = os.environ.get("CACHE")
slug = os.environ["SLUG"]
now = int(os.environ["NOW"])
ttl = int(os.environ["TTL"])
try:
    d = json.load(open(cache, encoding="utf-8"))
except Exception:
    d = {}
e = d.get(slug) or {}
if e.get("visibility") and now - int(e.get("checked", 0)) < ttl:
    print(e["visibility"])
PY
)
  if [ -n "$vis" ]; then echo "$vis"; return; fi

  local api
  api="$(gh api "repos/$slug" --jq '.private' 2>/dev/null)"
  case "$api" in
    true) vis=private ;;
    false) vis=public ;;
    *) vis=unknown ;;
  esac
  CACHE="$CACHE" SLUG="$slug" VIS="$vis" NOW="$now" python3 - <<'PY' 2>/dev/null
import json, os
path = os.environ["CACHE"]
try:
    d = json.load(open(path, encoding="utf-8"))
except Exception:
    d = {}
d[os.environ["SLUG"]] = {"visibility": os.environ["VIS"], "checked": int(os.environ["NOW"])}
with open(path, "w", encoding="utf-8") as f:
    json.dump(d, f, ensure_ascii=False, indent=2, sort_keys=True)
    f.write("\n")
PY
  echo "$vis"
}

VIS="$(visibility)"

if [ "$VIS" = "public" ]; then
  # 公开仓库：由 GitHub 服务端的 branch protection + CI 负责
  exit 0
fi

status=0
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -z "${remote_ref:-}" ] && continue
  case "$remote_ref" in
    refs/heads/main|refs/heads/master)
      if [ "$gate" != "1" ]; then
        cat >&2 <<EOF
❌ 拒绝直推 $(basename "$remote_ref")：这个远端是**私有仓库**（或无法判定可见性），
   私有仓库的 main 只能经门禁合入。

   正确做法：
     pa-merge.sh <分支名> --push        # 门禁 = 基于最新 origin/main 合并 + 仓库 checks.sh

   受控例外（建仓首次推送、仓库恢复）：
     PA_MERGE_GATE=1 git push origin <ref>:main

   为什么本地拦：GitHub Free 的私有仓库没有 branch protection（403 Upgrade to Pro），
   服务端不会替我们挡。公开仓库不受此限制（由 GitHub 的规则与 CI 负责）。
EOF
        status=1
      elif [ "$local_sha" = "$ZERO" ]; then
        echo "❌ 拒绝删除 main：删分支请在仓库设置里操作" >&2
        status=1
      elif [ "$remote_sha" != "$ZERO" ] && ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
        echo "❌ 拒绝非快进推 main：先 fetch 再重新合并（pa-merge.sh 会自己做），不要强推" >&2
        status=1
      fi
      ;;
    refs/tags/*)
      if [ "${PA_ALLOW_TAG_REWRITE:-0}" = "1" ]; then
        :
      elif [ "$remote_sha" != "$ZERO" ] && [ "$local_sha" = "$ZERO" ]; then
        echo "❌ 拒绝删除标签 $(basename "$remote_ref")：已发布的标签不可删除" >&2
        status=1
      elif [ "$remote_sha" != "$ZERO" ] && [ "$local_sha" != "$remote_sha" ]; then
        echo "❌ 拒绝移动标签 $(basename "$remote_ref")：标签一旦推出去就指向固定提交" >&2
        echo "   要发新版请新建标签；受控例外 PA_ALLOW_TAG_REWRITE=1" >&2
        status=1
      fi
      ;;
  esac
done

if [ -x "$repo_root/.githooks/pre-push" ]; then
  "$repo_root/.githooks/pre-push" || status=1
fi

exit "$status"
