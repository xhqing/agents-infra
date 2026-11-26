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

装的是 `~/.config/git/hooks/` 下的四个分发器（`core.hooksPath` 指这里）：

- `pre-push` → `pre-push-guard.sh`（私有仓库 main 锁 + 已发布 tag 不可移动 / 删除）→ 仓库自己的 `.githooks/pre-push`
- `pre-commit` → `pa-main-guard.sh commit`（私有仓库 local main 不接受提交）→ 原来的 `pre-commit.gitleaks`（gitleaks + 版本一致性）
- `pre-merge-commit` → `pa-main-guard.sh merge`（私有仓库 local main 不接受合并提交）——快进合并不触发它，`git merge --ff-only origin/main` 照常
- `pre-rebase` → `pa-main-guard.sh rebase`（私有仓库 local main 不接受变基 / `git pull --rebase`）

**为什么 merge / rebase 要单装钩子**（2026-11-24 实测发现的漏洞）：githooks(5) 规定 `pre-commit` **只由 git-commit 调用**——git-merge 调 `pre-merge-commit`、git-rebase 调 `pre-rebase`。只装前者时，`git merge --no-ff feat` 能在 local main 上直接建出合并提交（exit=0）、`git rebase` 能改写 main 历史，两者零拦截。

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

**从模板开始，别从零写**：`checks-template.sh`（同目录）含与公开仓库 `validate.py` 对齐的五类检查——必备文件（README / CHANGELOG）、敏感文件未被跟踪（`.env` / 私钥 / `*.kdbx` / 凭据）、被跟踪文件 ≤10 MB、README 相对链接有效、Python / Shell 语法。复制到仓库根为 `checks.sh`，项目自有检查写在文件末尾的「项目自有检查」段。

最小示例（仅当项目有充分理由不要模板时）：

```bash
#!/usr/bin/env bash
set -euo pipefail
python3 -m compileall -q src
```

## 合并期内容扫描（gitleaks，2026-11-26 加）

`pa-merge.sh` 在合并前对「本次将要进入 main 的提交」（`origin/main..合并提交`）跑一次 `gitleaks detect`：分支提交可以用 `git commit --no-verify` 绕过 pre-commit，合并这道是兜底。

- 未装 gitleaks → **拒绝合并**（fail-closed），与 pre-commit 钩子同口径；
- 检出 → 拒绝合并并打印位置，确认误报的行尾加 `gitleaks:allow`；
- 受控例外：`PA_ALLOW_NO_GITLEAKS=1`（须用户当轮授权）。

## 与公开仓库流程的对应关系

| 维度 | 公开仓库（服务端） | 私有仓库（本地） |
|---|---|---|
| 禁止直推 main | branch protection | `pre-push-guard.sh`（钩子层，任何进程都拦） |
| 禁止在 main 上落提交 | branch protection（服务端拒收） | `pre-commit` → `pa-main-guard.sh commit`（钩子层） |
| 禁止在 main 上合并 / 变基 | branch protection（服务端拒收） | `pre-merge-commit` / `pre-rebase` → `pa-main-guard.sh merge|rebase`（钩子层；2026-11-24 补） |
| 禁止在 main 上 reset / cherry-pick / revert / am / 改写引用 | branch protection（服务端拒收） | pi 端 `git-main-guard.ts`（tool 层；git 没有对应钩子） |
| 禁止在主工作区 main 上写文件 | PR 流程 + 分支保护 | pi 端 `main-wip-guard.ts`（tool 层当场拦）+ `agent_settled` 自动搬运 |
| required checks | required status check | `pa-merge.sh` 跑 `checks.sh`（模板见 `checks-template.sh`，五类与公开 `validate.py` 对齐） |
| strict（必须基于最新 base） | `required_status_checks.strict` | 每次 fetch 后在最新 `origin/main` 上合并，push 被拒自动重来 |
| auto-merge | GitHub auto-merge | `pa-merge.sh --push` 串行合 + 单 pusher |
| 内容密钥扫描（合并期） | 无专门规则（只有提交期 pre-commit） | `pa-merge.sh` 对 `origin/main..HEAD` 跑 gitleaks（比公开多一道） |
| 保护已发布 tag | 无专门规则 | 守卫拦 tag 移动 / 删除（更严） |
| 合并可审计 | PR 正文 | 合并提交正文写 `checks / branch / mode / gate` |

## 已知限制（诚实声明）

- 本地钩子可被 `git push --no-verify` / `git commit --no-verify` / `git merge --no-verify` 绕过（私有仓库无服务端兜底），只能靠「单 pusher + 钩子 + 定期审计」近似。**合并期 gitleaks 只扫 `origin/main..HEAD` 的增量提交**——历史里已存在的泄漏不会被它翻出来，需要时手动跑 `gitleaks detect --source .` 全量扫。
- **git 没有 pre-reset / pre-cherry-pick 钩子**：`git reset` / `git cherry-pick` / `git revert` / `git am` / `git update-ref` / `git branch -f` 这几类只能由 pi 端 `git-main-guard.ts` 拦——即只覆盖「pi 会话里发出的命令」，人直接在终端敲的拦不住。
- 同理「主工作区 main 上写文件」只拦 pi 的 `write` / `edit` 与常见 shell 写动作（重定向 / `sed -i` / `cp` / `mv` / `tee` / `chmod` …），**不含** `python` / `node` 脚本内部写盘（会把 `worktree-adopt.py` 这类正常流程误拦）。
- `pre-rebase` 只判断「当前分支是不是 main」；`git rebase main feature`（在别的分支上把 feature 变基到 main）若当前正停在 main 上会被一并拦住，用带分支参数的写法或换到目标分支再操作。
- **公开仓库在两层的行为不同**：钩子层**放行**（公开仓交给 GitHub 服务端 branch protection + CI）；pi 端 `git-main-guard.ts` / `main-wip-guard.ts` **照样拦**——与既有的 `git add` / `git commit` 同一口径：不论仓库可见性，团队仓库的 local main 都不承载任何写操作（local main 的职责与远端保护无关）。
- 私有仓库没有 PR 审阅页面，用合并提交正文替代。
- 单 pusher 状态在 `~/.dev/private/.state/pa-pusher.json`（随 Syncthing 同步），临时接管用 `PA_ALLOW_NON_PUSHER=1`。
- 可见性缓存 `~/.pi/agent/state/repo-visibility.json`（TTL 1 天，`PA_VISIBILITY_TTL` 可调）；判不出来时按私有处理（fail-closed）。
