# ghostty-watch

监控本机 ghostty 进程，**在被系统杀掉时留下明确记录并让你事后一定知道**。

## 为什么需要

macOS 内核的 memorystatus 高水位（high watermark）机制会在内存紧张时直接 `SIGKILL` 掉「占用超过自身水位」的 GUI 进程。ghostty 被杀时：不弹窗、不崩溃、不写崩溃报告，窗口凭空消失。8GB 机器 swap 常年吃满时这会发生（2026-11-15 16:27 实测被杀过一次，占用 477MB、峰值 566MB）。

tmux 解决的是「工作不丢」；本工具解决的是「**是否被杀过、什么时候、丢了哪几个会话**」。

## 它做什么

一个 LaunchAgent 常驻（每 5 秒一轮）：

1. 扫 ghostty 进程与其子会话（每个 surface 一个子进程）；
2. 某个 PID 消失时按证据链归因：

| 证据 | 判定 |
|---|---|
| 所有会话都有 `zshexit` 的 `exit` 记录 | 手动退出（正常） |
| unified log 里有该 PID 的 `memory high watermark` 记录 | **被系统杀掉**（内核内存高水位 SIGKILL） |
| 出现该 PID 的崩溃报告（按 pid / procPath 精确匹配） | 崩溃 |
| 当时的 JetsamEvent 里含该 PID | **被系统杀掉**（jetsam 内存回收） |
| 无硬证据、但当时内存压力 ≥ warning | 很可能是被系统杀掉 |
| 无硬证据、压力也正常 | 无法判定（可能你手动关的） |

3. 事件写入 `~/.local/state/ghostty-watch/events.log`，同时留一条 pending；
4. **通知走四条渠道，按可靠性递降**：

| 渠道 | 时机 | 说明 |
|---|---|---|
| **飞书** | 立即 | **主渠道**，手机同步收到。走 `lark-cli` 的 bot 身份（不依赖 user token）；日志回写 message_id |
| terminal-notifier | 立即 | 带 bundle 的 app，需在系统设置里给它开通知权限（当前未授权） |
| osascript | 立即 | 必须注入 `__CFBundleIdentifier`，否则 LaunchAgent 里会被 usernoted 静默丢弃。来源显示为「脚本编辑器」 |
| 提示音 Basso | 立即 | 前几条全失败时播放 |
| 终端横幅 | 下次开终端 | **100% 不会漏**：pending 在提示符前打印成红框 |

每次事件都会在日志里写一行「通知：…」，如实记录走的哪条渠道、失败原因是什么。飞书消息正文带原因、峰值内存、丢失的会话列表（含目录与最后执行的命令）。

### 飞书通知

- 走 `lark-cli --profile nancy im +messages-send --as bot`，对你的 open_id 发单聊；机器人身份用应用凭证，不受 user token 过期影响。
- **发送方固定是 Nancy（Kit 的助手），不是 Linda**（2026-11-15 用户立：Linda 是 Victor 的专属 assistant，这个通知与本机工具链无关，不该蹭 Victor 的机器人）。
- open_id 是**应用维度**的个人标识——同一个人在不同应用下 open_id 不同。代码里不写它（本目录会镜像到公开仓库），只写在**本机** `~/.local/state/ghostty-watch/config.json` 的 `feishu_profile` / `feishu_open_id` 两个字段里；换应用必须成对改，否则飞书报 `99992361`（脚本会把这条单独提示出来）。
- 首次部署时若 config 缺 open_id，先给 Nancy 这个 profile 做一次用户授权（`lark-cli auth login --profile nancy`），脚本会自己从 `auth status` 读；也可以直接把 open_id 填进 config.json。
- 前提：本机 `lark-cli` 里有名为 `nancy` 的 profile（`lark-cli profile list` 可查）。缺了就加：`lark-cli profile add --name nancy --app-id <Nancy 的 App ID> --app-secret-stdin`。
- 飞书域名必须直连：脚本内已强制 `NO_PROXY=feishu.cn,.feishu.cn,larksuite.com,...`。
- 临时关掉飞书（只留桌面通知）：在 config.json 里加 `"feishu_disabled": true`。
- 发送失败会在事件日志里写具体原因（权限不足 / 超时），并自动回退到桌面通知。

## 安装 / 卸载

```bash
bash ~/.pi/agent/patch/ghostty-watch/install.sh
bash ~/.pi/agent/patch/ghostty-watch/install.sh --status
bash ~/.pi/agent/patch/ghostty-watch/install.sh --uninstall
```

安装内容：`~/Library/LaunchAgents/com.xhq.ghostty-watch.plist` + `~/.zshrc` 里一段被 `# >>> ghostty-watch >>>` 标记包裹的 source 行。卸载会把两者一起撤掉，事件日志保留。

## 日常用法

```bash
python3 ~/.pi/agent/patch/ghostty-watch/watch.py status   # 当前 ghostty、各会话 cwd 与最近命令
python3 ~/.pi/agent/patch/ghostty-watch/watch.py log -n 30 # 历史事件
python3 ~/.pi/agent/patch/ghostty-watch/watch.py once      # 单轮扫描（调试）
```

事件日志样例：

```
2026-11-15 16:27:58  DIED   ghostty pid=80999  原因=被系统杀掉（内核内存高水位 memorystatus / SIGKILL）  峰值≈566MB  会话=3个
          └─ /Users/xhq/Developer/dev-agent (zsh) [最近: pi]
          └─ /Users/xhq/Developer/cmux (zsh)
          └─ /Users/xhq (zsh)
2026-11-15 16:30:34  START  ghostty pid=90129  (ghostty)
```

## 局限（不吹牛）

- **它不能阻止被杀**。macOS 上没有能让第三方进程豁免内存水位的官方开关（SIP 开着时更不可能）。本工具只负责「让这件事一定被看见」。
- 想彻底不丢工作仍然是 tmux：`tmux new -s work`，ghostty 没了再 `tmux attach`。
- 「哪个窗口」的定位靠 shell 心跳（cwd + 最近一条命令），不依赖窗口标题，也不需要辅助功能权限。
- 系统通知的来源显示成「脚本编辑器」（osascript 的身份），标题里会写清「ghostty 被终止」。飞书才是主渠道，桌面通知只是备用。
- 系统日志的 debug 级记录有保留窗口限制（通常数小时），所以归因在**事件发生时**完成并落盘，事后看 `events.log` 即可，不必再翻 `log show`。

## 自检

```bash
python3 ~/.pi/agent/patch/ghostty-watch/watch.py feishu-test   # 给飞书发一条测试消息
python3 ~/.pi/agent/patch/ghostty-watch/watch.py notify-test   # 跑完整通知链
```

## 依赖

纯标准库 + `/usr/bin/python3`（macOS 自带），不需要 pip。

- **必需**：`lark-cli`（`~/.local/bin/lark-cli`，飞书通知），且其中要有名为 `nancy` 的 profile（Nancy 应用的凭证）。缺了就只有桌面通知 + 终端横幅，事件日志会写明原因。
- 可选：`brew install terminal-notifier` + 系统设置里授权（不装也不影响）。
