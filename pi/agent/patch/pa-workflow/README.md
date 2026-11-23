# pa-workflow —— 私有仓库的本地门禁与并行开发工具

一套规则、两条执行路径：**公开仓库走 GitHub 的 PR + CI + strict + auto-merge；私有仓库走这里的本地门禁。**
唯一的判定依据是**仓库可见性**（`gh api repos/<owner>/<repo> --jq .private`），不是有没有某个目录。

为什么私有仓库要单独一套：GitHub Free 的私有仓库没有 branch protection（实测 `403 Upgrade to GitHub Pro`），
required checks / strict / auto-merge 都拿不到，服务端不会替我们挡；于是把同等强制力做到本地（钩子 + 脚本）。

## 一次性部署（机器级，每台机器各跑一次）

```bash
~/.pi/agent/patch/pa-workflow/pa-install-hooks.sh          # 安装 / 更新
~/.pi/agent/patch/pa-workflow/pa-install-hooks.sh --check  # 只看现状
```

装的是 `~/.config/git/hooks/` 下的两个分发器（`core.hooksPath` 指这里）：

- `pre-push` → `pre-push-guard.sh`（私有仓库 main 锁 + 已发布 tag 不可移动 / 删除）→ 仓库自己的 `.githooks/pre-push`
- `pre-commit` → `pa-main-guard.sh`（私有仓库 local main 不接受提交）→ 原来的 `pre-commit.gitleaks`（gitleaks + 版本一致性）

## 日常用法

```bash
pa-merge.sh <分支名>                  # 干跑：在最新 origin/main 上合并 + 跑 checks.sh，main 不动
pa-merge.sh <分支名> --push            # 全过才合入 main，并快进 local main
pa-merge.sh <分支名> --push --shared   # 允许改共用文件（Leader 自己改基础代码时用）

pa-worktree.sh <slug> [--task <任务卡>] [--no-start]   # 一任务一工作树（../<仓库名>-<slug>），在仓库目录里跑
pa-worktree.sh --rm <slug>                             # 回收工作树（分支保留）
# 从仓库外调用：以上命令都可加 --repo <仓库路径>（与 pa-merge.sh 一致）

pa-release.sh patch|minor|major [--no-push]            # bump → 分支 → 门禁 → tag → Release
```

## 项目侧只写一件事：`checks.sh`

仓库根放 `checks.sh`，声明「检查什么」（`pa-merge.sh` 找不到就拒合，等同「没配 CI 不许合」）。
兼容读取 `.pi/checks.sh`（历史位置）。可用环境变量：

| 变量 | 含义 |
|---|---|
| `PA_MERGE_BASE` | 基线 ref（通常 `origin/main`） |
| `PA_MERGE_BRANCH` | 被合并的分支 |
| `PA_SHARED` | 1 = 允许改共用文件 |

最小示例：

```bash
#!/usr/bin/env bash
set -euo pipefail
python3 -m compileall -q src
```

## 与公开仓库流程的对应关系

| 维度 | 公开仓库（服务端） | 私有仓库（本地） |
|---|---|---|
| 禁止直推 main | branch protection | `pre-push-guard.sh`（钩子层，任何进程都拦） |
| required checks | required status check | `pa-merge.sh` 跑 `checks.sh` |
| strict（必须基于最新 base） | `required_status_checks.strict` | 每次 fetch 后在最新 `origin/main` 上合并，push 被拒自动重来 |
| auto-merge | GitHub auto-merge | `pa-merge.sh --push` 串行合 + 单 pusher |
| 保护已发布 tag | 无专门规则 | 守卫拦 tag 移动 / 删除（更严） |
| 合并可审计 | PR 正文 | 合并提交正文写 `checks / branch / mode / gate` |

## 已知限制（诚实声明）

- 本地钩子可被 `git push --no-verify` 绕过（私有仓库无服务端兜底），只能靠「单 pusher + 钩子 + 定期审计」近似。
- 私有仓库没有 PR 审阅页面，用合并提交正文替代。
- 单 pusher 状态在 `~/.dev/private/.state/pa-pusher.json`（随 Syncthing 同步），临时接管用 `PA_ALLOW_NON_PUSHER=1`。
- 可见性缓存 `~/.pi/agent/state/repo-visibility.json`（TTL 1 天，`PA_VISIBILITY_TTL` 可调）；判不出来时按私有处理（fail-closed）。
