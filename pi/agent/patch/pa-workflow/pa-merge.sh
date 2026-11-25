#!/usr/bin/env bash
# pa-merge.sh —— 私有仓库的合并门禁（替代 private / GitHub Free 拿不到的 strict + auto-merge）
#
#   pa-merge.sh <分支名>                 # 干跑：合并 + 跑门禁检查，main 不动
#   pa-merge.sh <分支名> --push          # 全部通过才 push 到 main，并快进 local main
#   pa-merge.sh <分支名> --push --shared # 允许改共用文件（Leader 自己改基础代码时用）
#
# 适用对象：**私有仓库**（公开仓库走 GitHub 的 PR + CI + strict + auto-merge，不用本脚本）。
# 等价关系（公开仓用服务端机制，私有仓用本地工具强制）：
#   required status checks  → 合并后跑仓库的 checks.sh（缺文件直接拦，等同「没配 CI 不许合」）
#   strict（必须基于最新 base）→ 每次 git fetch，在刚拉下来的 origin/main 上合并，main 变了就重来
#   auto-merge               → 唯一入口串行 push，被拒自动 fetch 重做（最多 3 次）
#   --push 时总是先把分支快照推到 origin（全局统一，非按项目开关）
#   冲突进不了 main           → 合并失败就地报冲突文件并中止；main 一个字节都不动
#   禁止直推 main             → pre-push 守卫只认本脚本设的 PA_MERGE_GATE=1
#
# 仓库侧约定（最小）：在仓库根放一个 checks.sh（或 .pi/checks.sh），声明「检查什么」。
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

BRANCH=""
PUSH=0
SHARED=0
REPO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --push) PUSH=1 ;;
    --shared) SHARED=1 ;;
    --repo) REPO="${2:?--repo 需要路径}"; shift ;;
    -h|--help) usage 0 ;;
    -*) echo "❌ 未知参数：$1" >&2; usage 2 ;;
    *) BRANCH="$1" ;;
  esac
  shift
done
[ -n "$BRANCH" ] || usage 2

if [ -n "$REPO" ]; then cd "$REPO" || exit 1; fi
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "❌ 不在 git 仓库里" >&2; exit 1; }
cd "$REPO_ROOT" || exit 1

# 门禁脚本位置：仓库根 checks.sh 优先，兼容两种历史位置。
# 先看被合并的分支（权威：要跑的是那条分支的检查），再看当前工作区。
CHECKS=""
for c in checks.sh .pi/checks.sh .pi-alt/checks.sh; do
  if git cat-file -e "$BRANCH:$c" 2>/dev/null; then CHECKS="$c"; break; fi
done
if [ -z "$CHECKS" ]; then
  for c in checks.sh .pi/checks.sh .pi-alt/checks.sh; do
    if [ -f "$REPO_ROOT/$c" ]; then CHECKS="$c"; break; fi
  done
fi
if [ -z "$CHECKS" ] && [ "${PA_ALLOW_NO_CHECKS:-0}" != "1" ]; then
  echo "❌ 缺 checks.sh：门禁必须知道「检查什么」。" >&2
  echo "   最少写一行，例如：  printf '#!/usr/bin/env bash\\npython3 src/selftest.py\\n' > checks.sh" >&2
  echo "   临时跳过（不推荐，仅在建仓初期）：PA_ALLOW_NO_CHECKS=1 pa-merge.sh ..." >&2
  exit 1
fi

git show-ref --verify --quiet "refs/heads/$BRANCH" || { echo "❌ 没有这个分支：$BRANCH" >&2; exit 1; }

# 单 pusher 纪律（多机同步时只有一台机器有推送权，避免两机同时推 main 互相打架）
PUSHER_FILE="${PA_PUSHER_FILE:-$HOME/.dev/private/.state/pa-pusher.json}"
machine_name() { scutil --get ComputerName 2>/dev/null || hostname -s 2>/dev/null || echo unknown; }
if [ "$PUSH" = "1" ]; then
  me="$(machine_name)"
  mkdir -p "$(dirname "$PUSHER_FILE")"
  if [ ! -f "$PUSHER_FILE" ]; then
    printf '{\n  "machine": "%s",\n  "note": "私有仓库单 pusher：只有这台机器能 push main（pa-merge.sh 强制）"\n}\n' "$me" > "$PUSHER_FILE"
    echo "ℹ️  已把本机登记为 pusher：$me"
  else
    pusher=$(PUSHER_FILE="$PUSHER_FILE" python3 -c 'import json,os;print(json.load(open(os.environ["PUSHER_FILE"],encoding="utf-8")).get("machine",""))' 2>/dev/null)
    if [ -n "$pusher" ] && [ "$pusher" != "$me" ] && [ "${PA_ALLOW_NON_PUSHER:-0}" != "1" ]; then
      cat >&2 <<EOF
❌ 本机（${me}）不是登记的 pusher（登记的是 ${pusher}），不允许 push main。

   多机纪律：只有一台机器有推送权，否则两机同时合 main 会互相打架（门禁、登记表、tag 都可能错位）。

   临时接管：PA_ALLOW_NON_PUSHER=1 pa-merge.sh ...（并记得把状态文件改过来）
   状态文件：$PUSHER_FILE
EOF
      exit 1
    fi
  fi
fi
if [ -n "$(git status --porcelain)" ] && [ "${PA_ALLOW_DIRTY:-0}" != "1" ]; then
  echo "❌ 工作树有未提交改动，先收干净（门禁要求干净起点）" >&2
  git status --short >&2
  exit 1
fi

SLUG="$(printf '%s' "$BRANCH" | tr '/' '-')"
IW="${TMPDIR:-/tmp}/pa-merge.$$.$SLUG"

sync_local_main() {
  git fetch -q origin || { echo "⚠️ fetch 失败，local main 未对齐" >&2; return 1; }
  local target old wt
  target="$(git rev-parse origin/main)"
  if ! git rev-parse --verify -q refs/heads/main >/dev/null; then
    git update-ref refs/heads/main "$target"
    echo "✅ local main → $(git rev-parse --short "$target")（与 origin/main 一致）"
    return 0
  fi
  old="$(git rev-parse refs/heads/main)"
  if [ "$old" = "$target" ]; then
    echo "✅ local main 已与 origin/main 一致（$(git rev-parse --short "$target")）"
    return 0
  fi
  if ! git merge-base --is-ancestor "$old" "$target"; then
    echo "⚠️ local main 与 origin/main 分叉（本地有远端没有的提交），未自动处理" >&2
    return 1
  fi
  # 注意：不能直接 `git merge --ff-only origin/main`——那会快进「当前分支」
  wt="$(git worktree list --porcelain | awk -v b="refs/heads/main" '/^worktree /{w=$2} /^branch /{if ($2==b) {print w; exit}}')"
  if [ -n "$wt" ]; then
    if git -C "$wt" merge --ff-only -q origin/main 2>/dev/null; then
      echo "✅ local main 快进到 $(git rev-parse --short "$target")（工作树 ${wt}）"
    else
      echo "⚠️ $wt 的 main 未能快进（有未提交改动？）：git -C '$wt' merge --ff-only origin/main" >&2
      return 1
    fi
  else
    git update-ref refs/heads/main "$target" "$old"
    echo "✅ local main 快进到 $(git rev-parse --short "$target")（未被签出，直接改引用）"
  fi
  return 0
}

attempt() {
  git fetch -q origin || { echo "❌ fetch 失败" >&2; return 1; }

  # 分支快照：全局统一推（开发都在本机做，机器坏了未合并的证据也得留下）
  if [ "$PUSH" = "1" ]; then
    if git push -q origin "refs/heads/$BRANCH:refs/heads/$BRANCH" 2>/dev/null; then
      echo "✅ 分支快照已推：origin/$BRANCH"
    elif git merge-base --is-ancestor "refs/heads/$BRANCH" "refs/remotes/origin/$BRANCH" 2>/dev/null; then
      # 远端比本地新（典型场景：Worker 在另一台机器上干活并推了分支），强推会把那些提交盖掉。
      short_local=$(git rev-parse --short "$BRANCH")
      short_remote=$(git rev-parse --short "origin/$BRANCH")
      echo "❌ 本地分支 ${BRANCH}（${short_local}）落后于 origin/${BRANCH}（${short_remote}）——先同步再合并：" >&2
      echo "   git fetch origin && git branch -f ${BRANCH} origin/${BRANCH}" >&2
      echo "   （强推快照会丢掉远端那些提交，2026-11-24 实测踩过：macmini 上 Worker 的分支被本机旧引用盖回旧提交）" >&2
      return 1
    elif git push -q --force-with-lease origin "refs/heads/$BRANCH:refs/heads/$BRANCH" 2>/dev/null; then
      echo "✅ 分支快照已推（覆盖旧快照）：origin/$BRANCH"
    else
      echo "⚠️ 分支快照推送失败（不影响本次合并）" >&2
    fi
  fi

  git worktree remove --force "$IW" 2>/dev/null
  git worktree prune
  git worktree add -q --detach "$IW" origin/main || { echo "❌ 建临时工作树失败" >&2; return 1; }
  (
    cd "$IW" || exit 1
    git checkout -q -B "pa-merge/$SLUG" || exit 1
    if ! git merge --no-ff -q -m "merge $BRANCH into main" "$BRANCH"; then
      echo "❌ 合并冲突，涉及文件：" >&2
      git diff --name-only --diff-filter=U >&2
      git merge --abort 2>/dev/null
      exit 1
    fi
    echo "✅ 基于最新 origin/main 合并，无冲突"
    if [ -n "$CHECKS" ] && [ "${PA_ALLOW_NO_CHECKS:-0}" != "1" ]; then
      echo "── 门禁：${CHECKS} ──"
      PA_MERGE_BASE=origin/main PA_MERGE_BRANCH="$BRANCH" PA_SHARED="$SHARED" \
        bash "$CHECKS" || { echo "❌ 检查未通过，main 未改动" >&2; exit 1; }
    fi
    if [ "$PUSH" = "1" ]; then
      # 把门禁记录写进合并提交（等价于 PR 描述里的「哪些检查过了」）
      git commit -q --amend -m "merge $BRANCH into main" \
        -m "checks: ${CHECKS:-none} passed $(date -u +%Y-%m-%dT%H:%M:%SZ)
branch: $BRANCH
mode: $([ "$SHARED" = "1" ] && echo shared || echo lane)
gate: pa-merge.sh (local strict)" >/dev/null 2>&1
      err=$(PA_MERGE_GATE=1 git push -q origin HEAD:main 2>&1)
      if [ $? -eq 0 ]; then
        echo "✅ 已合入 main：$(git rev-parse --short HEAD)"
        git log --oneline -1
      else
        printf '%s\n' "$err" >&2
        case "$err" in
          *"non-fast-forward"*|*"fetch first"*|*rejected*)
            echo "⚠️ push 被拒（main 刚被别人推进），重新 fetch 再来" >&2
            exit 2 ;;
          *)
            echo "❌ push 失败（不是「main 被别人推进」那种可重试的情况，先查原因）" >&2
            exit 1 ;;
        esac
      fi
    else
      echo "✅ 干跑通过（未 push，main 未动）。合并后的树：$(git rev-parse --short HEAD)"
    fi
    exit 0
  )
  local rc=$?
  git worktree remove --force "$IW" 2>/dev/null
  return "$rc"
}

for i in 1 2 3; do
  echo "── 第 ${i} 次尝试 ──"
  attempt
  rc=$?
  if [ "$rc" = "0" ]; then
    if [ "$PUSH" = "1" ]; then sync_local_main || true; fi
    exit 0
  elif [ "$rc" = "2" ]; then
    continue
  else
    exit "$rc"
  fi
done

echo "❌ 连续 3 次 push 被拒：main 变动太快，先停下来再合" >&2
exit 1
