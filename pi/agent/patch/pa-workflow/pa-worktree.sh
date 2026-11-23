#!/usr/bin/env bash
# pa-worktree.sh —— 并行开发：一个任务一个工作树，可选直接起 Worker 会话。
#
#   pa-worktree.sh <slug> [--branch <分支>] [--base <基线>] [--task <任务卡>] [--no-start] [--session <名字>]
#   pa-worktree.sh idea-03 --branch feat/idea-03-something --task research/tasks/idea-03.md
#   pa-worktree.sh --rm <slug>
#
# 做四件事（与团队「Leader 建 worktree、派 Worker」同一形态，全本地化）：
#   1. 建分支 + 工作树 ../<仓库名>-<slug>（目录名遵循团队 worktree 命名规则）；
#   2. 把主工作树的 data/raw 软链进来（数据只读，不复制）；
#   3. 把工作树父目录写进 pi 的信任表（否则 worktree 里加载不到项目级规则 / skill）；
#   4. 在 tmux 会话 pi-pa-<slug> 里起 `pi -a -n '<agent>-<slug>'`（--no-start 可关）。
#
# 结束时用 pa-worktree.sh --rm <slug> 回收（分支保留）。
set -uo pipefail

PI_BIN="${PA_PI_BIN:-pi}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "❌ 不在 git 仓库里" >&2; exit 1; }
cd "$REPO_ROOT" || exit 1
REPO_NAME="$(basename "$REPO_ROOT")"
AGENT_NAME="${PA_AGENT_NAME:-$REPO_NAME}"
WT_ROOT="$(dirname "$REPO_ROOT")"
MAX_WORKERS="${MAX_WORKERS:-4}"
TRUST="${PA_TRUST_FILE:-$HOME/.pi/agent/trust.json}"

trust_add() {
  python3 - "$TRUST" "$1" <<'PY'
import json, os, sys
path, path_to_add = sys.argv[1], sys.argv[2]
d = {}
if os.path.exists(path):
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
if path_to_add not in d:
    d[path_to_add] = True
    with open(path, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"   信任目录已加：{path_to_add}")
PY
}

if [ "${1:-}" = "--rm" ]; then
  SLUG="${2:?--rm 需要 slug}"
  git worktree remove --force "$WT_ROOT/$REPO_NAME-$SLUG" 2>/dev/null \
    && echo "✅ 已回收工作树 $WT_ROOT/$REPO_NAME-$SLUG" || echo "（没有这个工作树）"
  exit 0
fi

SLUG="${1:?用法: pa-worktree.sh <slug> [--branch <分支>] [--base <基线>] [--no-start] [--task <文件>]}"
shift
BRANCH="wt/$SLUG"
BASE="main"
START=1
TASK=""
SESSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="${2:?}"; shift ;;
    --base) BASE="${2:?}"; shift ;;
    --task) TASK="${2:?}"; shift ;;
    --session) SESSION="${2:?}"; shift ;;
    --no-start) START=0 ;;
    *) echo "❌ 未知参数：$1" >&2; exit 1 ;;
  esac
  shift
done
SESSION="${SESSION:-pi-pa-$SLUG}"
WT_PATH="$WT_ROOT/$REPO_NAME-$SLUG"

git show-ref --verify --quiet "refs/heads/$BRANCH" && { echo "❌ 分支已存在：$BRANCH" >&2; exit 1; }
[ -d "$WT_PATH" ] && { echo "❌ 工作树目录已存在：$WT_PATH" >&2; exit 1; }

running=$(tmux ls 2>/dev/null | grep -c '^pi-pa-' || true)
if [ "$START" = "1" ] && [ "$running" -ge "$MAX_WORKERS" ]; then
  echo "❌ 已在跑的 Worker 有 $running 个（上限 ${MAX_WORKERS}，可用 MAX_WORKERS 调）" >&2
  exit 1
fi

git fetch -q origin 2>/dev/null || true
git worktree add -q -b "$BRANCH" "$WT_PATH" "$BASE" || { echo "❌ 建工作树失败" >&2; exit 1; }
echo "✅ 工作树：$WT_PATH"
echo "   分支：${BRANCH}（基线 ${BASE}）"

mkdir -p "$WT_PATH/data" "$WT_PATH/outputs"
[ -d "$REPO_ROOT/data/raw" ] && ln -sfn "$REPO_ROOT/data/raw" "$WT_PATH/data/raw"
trust_add "$WT_ROOT"

if [ -f "$REPO_ROOT/AGENTS.md" ]; then
  echo "   项目规则：AGENTS.md（开工先读）"
fi

if [ "$START" = "1" ]; then
  if [ -n "$TASK" ]; then
    PROMPT="你的任务在 ${TASK}。先读 AGENTS.md 与项目规则，然后按任务卡开工；超出任务边界先问 Leader。"
  else
    PROMPT="先读 AGENTS.md 与项目规则，然后等 Leader 的任务说明。"
  fi
  tmux new-session -d -s "$SESSION" -c "$WT_PATH" "$PI_BIN -a -n '$AGENT_NAME-$SLUG' '$PROMPT'"
  echo "   tmux：tmux attach -t ${SESSION}（会话名 pi- 前缀，由 agent 创建 / 清理）"
else
  echo "   未启动会话。手动：cd $WT_PATH && $PI_BIN -a -n '$AGENT_NAME-$SLUG'"
fi
