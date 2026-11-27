# goal

给当前会话挂一个**可验证的完成条件**，会话每轮结束后自动判断是否该继续，不需要你反复说「继续」。

行为对齐 Codex CLI 的 `/goal`（`codex-rs/ext/goal`）：一个会话一个 goal、跨轮持久、token 预算核算、模型可用工具标记完成或阻塞。

## 命令

```text
/goal <objective>        设置（或替换）goal，并立刻开始
/goal                    查看当前状态
/goal pause              暂停
/goal resume             恢复并继续
/goal edit               在编辑器里改写 objective
/goal budget <tokens>    设置 token 预算（0 = 取消）
/goal clear              删除
/goal help               用法
```

在设置的同时指定预算：`/goal <objective> --budget 200000`。

## 模型侧工具

| 工具 | 作用 |
|---|---|
| `create_goal` | 只有用户或系统明确要求时才建；已有未完成 goal 时会失败 |
| `get_goal` | 读状态、预算、token 与耗时用量、剩余预算 |
| `update_goal` | 只能设为 `complete` / `blocked` / `paused`；`paused` 仅限用户明确要求；`blocked` 要求同一阻塞连续出现三轮 |

`resume`、预算超限、用量超限这些状态只能由用户或系统设置，模型动不了。

## 自动续跑怎么触发

- 每轮 agent run 结束（`agent_end`）时，若 goal 仍是 `active` 且没超预算，就排一条 continuation 消息（`followUp`），Pi 会接着开下一轮。
- 续跑用的提示词要求模型：不得把目标缩水成当下能做完的小事、每轮先做无进展检查、声称完成前必须逐条对证据审计、`blocked` 必须连续三轮同一阻塞。
- 续跑消息每轮重新生成，但旧副本会从上下文里剔掉，只保留最新一份，避免长任务把上下文撑爆。

停止条件：完成 / 阻塞 / 预算耗尽 / 用户 pause 或 clear / 连续 3 轮没有工具调用（自动停、保留 goal 等你介入）。

## 状态与文件

- 状态按会话隔离，写在 `~/.pi/agent/state/goal/<sessionId>.json`。
- 会话 resume 时自动读回；status 仍是 `active` 的 goal 不会自己开跑，等你发一条消息或 `/goal resume`。
- `/goal clear` 会删掉状态文件。

## 统计口径

- `tokensUsed` 累加每轮 `usage.totalTokens`，**含缓存读取**，而且一次「轮次」= 一次 agent run，run 内每次工具往返都是一次完整 LLM 调用。所以单轮十几万 token 很正常，数字明显大于「实际新增 token」。
- 因此预算要按「每轮 10 万到 20 万」估，不要按任务本身的产出量估。设几百到几千会一轮就烧穿。
- `costUsed` 来自各轮 `usage.cost.total`，显示为 US$。
- 预算是在每轮结束时核算的，所以至少会跑完当前这一轮；超限后会再跑一轮收尾（总结进展、给出下一步），然后停在 `budget_limited`。

## 与 Codex 的差异

| 方面 | Codex | 本扩展 |
|---|---|---|
| 完成判定 | 工作模型按提示词审计后调 `update_goal` | 相同 |
| 续跑调度 | 线程空闲时由 runtime 拉起 | `agent_end` 排队 `followUp` |
| 持久化 | SQLite `thread_goals` 表 | 每会话一个 JSON 文件 |
| 外部接口 | app-server `thread/goal/set|get|clear` | 只有命令与工具，无 RPC |
| 界面 | 底部进度行 + 按钮 | footer 状态行（`◎ goal 3t 50k/200k tok`） |

## 已知边界

- `ctx.mode` 为 `print` / `json` 时没有 UI，`/goal` 的状态输出不可见，但 goal 本身照常工作并会跑完整条链。
- 连续三轮没有工具调用就自动停，这是防烧钱闸门，不是 bug。
- 中断（Esc）会把 goal 置为 paused，需要 `/goal resume` 才继续。
