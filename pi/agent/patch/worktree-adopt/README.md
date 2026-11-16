# worktree-adopt：把 main 工作区的改动搬到新的 worktree

2026-11-05 用户立规：**local main 只剩两个职责——生成 worktree、被 remote main 快进同步**，它不承载任何写操作。主工作区 main 上一旦出现未提交改动，不再「先问问用户」，
而是**自动搬到功能分支的 worktree 里再提交**（等价于过去「在 main 上自动触发 /add 和 /commit」的效果）。

配套两件东西：

- `worktree-adopt.py`（本目录）：确定性搬运脚本；
- `extensions/main-wip-guard.ts`：`agent_settled` 时检测「main + 有改动 + 暂存区空 + 两个模式开关都 auto」，
  自动给会话下发一条 `display: false` 的指令并触发新一轮——会话据此跑本脚本、再走 `/add` → `/commit` → PR。

## 用法

```bash
python3 ~/.pi/agent/patch/worktree-adopt/worktree-adopt.py            # 当前目录
python3 ~/.pi/agent/patch/worktree-adopt/worktree-adopt.py --repo <主工作区>
python3 ~/.pi/agent/patch/worktree-adopt/worktree-adopt.py --type fix --slug aipay-timeout
python3 ~/.pi/agent/patch/worktree-adopt/worktree-adopt.py --dry-run   # 只看计划
```

成功时输出三行，调用方据此接着干活：

```
WORKTREE=/path/to/repo-<slug>
BRANCH=chore/<slug>-<时间戳>
MOVED=<路径数>
```

之后在 worktree 上走 `/add` → `/commit`，**所有 git 命令带 `-C <WORKTREE>`**（不能 `cd`，`git-main-guard.ts`
只认 `-C` 与进程 cwd）。

## 行为与安全阀

| 情形 | 结果 |
|---|---|
| 不在 `main` / `master` 上 | 跳过（退出码 0，什么都不做） |
| 工作区干净 | 跳过 |
| 暂存区有内容 | **拒绝**（退出码 3）：暂存区归用户把关，脚本不动它 |
| 有未解决冲突 | **拒绝**（退出码 4） |
| `add-mode` 或 `commit-mode` 对本仓库切成 manual | 跳过（用户可能正在看 diff） |
| 目标目录已存在 | **拒绝**（退出码 5）：换个 `--slug` 或先清理 |

搬运步骤（任何一步失败都回滚新建的 worktree，**主工作区原样不动**）：

1. `git worktree add -b <branch> <目录> <HEAD>`；
2. 按 `git status --porcelain -z` 逐路径复制（含修改、删除、重命名、未跟踪文件与目录，软链接按链接复制）；
3. **校验** worktree 的改动路径集合与原状态逐路径一致（不多不少）；
4. **到这一步结束**——默认只复制、**不清理主工作区**（2026-11-16 用户要求）：PR 走完之前主工作区一直显示改动后的内容，不会出现「改动被搬走后短暂变回旧版本」。输出 `HOLD=1` 和收尾命令；旧行为（复制后立即 `git restore --worktree` 清理）保留为 `--move`。

## 合并后收尾：`--finalize`

```bash
python3 worktree-adopt.py --finalize --repo <主工作区> [--ref origin/main]
```

为什么需要这一步：主工作区还挂着改动时，`git merge --ff-only origin/main` 会被 git 拒绝（"Your local changes would be overwritten"，即使内容完全一样），所以不能在合并前清理、也不能不清理。finalize 的做法：

1. 对每个改动路径，比较「工作区文件内容 hash」与「`--ref`（默认 `origin/main`）里同名路径的 hash」；
2. **全部相等**（证明改动已进 main）→ `git restore --worktree` 丢弃工作区改动、删掉对应未跟踪文件 → `merge --ff-only <ref>` → 主工作区干净且已快进；
3. **任何一处不等** → 退出码 8 并列出这些路径，**不动任何文件**（说明还有没进 main 的改动）。

## 边界（诚实）

- 只看一个仓库；多仓库要逐个跑。
- 不做 `git add`、不提交、不建 PR——那些归 `/add`、`/commit` skill。
- 分支前缀默认 `chore`，`--type feat|fix|docs|refactor` 可改；slug 默认按改动路径猜（如改了 `README.md`
  就生成 `chore/readme-<时间戳>`），`--slug` 可指定更贴切的名字。
- 不做敏感信息判断——预检在 `/add` 阶段做，脚本只负责搬。
