#!/usr/bin/env bash
# pa-install-hooks.sh —— 安装 / 检查私有仓库的全局 git 钩子（main 锁 + tag 保护分发器）
#
#   pa-install-hooks.sh           # 安装或更新
#   pa-install-hooks.sh --check   # 只看现状
#
# 为什么是「分发器」而不是直接写规则：core.hooksPath 是全局的（gitleaks 的 pre-commit 在那儿），
# 直接写 main 锁会影响所有仓库。分发器跑两类检查：
#   pre-push         → pre-push-guard.sh（只对私有仓库生效，判据是远端可见性）+ 仓库自己的 .githooks/pre-push
#   pre-commit       → pa-main-guard.sh commit（私有仓库 local main 不接受提交）+ 原来的 gitleaks / 版本一致性
#   pre-merge-commit → pa-main-guard.sh merge （私有仓库 local main 不接受合并提交，2026-11-24 加）
#   pre-rebase       → pa-main-guard.sh rebase（私有仓库 local main 不接受变基，2026-11-24 加）
#
# 为什么 merge / rebase 要单独装：githooks(5) 规定 pre-commit **只由 git-commit 调用**
# ——git-merge 调 pre-merge-commit、git-rebase 调 pre-rebase。只装 pre-commit 时，
# `git merge --no-ff` 与 `git rebase` 在 local main 上零拦截（2026-11-24 实测）。
#
# 这是**机器级部署**：本机与 macmini 各跑一次（~/.config 不在同步范围内）。
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_DIR="${HOOKS_DIR:-$HOME/.config/git/hooks}"
PRE_PUSH="$HOOK_DIR/pre-push"
PRE_COMMIT="$HOOK_DIR/pre-commit"
PRE_MERGE="$HOOK_DIR/pre-merge-commit"
PRE_REBASE="$HOOK_DIR/pre-rebase"
GITLEAKS="$HOOK_DIR/pre-commit.gitleaks"

if [ "${1:-}" = "--check" ]; then
  [ -x "$SELF_DIR/pre-push-guard.sh" ] && echo "✅ 守卫：$SELF_DIR/pre-push-guard.sh" || echo "❌ 缺守卫：$SELF_DIR/pre-push-guard.sh"
  [ -x "$SELF_DIR/pa-main-guard.sh" ] && echo "✅ 守卫：$SELF_DIR/pa-main-guard.sh（commit / merge / rebase 三档）" || echo "❌ 缺守卫：$SELF_DIR/pa-main-guard.sh"
  [ -x "$PRE_PUSH" ] && echo "✅ 分发器：$PRE_PUSH" || echo "❌ 缺分发器：$PRE_PUSH"
  [ -x "$PRE_COMMIT" ] && echo "✅ 分发器：${PRE_COMMIT}（main 提交守卫 + gitleaks）" || echo "❌ 缺分发器：$PRE_COMMIT"
  [ -x "$PRE_MERGE" ] && echo "✅ 分发器：${PRE_MERGE}（main 合并守卫）" || echo "❌ 缺分发器：$PRE_MERGE"
  [ -x "$PRE_REBASE" ] && echo "✅ 分发器：${PRE_REBASE}（main 变基守卫）" || echo "❌ 缺分发器：$PRE_REBASE"
  [ -x "$GITLEAKS" ] && echo "✅ 原检查：$GITLEAKS" || echo "❌ 缺原检查：$GITLEAKS"
  echo "   core.hooksPath = $(git config --global core.hooksPath)"
  exit 0
fi

chmod +x "$SELF_DIR"/*.sh 2>/dev/null
mkdir -p "$HOOK_DIR"

[ -f "$PRE_PUSH" ] && cp "$PRE_PUSH" "$PRE_PUSH.bak-$(date +%Y%m%d-%H%M%S)" && echo "已备份原 pre-push"
cat > "$PRE_PUSH" <<HOOK
#!/usr/bin/env bash
# 全局 pre-push 分发器（私有仓库 main 锁 + tag 保护；由 pa-install-hooks.sh 安装）
GUARD="$SELF_DIR/pre-push-guard.sh"
if [ -x "\$GUARD" ]; then "\$GUARD" "\$@" || exit \$?; fi
repo_root=\$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
if [ -x "\$repo_root/.githooks/pre-push" ]; then exec "\$repo_root/.githooks/pre-push"; fi
exit 0
HOOK
chmod +x "$PRE_PUSH"
echo "✅ 已安装：$PRE_PUSH"

# pre-commit 分发器：先跑 main 守卫，再跑原来的 gitleaks + 版本一致性（保持原行为不变）
if [ -f "$PRE_COMMIT" ] && ! grep -q "pa-main-guard" "$PRE_COMMIT"; then
  mv "$PRE_COMMIT" "$GITLEAKS"
  echo "   原 pre-commit 已改名为 pre-commit.gitleaks（行为不变，只是被分发器调用）"
fi
cat > "$PRE_COMMIT" <<HOOK
#!/usr/bin/env bash
# 全局 pre-commit 分发器（由 pa-install-hooks.sh 安装）
# ① 私有仓库 local main 守卫（公开仓库不受影响）
# ② 原来的 gitleaks + 版本一致性检查（pre-commit.gitleaks，原样调用）
HERE=\$(cd "\$(dirname "\$0")" && pwd)
GUARD="$SELF_DIR/pa-main-guard.sh"
if [ -x "\$GUARD" ]; then "\$GUARD" commit || exit \$?; fi
if [ -x "\$HERE/pre-commit.gitleaks" ]; then exec "\$HERE/pre-commit.gitleaks" "\$@"; fi
exit 0
HOOK
chmod +x "$PRE_COMMIT"
echo "✅ 已安装：${PRE_COMMIT}（main 提交守卫 + gitleaks 分发器）"

# pre-merge-commit 分发器（2026-11-24 加）：git merge 生成合并提交前拦 local main
cat > "$PRE_MERGE" <<HOOK
#!/usr/bin/env bash
# 全局 pre-merge-commit 分发器（私有仓库 local main 禁合并提交；由 pa-install-hooks.sh 安装）
# 快进合并不会触发本钩子（githooks(5)），所以 \`git merge --ff-only origin/main\` 不受影响。
GUARD="$SELF_DIR/pa-main-guard.sh"
if [ -x "\$GUARD" ]; then "\$GUARD" merge || exit \$?; fi
exit 0
HOOK
chmod +x "$PRE_MERGE"
echo "✅ 已安装：${PRE_MERGE}（main 合并守卫）"

# pre-rebase 分发器（2026-11-24 加）：git rebase / git pull --rebase 改写前拦 local main
cat > "$PRE_REBASE" <<HOOK
#!/usr/bin/env bash
# 全局 pre-rebase 分发器（私有仓库 local main 禁变基；由 pa-install-hooks.sh 安装）
GUARD="$SELF_DIR/pa-main-guard.sh"
if [ -x "\$GUARD" ]; then "\$GUARD" rebase || exit \$?; fi
exit 0
HOOK
chmod +x "$PRE_REBASE"
echo "✅ 已安装：${PRE_REBASE}（main 变基守卫）"

echo "   私有仓库：main 只能经 pa-merge.sh 合入、local main 不接受提交 / 合并 / 变基；公开仓库不受影响。"
