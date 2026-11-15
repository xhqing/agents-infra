# 两身份架构：同一个 pi harness，两套配置目录（`pi` / `pi-alt`）

> 2026-11-15 用户立，取代原「两个 harness」方案（第二 harness 已整体退役）。本文是目录布局、运行时身份与 Leader / Worker 工作流的权威说明。

## 一句话

**同一个 harness、同一份代码，两套配置目录：`pi` 跑开源项目，`pi-alt` 跑闭源 / 私有项目。**

## 1. 两个身份

| 身份 | 团队 | 全局配置 | 项目级目录 | 规则文件 |
|---|---|---|---|---|
| `pi` | pi-team（开源） | `~/.pi/agent/` | 项目根 `.pi/` | `~/.pi/agent/AGENTS.md` |
| `pi-alt` | pi-alt-team（闭源 / 私有） | `~/.pi-alt/agent/` | 项目根 `.pi-alt/` | `~/.pi-alt/agent/AGENTS.md` |

两个身份的配置、技能、扩展、会话、凭证、信任记录完全不共享；命令是 `pi` 与 `pi-alt` 两条，各自独立运行。

## 2. 为什么不做第二个 harness

- 使用习惯（TUI、快捷键、斜杠命令、会话管理、技能与扩展机制）全部来自同一个 harness，零迁移成本
- 一份代码产物：`pi update --self` 升级一次，两个身份同时生效
- 只需改 `package.json` 的 `piConfig`（`name` + `configDir`），不动任何 `.ts` 逻辑源码

实现细节与验收标准见 `pi-harness` 仓库 Issue #64。

## 3. 实现方式

`pi-alt` 不持有代码副本，只有一份身份声明与一组软链：

```text
<homebrew prefix>/lib/node_modules/pi-alt/
├── package.json      # piConfig.name = "pi-alt"，configDir = ".pi-alt"
├── dist -> ../pi-coding-agent/dist
├── docs -> ../pi-coding-agent/docs
├── examples -> ../pi-coding-agent/examples
├── README.md -> ../pi-coding-agent/README.md
└── CHANGELOG.md -> ../pi-coding-agent/CHANGELOG.md
```

命令入口是 wrapper：设置 `PI_PACKAGE_DIR` 指向 brand 目录后，exec 主包同一份 `cli.js`。

两条硬约束：

- **`pi-alt update --self` 禁用**：此身份下 `getPackageDir()` 指向 brand 目录，自更新会装错位置；升级统一走 `pi update --self`。wrapper 里设 `PI_SKIP_VERSION_CHECK=1`。
- **brand 目录不得放在主包内部**：主包升级会整体替换目录，brand 会被连带覆盖。

## 4. Agent 项目与私有子项目

**Agent 项目（开源，pi-team 管）** 同时服务两个身份，是「人的家」：

```text
agent-project/
├── AGENTS.md                     # 共享层：身份、通用经验、运行时分支
├── .pi/
│   ├── APPEND_SYSTEM.md          # pi 身份（pi 原生自动加载）
│   ├── skills/                   # pi 专属技能
│   └── extensions/               # pi 专属工具 / 守卫
└── .pi-alt/
    └── APPEND_SYSTEM.md          # pi-alt 身份（同样是 pi 原生自动加载）
```

- 根 `AGENTS.md` 只写共享内容：身份、职责、通用经验、运行时分支。**不写** `/commit`、`agent_call`、`private-links`、某团队的发布流程。
- 两个 `APPEND_SYSTEM.md` 开头写运行时横幅：
  - pi：`Runtime: pi-team; ignore .pi-alt/.`
  - pi-alt：`Runtime: pi-alt-team; ignore .pi/.`
- `.pi-alt/APPEND_SYSTEM.md` 由 pi 原生加载（`cwd/<configDir>/APPEND_SYSTEM.md`），不需要任何插件。

**私有子项目（闭源，pi-alt-team 管）** 是独立仓库，有自己的 `AGENTS.md`、`.pi-alt/`、`VERSION`、`CHANGELOG.md`，**没有 `.pi/`**。

- 子项目默认不登记进公开 `docs/agents-registry.md`、不写 `xhqing` 名册、不进 agents-infra 镜像；**例外**：用户明确要求只列名与链接的私有子项目（当前：NewsScoreStudy），按专项指示登记、不介绍内容。

## 5. 运行时身份

同一个 Agent 项目里有两套规则，模型确实可能读到对方文件——这是「人有两本手册」的正常状态。用两道标识防止误用：

1. 根 `AGENTS.md` 的 `## 运行时` 段写清：`pi` 读 `.pi/APPEND_SYSTEM.md`，`pi-alt` 读 `.pi-alt/APPEND_SYSTEM.md`，不要应用对方的规则。
2. 两个 `APPEND_SYSTEM.md` 开头写运行时横幅。

Worker 的 worktree 里**只有 `.pi-alt/`，没有 `.pi/`**，所以 Worker 天然读不到 pi-team 的手册；这是最强的隔离。

## 6. Leader / Worker

- **Leader = Agent 项目**：Agent 项目任何分支 / worktree 的根目录作为 cwd 的会话，都是 Leader。可以开发 Agent 项目本身，也对名下私有子项目负最终责任。
- **Worker = 私有子项目**：私有子项目任何分支 / worktree 的根目录作为 cwd 的会话，都是 Worker；加载 worktree 的 `AGENTS.md` + `.pi-alt/APPEND_SYSTEM.md`，执行任务，向 Leader 汇报；不碰 local main、不建删 worktree。
- **非 Agent 项目必定是某个 Agent 的子项目**：团队内不存在无主项目；新增私有项目先登记归属，再开工。
- **Agent 项目的 worktree 不是 Worker**：它加载的是 Agent 项目的 `.pi-alt` 帽子，是 Leader。
- **派生 Worker 会话**：pi-alt 身份下用 `tmux` 直接起 `pi-alt`；不要用 pi 的 `agent_call` 跨身份拉起会话（会话注册表与目录校验属于 pi 身份）。

## 7. 版本与 CHANGELOG

| 位置 | 内容 | 读者 |
|---|---|---|
| Agent 项目 `CHANGELOG.md` | 开源 Agent 能力变化 | pi-team、所有人 |
| 私有子项目 `CHANGELOG.md` | 该项目的私有业务变更 | 该项目的 Leader / Worker |

- Agent 项目只有一套 `VERSION` / `CHANGELOG.md`；不因为两个身份拆成两个版本。
- 私有子项目有自己的 `VERSION` / `CHANGELOG.md`；不进 Agent 项目的版本号。
- Agent 项目 CHANGELOG **不写**私有项目名、客户、金额、业务细节；私有子项目 CHANGELOG **不写** pi-team 流程。
- 私有项目里学到的通用经验：先脱敏、泛化，再通过 pi-team 的开源流程写进 Agent 项目的 `AGENTS.md` / skills / CHANGELOG。

## 8. 同步与镜像

- **权威源：`~/.pi-alt/`**（双机；任一台都可以改）。
- 同步：Syncthing `pi-alt` 文件夹（双向），只同步 secret-free 核心（`agent/` 下的规则、技能、设置）。
- 排除：`sessions/`、`state/`、`logs/`、`tmp/`、`node_modules/`、`debug.log`、`auth.json` 这类凭证与运行时产物。
- **不进 agents-infra 镜像**：pi-alt-team 是私有团队，规则与配置不进入公开仓库。

## 9. 污染控制

- 共享文件（根 `AGENTS.md`、`CHANGELOG.md`、README、TODO）写**团队中立 / 产品化**的内容；团队专属内容只进各自的 `APPEND_SYSTEM.md`。
- Worker 的 worktree 不含 `.pi`，天然隔离 pi-team 规则。
- Agent 项目里两个身份共存，靠运行时分支 + 横幅区分；不要为了隔离去 sparse-checkout 掉 `.pi` / `.pi-alt`——Agent 项目是「人的家」，本来就需要两套手册。
- 私有子项目的 `AGENTS.md` 不写 Agent 项目的完整规则；只写项目事实、Worker 边界、汇报线。

## 10. 首次落地清单

1. `pi-alt` 命令可用（`pi-alt --version` 与主包一致，`--help` 显示 `pi-alt`）。
2. `~/.pi-alt/agent/AGENTS.md` 就位，`~/.pi-alt` 已加入 Syncthing（folder id `pi-alt`）。
3. 第一个私有子项目：建私有仓库，写 `AGENTS.md` + `.pi-alt/APPEND_SYSTEM.md`，在 Leader 侧登记本机私有清单。
4. Agent 项目按需补 `.pi-alt/APPEND_SYSTEM.md`（Leader 的 pi-alt 帽子规则）。
5. 分别用 `pi` 与 `pi-alt` 在 Agent 项目根、私有子项目 worktree 根开会话，确认：
   - `pi` 读到 `.pi/APPEND_SYSTEM.md`，横幅提示忽略 `.pi-alt/`；
   - `pi-alt` 读到 `.pi-alt/APPEND_SYSTEM.md`，横幅提示忽略 `.pi/`；
   - 私有子项目 worktree 只读到 `.pi-alt/`。
6. 验证通过后再推广到更多 Agent 项目；不要一次性改 17 个项目。
