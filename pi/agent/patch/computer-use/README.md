# computer-use 启动器

`computer-use-mcp` 是 pi 全局 MCP 配置（`~/.pi/agent/mcp-adapter.json` 的 `open-computer-use`）调用的启动器。

## 为什么需要它

`~/.pi/agent` 由 MacBook 与 macmini 共用（Syncthing 双向同步），但两台机器的 node 与全局包路径不同（本机 `/opt/homebrew/bin`、macmini `~/.local/node/bin`）。`mcp-adapter.json` 里没法写死绝对路径，所以由本脚本按顺序探测：

1. `$HOME/.local/node/bin`、`/opt/homebrew/bin`、`/usr/local/bin`、`$HOME/.npm-global/bin` 里的 `open-computer-use`；
2. 都没有就退回 `npx` 拉固定版本 `@qwen-code/open-computer-use@0.2.3`（固定版本避免行为漂移）。

## 配置形态

```json
{
  "mcpServers": {
    "open-computer-use": {
      "command": "/bin/sh",
      "args": ["-c", "exec \"$HOME/.pi/agent/patch/computer-use/computer-use-mcp\" mcp"]
    }
  }
}
```

用 `/bin/sh -c` 的理由：配置里可以写 `$HOME`，两机共用同一份文件。

## 安装与授权（新机器）

```bash
npm i -g @qwen-code/open-computer-use@0.2.3
open-computer-use permission-status   # 看权限状态
open-computer-use doctor              # 引导打开授权页面
```

要求 **macOS 14.0+**（二进制 `minos=14.0`，更低版本一启动就 dyld 崩溃）。首次使用需在「系统设置 → 隐私与安全性」授予**辅助功能**与**屏幕录制**——TCC 授权只能人工点，脚本改不了。

## 使用规则

- **macmini**（专用自动化机）：直接可用，无需授权。
- **本机**（用户正在使用的 MacBook）：必须先取得用户当次明确授权——命令末尾加 `# AI_AUTHORIZED_LOCAL_COMPUTER_USE`，或创建 `~/.pi/agent/state/local-computer-use-allow`（用完删除）。
- 工具强制：`~/.pi/agent/extensions/computer-use-guard.ts`；规则正文见全局 `AGENTS.md`「电脑操作（computer-use）」节。
