# ghostty-watch

监控本机 ghostty 进程，**在被系统杀掉时留下明确记录并让你事后一定知道**。

## 为什么需要

macOS 内核的 memorystatus 高水位（high watermark）机制会在内存紧张时直接 `SIGKILL` 掉「占用超过自身水位」的 GUI 进程。ghostty 被杀时：不弹窗、不崩溃、不写崩溃报告，窗口凭空消失。8GB 机器 swap 常年吃满时这会发生（2026-11-15 16:27 实测被杀过一次，占用 477MB、峰值 566MB）。

tmux 解决的是「工作不丢」；本工具解决的是「**是否被杀过、什么时候、丢了哪几个会话**」。

## 它做什么

一个 LaunchAgent 常驻（每 5 秒一轮）：

1. 扫 ghostty 进程与其子会话（每个 surface 一个子进程）；
2. 某个 PID 消失时按证据链归因：

| 证据 | 判定 | 是否立即通知 |
|---|---|---|
| 所有会话都有 `zshexit` 的 `exit` 记录（含**关掉最后一个窗口**的正常退出） | 手动退出（正常） | 不通知 |
| unified log 里有该 PID 的 `memory high watermark` 记录 | **被系统杀掉**（内核内存高水位 SIGKILL） | 通知 |
| 出现该 PID 的崩溃报告（按 pid / procPath 精确匹配） | 崩溃 | 通知 |
| 当时的 JetsamEvent 里含该 PID | **被系统杀掉**（jetsam 内存回收） | 通知 |
| 无硬证据、进程消失时内存压力**危急**（4） | 很可能被系统杀掉 | 通知 |
| 无硬证据、压力只到**警告**（2）或更低 | 无法判定（多半是你手动关闭） | 只记日志 + 终端横幅 |

**判「死了」三件套（2026-11-25 加，起因是两次误报）**：

1. **扫描失败不算死亡**：`ps` 超时 / 返回空 / 一行都解不出时，本轮整体跳过判定，只在状态翻转时记一条 WARN。旧实现把「没看到」当成「没了」，11-24 与 11-25 各误报一次，两次都是同一个 pid 判 DIED 后 11~22 秒又以**完全相同的 pid** START——同一次启动不可能先死后生。
2. **连续 3 轮（≈15 秒）看不到 + `os.kill(pid, 0)` 单独复核**：单轮抖动不算数；复核查不动时按「还活着」处理，宁可漏报也不误报。
3. **同 pid 复活即撤销**：判死时记下该进程的启动时刻（`ps -o lstart=`），同 pid 若以同一启动时刻再次出现，自动删掉对应 pending 并在事件日志里留一条 `WARN 误报更正`。

内存压力「警告」在 8GB 机器上几乎是常态，所以**不能单独当被杀证据**：2026-11-19 用户手动关掉最后一个窗口正常退出，就被这条误报成「很可能是被系统杀掉」并推了飞书。另外，ghostty 的直接子进程是一层 login 包装，shell 心跳记的是真正的 zsh pid，两者不同，所以 exit 记录必须按「父 pid / tty」宽匹配——只按 pid 匹配会漏掉真实 exit 记录，把正常退出误判成被杀。

3. 事件写入 `~/.local/state/ghostty-watch/events.log`；只有「有系统终止证据」或「无法判定」的事件才额外留一条 pending（**下次开 Ghostty 终端**时在提示符前打印，手动退出不留）。**只在 Ghostty 里打印**：cmux 内嵌 libghostty、`TERM_PROGRAM` 同样是 `ghostty`，所以 hook 额外检查 `CMUX_BUNDLE_ID`（2026-11-25 用户立：在 cmux 里开终端弹 ghostty 的退出提示毫无意义）；其它终端也不打印，pending 原样保留给下次真开 Ghostty。
4. **通知走四条渠道，按可靠性递降**（仅「有系统终止证据」的事件会推送；手动退出只记日志，无法判定的事件只写终端横幅、不推手机）：

| 渠道 | 时机 | 说明 |
|---|---|---|
| **飞书** | 立即 | **主渠道**，手机同步收到。走 `lark-cli` 的 bot 身份（不依赖 user token）；日志回写 message_id |
| terminal-notifier | 立即 | 带 bundle 的 app，需在系统设置里给它开通知权限（当前未授权） |
| osascript | 立即 | 必须注入 `__CFBundleIdentifier`，否则 LaunchAgent 里会被 usernoted 静默丢弃。来源显示为「脚本编辑器」 |
| 提示音 Basso | 立即 | 前几条全失败时播放 |
| 终端横幅 | 下次开 Ghostty | **100% 不会漏**（只要你还会开 Ghostty）：pending 在提示符前打印成红框；cmux / iTerm / Terminal.app 等别的终端不打印，也不消费 pending |

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
          └─ /Users/xhq/Developer/dev-agent (zsh) [最近: pi] [pi 会话 01a1f257]
          └─ /Users/xhq/Developer/cmux (zsh)
          └─ /Users/xhq (zsh)
2026-11-15 16:30:34  START  ghostty pid=90129  (ghostty)
```

## 崩溃后怎么恢复

每条会话记录带三类线索：目录、最近执行的命令、窗口里在跑的 pi 会话 id（`[pi 会话 01a1f257]`）。按线索恢复：

- **有 pi 会话 id** → 精确恢复那一次：`cd <目录> && pi --session 01a1f257`（支持 UUID 前缀）。
- **只有目录和命令** → 到该目录里 `pi -r` 自己挑。
- **别用 `pi -c`**：`-c` 接的是「这个项目最近一次会话」，而同一个项目常同时开好几个（还有开在 cmux 里的），未必是丢掉的那个（2026-11-19 用户指出）。
- ghostty 自己救不回窗口：被 SIGKILL 时没有保存态（`window-save-state` 只在正常退出时写盘），窗口只能靠上面的记录手动重建。

## 局限（不吹牛）

- **它不能阻止被杀**。macOS 上没有能让第三方进程豁免内存水位的官方开关（SIP 开着时更不可能）。本工具只负责「让这件事一定被看见」。
- 想彻底不丢工作仍然是 tmux：`tmux new -s work`，ghostty 没了再 `tmux attach`。
- **横幅只在 Ghostty 自己的终端里出现**：cmux 等终端不打印、也不消费 pending。代价是「如果你从此不再用 Ghostty」，pending 就没人看到了——事件日志与飞书通知仍在。
- 「哪个窗口」的定位靠 shell 心跳（cwd + 最近一条命令，现在还有 pi 会话 id），不依赖窗口标题，也不需要辅助功能权限。心跳按 tty 落文件、会话按 tty 或父 pid 对回 ghostty 的子进程（直接子进程是 `login` 包装层，pid 与真正跑命令的 shell 不同）。
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
