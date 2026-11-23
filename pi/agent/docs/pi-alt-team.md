# pi-alt 双身份已退役（2026-11-23）—— 历史记录

> **现状：团队只有一个身份 `pi`、一套规则（`~/.pi/agent/AGENTS.md`）、一套工具。**
> 本文只作历史记录，**不要再照着做**：没有 `pi-alt` 命令、没有 `~/.pi-alt`、没有项目级 `.pi-alt/`。

## 为什么退役

2026-11-11 起，团队按「公开 / 私有」拆成两套身份（`pi` 与 `pi-alt`），各有一套配置目录、规则、技能、守卫、名册与镜像策略。三天实测下来，分离的成本远大于收益：

| 代价 | 具体表现 |
|---|---|
| 工具全要重写 | 并行 worktree、main 锁、合并门禁、发版链在私有侧从零写了一遍 |
| 协作断链 | 私有身份没有 extensions，也就没有 `pi-intercom`，跨 agent 发消息一律失败，只能退化成 GitHub Issue |
| 规则两本 | 每个 agent 要记两套手册 + 一条「别串规则」的元规则，同一条工作流维护两份文档 |
| 文档双份 | 注册表、镜像、双机同步各带一套例外，Syncthing 多一个 folder |
| 无收益的部分 | 「私有内容不上公开面」实际靠的是**发布路径过滤 + 可见性判定**，而不是第二个配置目录（镜像本来就排除 `sessions/ state/ logs/ intercom/ npm/ bin/`） |

用户 2026-11-23 决定取消 `pi-alt`，把公开 / 私有工作流统一到一套规则。

## 现在的做法（取代双身份）

**唯一的判定依据是仓库可见性**（`gh repo view --json isPrivate`，本地缓存），不是配置目录、不是有没有某个目录。

| 仓库类型 | 开发路径 | 强制手段 |
|---|---|---|
| 公开仓库 | 分支 → push → PR → CI → strict → auto-merge → 本地 main `--ff-only` | GitHub 服务端（branch protection），免费可用 |
| 私有仓库 | 分支 → `pa-merge.sh`（本地 strict 门禁）→ push main → 本地 main 快进 | 本地工具强制：pre-push main 锁 + pre-commit main 禁用 + tag 保护 + 单 pusher |

工具在 `~/.pi/agent/patch/pa-workflow/`，一次性部署 `pa-install-hooks.sh`（机器级，两台机器各跑一次）；规则在 `AGENTS.md`「开发流程：worktree + PR」第 5 条与 skill `dev-workflow`「私有仓库路径」节。

## 退役时做了什么（2026-11-23）

1. 私有侧工具搬进 `patch/pa-workflow/`：`pa-merge.sh` / `pa-worktree.sh` / `pa-release.sh` / `pre-push-guard.sh` / `pa-main-guard.sh` / `pa-install-hooks.sh`（路径与状态文件改到 `~/.pi/agent`，`checks.sh` 改为仓库根）。
2. `git-main-guard.ts` 增加「门禁授权」：`PA_MERGE_GATE=1` 只对**已确认私有**的仓库放行推 main。
3. 规则与文档改齐：`AGENTS.md`、`docs/agents-registry.md`、`docs/capability-sync.md`、`docs/macmini-mirror.md`、skill `dev-workflow`。
4. 三个仓库的 `.pi-alt/` 迁进 `.pi/`（quant-agent、NewsScoreStudy、hyperliquid-research-trial）。
5. `~/.pi-alt` 归档为 `~/.pi-alt.retired-20261123`（观察两周再删）、`pi-alt` 命令删除、Syncthing `pi-alt` folder 在两台机器上移除、`~/.pi-alt/agent/trust.json` 的目录并入 `~/.pi/agent/trust.json`。
6. 撤回 agents-infra#297（「把 pi-alt 全局规则也开源」）：统一后规则本就并进 `~/.pi/agent`，随现有镜像发布，那个 issue 失去意义。

## 三条护栏（保留，不可省）

1. **公开面一律按可见性过滤**：agents-infra 只镜像 `~/.pi/agent` 且排除本机私有部分；`xhqing` 名册与注册表对私有项目只写「名字 + 链接」；发布前跑可见性 + gitleaks + 私有项目名 grep。
2. **全局规则不装私有内容**：私有项目的口径、数据、策略只写在那个仓库自己的 `AGENTS.md` / `.pi/APPEND_SYSTEM.md`；全局 `~/.pi/agent/AGENTS.md` 只写通用规则——写进公网仓库就进了 git 历史，撤不回来。
3. **发布前闸门**：任何写公开面的动作（agents-infra publish、名册、博客）前先过可见性判定 + 敏感扫描。
