<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../LICENSE.md)
[![Type](https://img.shields.io/badge/Type-App%20Configs-4B8BBE.svg)](#)

[English](README.md)

</div>

# apps —— agent 所运行终端的配置

承载 agent 会话的 App 本身就是基础设施：终端配错了，跑在里面的每一个 agent 都跟着用错。
它们的配置收在这里，一个 App 一个目录。

**家目录里生效的那个文件是权威源，本仓库里的副本是镜像。** `~/.config/ghostty/config`
与 `~/.config/cmux/*` 都是普通文件，由 App 直接读写——这里**不建软链**，所以任何 App
的原子写都不会悄悄把链接换成实体文件。仓库里的 `apps/` 是「改完设置后收集的一份快照」，
也是换新机器时用来部署的那一份。

目前收录两个 App：**ghostty**（终端）与 **cmux**（跑 agent 面板的终端）。

## 它在哪

本目录是 [agents-infra](../README.md) 的一部分。仓库的两半维护方式不同：

| 路径 | 权威源 | 镜像怎么生成 |
|---|---|---|
| `pi/agent/` | `~/.pi/agent/` | `patch/agents-infra-publish/publish.py`，只在本机（MacBook）上跑 |
| `apps/` | `~/.config/…`（本机） | `apps/publish.sh`，改完设置手动跑 |

两半都不在这个仓库里直接改：先改生效的那一份，再把镜像发布上来。

## 三个脚本、三个方向

| 命令 | 方向 | 什么时候用 |
|---|---|---|
| `./install.sh` | 镜像 → 系统 | **新机器**：按 `mappings.conf` 把文件复制到位、写回 UserDefaults 快照、重载 cmux |
| `./publish.sh` | 系统 → 镜像 | **改完设置**：把生效文件收进仓库、刷新快照、跑敏感检查 |
| `./check.sh` | 比对两边 | 随时：报缺失文件、残留软链、以及「机器上改了但还没发布」的配置 |

## 目录结构

```
apps/
├── mappings.conf           # 镜像路径 → 系统路径 的映射表（install / publish / check 共用）
├── ghostty/                # App：Ghostty 终端
│   ├── README.md           #   本目录的 config 只被 Ghostty 读，见下
│   └── config              #   ~/.config/ghostty/config 的镜像
├── cmux/                   # App：cmux 终端
│   ├── README.md           #   ⚠️ cmux 自 r21 起只读自己的终端配置，见下
│   ├── cmux.json           #   ~/.config/cmux/cmux.json 的镜像
│   ├── config.ghostty      #   ~/.config/cmux/config.ghostty 的镜像
│   └── defaults.plist      #   UserDefaults 白名单快照（不是生效文件）
├── install.sh              # 新机器：部署镜像
├── publish.sh              # 改完设置：把系统文件收进镜像
├── check.sh                # 比对镜像与系统
└── scripts/                # UserDefaults 快照的导出 / 写回工具、敏感检查闸门
```

## 配置文件归属（重要）

配置在机器上只有一份生效文件，本表记录「谁在读」——**新增或改动这类文件时必须同步本表
与相关目录 README**。

| 系统文件（权威源） | 本仓库镜像 | 谁在读 | 说明 |
|---|---|---|---|
| `~/.config/ghostty/config` | `ghostty/config` | **只有 Ghostty** | Ghostty 的终端配置（主题、字体、字号、光标、窗口尺寸、Quick Terminal 热键） |
| `~/.config/cmux/config.ghostty` | `cmux/config.ghostty` | **只有 cmux** | cmux 自己的终端配置，用 Ghostty 语法——「Ghostty 格式」≠「Ghostty 会用」。自 cmux v0.65.2.2-r21 起 cmux 不再读 `ghostty/config`，外观只认这份 |
| `~/.config/cmux/cmux.json` | `cmux/cmux.json` | **只有 cmux** | 应用层设置，设置界面读它也会写回 |
| `com.cmuxterm.app` 的 UserDefaults 域 | `cmux/defaults.plist` | **只有 cmux** | 白名单偏好快照，`install.sh` 会写回 |

一句话记忆：**当前没有跨 App 共用的配置文件**。cmux 与 Ghostty 的终端配置已彻底解耦
（cmux v0.65.2.2-r21 起，Issue #70），同一个外观设置要在两份文件里各写一次。

## 新机器恢复步骤

```bash
git clone https://github.com/xhqing/agents-infra.git ~/Developer/agents-infra
cd ~/Developer/agents-infra/apps
./install.sh          # 复制配置 + 写回 UserDefaults + cmux reload-config
```

注意：

- `install.sh` 会把内容与镜像不同的现有文件改名成 `xxx.bak.<时间戳>` 再复制，不会覆盖丢东西；内容已一致则跳过。
- 它不建软链。若发现旧机制留下的软链，会直接换成实体文件。
- 装之前不需要先装 Ghostty：cmux 自 v0.65.2.2-r21 起只读自己的 `~/.config/cmux/config.ghostty`，不依赖 `~/.config/ghostty/config`。
- 恢复后如果 cmux 已经在跑，手动 `cmux reload-config` 一次即可。

## 日常维护

| 改了什么 | 怎么进仓库 |
|---|---|
| Ghostty 的终端设置（字体、主题、光标…） | 改 `~/.config/ghostty/config` → `./publish.sh` → 提交 |
| cmux 的终端设置（字体、主题、光标…） | 改 `~/.config/cmux/config.ghostty` → `cmux reload-config` → `./publish.sh` → 提交；想让两个终端一致时，同一个值要在两份文件里各写一次 |
| cmux 设置界面里的终端选项 | 它们落在 `~/.config/cmux/config.ghostty` → `./publish.sh` |
| cmux.json / UI 里的偏好 | `./publish.sh` → 提交 |

不确定状态时跑 `./check.sh`：某个文件与镜像不同，就说明机器上改过、仓库还没跟上。

## 新增一个 App 的配置

1. 建目录（简称、全小写）；
2. 把配置的镜像副本放进去；
3. 在 `mappings.conf` 加一行：`镜像路径 <TAB> 系统路径 <TAB> 权限或 - <TAB> 说明`；
4. 在目录里写 `README.md`：这份配置是什么、谁在读、**有没有别的 App 也读它**；
5. 如果确实有多个 App 共用同一份文件，同步更新上面的「配置文件归属」表；
6. `./publish.sh` → `./check.sh` 全绿 → 下次新机器 `./install.sh` 会部署它，然后提交。

## 为什么是镜像，不是软链

早期做法是把 `~/.config/...` 软链进仓库，好处是「只有一份」。但只要有 App 采用原子写
（很多 electron / Swift 应用都是「写临时文件再 rename 覆盖」），软链就会被悄悄替换成普通
文件：仓库从此不再跟着变，`git status` 却一片干净——这是静默失效。

让生效文件留在它原生位置、仓库只存快照，就彻底没有这个失效模式：App 看到的永远是它期望
的普通文件，仓库这边靠一条命令收集、一条命令部署。代价是每次改完要手动跑一次
`./publish.sh`——忘了的话，`./check.sh` 会告诉你。

## 备份了什么、没备份什么

**镜像（配置）**：`ghostty/config`、`cmux/cmux.json`、`cmux/config.ghostty`、
`cmux/defaults.plist`（外观模式、侧边栏样式、右侧栏模式、文件浏览器宽度等白名单项）。

**不备份（有意排除）**：登录凭证与 keychain token、遥测 / 安装 ID、会话与工作区快照、
滚动历史、agent journal、浏览器历史、窗口位置，以及别的工具的配置（需要时另开目录管理）。

`publish.sh` 在把任何内容复制进仓库**之前**先跑 `scripts/check-secrets.py`：任何非空的
`password` / `token` / `secret` / `apiKey` 字段（包括 `cmux.json` 的 `socketPassword`）都会
让发布中止。占位符与空值放行。

## 已知注意点

- **中文观感**：`ghostty/config` 与 `cmux/config.ghostty` 里都是 `font-family = Menlo` 之后
  再加一行 `font-family = PingFang SC`，两份都不能删。cmux 在用户没有多字体族回退链时，
  会自动把中文钉到 `PingFang SC Regular`，比 Ghostty 细一档；显式写了回退链就不注入。
  详见 `ghostty/README.md`、`cmux/README.md`。
- **权限**：`cmux.json` 可能写 socket 控制密码，`mappings.conf` 保持 600——`install.sh` 会把
  这个权限应用到生效文件，镜像副本沿用同一权限。
- **两台机器不要同时写**：同一仓库同一时间只在一台机器上做 git 写操作，否则提交与分支会互相错位。
- **cmux 升级**可能迁移 `cmux.json` 的 `schemaVersion`，也可能再次改动它读哪些配置路径。
  升级后跑一次 `./check.sh` 确认没有漂移，并对照 `cmux config paths` 确认
  「Related (cmux's own Ghostty-format terminal config)」仍是 `~/.config/cmux/config.ghostty`。

## 版权与署名

本项目是 [agents-infra](https://github.com/xhqing/agents-infra) 的一部分，以
[MIT 许可证](../LICENSE.md) 发布。

Copyright (c) 2026 xhqing and contributors。
