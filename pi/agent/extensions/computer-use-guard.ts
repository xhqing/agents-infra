/**
 * computer-use 本机授权守卫（全局，2026-11-18 用户立）
 *
 * 规则（细则见 AGENTS.md「电脑操作（computer-use）」节）：
 *   - computer-use 能力已装进 pi 全局：`mcp-adapter.json` 的 `open-computer-use`
 *     经 `~/.pi/agent/bin/computer-use-mcp` 本地拉起（两台机器共用同一份配置）；
 *   - **macmini**（专用自动化机）上直接可用，不需要授权；
 *   - **本机**（用户正在使用的 MacBook）上使用，必须先取得用户当次明确授权——
 *     GUI 自动化会真实占用屏幕、移动鼠标、夺走焦点，落到用户正在操作的屏幕上就会打断他。
 *
 * 两条拦截路径：
 *   A) bash：本机执行 open-computer-use 的命令形态（子命令 / npx 拉包 / app 二进制 / open app）；
 *   B) MCP：open-computer-use 的工具调用（mcp 网关形态或直连工具名）。
 *
 * 本机放行条件（满足其一）：
 *   ① 命令末尾带标记 `# AI_AUTHORIZED_LOCAL_COMPUTER_USE`（仅限用户当次授权）；
 *   ② 存在授权文件 `~/.pi/agent/state/local-computer-use-allow`（用完删除）。
 *
 * 环境变量 `PI_COMPUTER_USE_HOST=macmini|local` 可覆盖 hostname 判定（调试用）。
 * 判定异常时不阻塞会话（与 twitter-guard / focus-guard 同一约定：fail open）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

const BASH_MARK = "AI_AUTHORIZED_LOCAL_COMPUTER_USE";

/** 本机授权文件：存在即视为用户已授权本次本机使用（用完删除）。 */
function allowFile(): string {
	return join(process.env.HOME ?? "", ".pi", "agent", "state", "local-computer-use-allow");
}

/** 是否运行在 macmini（专用自动化机）：true 时一切 computer-use 调用放行。 */
function onMacmini(): boolean {
	const override = (process.env.PI_COMPUTER_USE_HOST ?? "").toLowerCase();
	if (override === "macmini" || override === "local") return override === "macmini";
	try {
		const h = hostname().toLowerCase();
		return h.includes("mac-mini") || h.includes("macmini");
	} catch {
		return false;
	}
}

// —— bash 侧：会落到本机屏幕的 open-computer-use 命令形态 ——
// 模式都要求「命令位 + 子命令 / 拉包形态」，避免把文档文本、grep / cat 的路径参数误判成调用。
// 子命令白名单不含 help / version / install-*（查帮助、看版本、改配置都不是 GUI 操作）。
const SUB = "mcp|doctor|call|snapshot|list-apps|permission-status|turn-ended";
// 裸命令 / 路径形式：open-computer-use <子命令>（含 -mcp 别名）
const CLI_SUB = new RegExp(`(?:^|[\\s;&|(])(?:[\\w.~/-]*/)?open-computer-use(?:-mcp)?\\s+(?:${SUB})\\b`);
// 裸命令（不带子命令）：会拉起授权引导界面，同样算 GUI 动作；
// 只认真正的命令位（行首 / ; && || | 之后），避免 `which open-computer-use` 这类查询被误拦。
const CLI_BARE = new RegExp(
	`(?:^|&&|\\|\\||;|\\|)\\s*(?:(?:sudo|env|nice|nohup|time)\\s+)*(?:[\\w.~/-]*/)?open-computer-use(?:-mcp)?\\s*(?:$|&&|\\|\\||;|\\|)`,
);
// npx / npm exec 拉取运行（不论参数）
const NPX_RUN = /(?:^|[\s;&|(])(?:npx|npm\s+(?:exec|x))(?:\s|$)[^;&|]*@qwen-code\/open-computer-use/;
// 原生二进制（app bundle 内的可执行文件）直跑
const APP_BIN = new RegExp(`(?:^|[\\s;&|(])(?:[\\w.~/-]*/)?OpenComputerUse\\s+(?:${SUB})\\b`);
// open 直接打开 app（含 `open -a "Open Computer Use"` 与 .app 路径两种形态）
const APP_OPEN = /(?:^|[\s;&|(])open\s+[^;&|]*Open Computer Use/;

function bashHit(command: string): boolean {
	return (
		CLI_SUB.test(command) ||
		CLI_BARE.test(command) ||
		NPX_RUN.test(command) ||
		APP_BIN.test(command) ||
		APP_OPEN.test(command)
	);
}

// —— MCP 侧：open-computer-use 的工具名 ——
const CU_TOOLS = new Set([
	"list_apps",
	"get_app_state",
	"click",
	"drag",
	"scroll",
	"type_text",
	"press_key",
	"set_value",
	"perform_secondary_action",
]);

const BASH_REASON =
	"[computer-use-guard] 已拦截：本机使用 computer-use 需用户当次明确授权（2026-11-18 用户立）。" +
	"正确做法：① 能不本机就别本机——computer-use 落到本机屏幕会抢焦点、打断用户；需要 GUI 自动化时优先用 macmini（那边直接可用）。" +
	"② 确需本机——先向用户说明理由，取得当次授权后：命令末尾加 `# AI_AUTHORIZED_LOCAL_COMPUTER_USE`，" +
	"或创建授权文件 `~/.pi/agent/state/local-computer-use-allow`（用完删除）。";

const MCP_REASON =
	"[computer-use-guard] 已拦截：本机 MCP 调用 computer-use 需用户当次明确授权（2026-11-18 用户立）。" +
	"先向用户说明理由并取得授权，然后创建 `~/.pi/agent/state/local-computer-use-allow` 再重试（用完删除）；" +
	"或改在 macmini 上执行（macmini 无需授权）。";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		try {
			if (onMacmini()) return; // macmini：直接可用

			const name = event.toolName ?? "";

			// A) bash：命令级拦截
			if (name === "bash") {
				const command = (event.input as { command?: string } | undefined)?.command ?? "";
				if (!command || !bashHit(command)) return;
				if (command.includes(BASH_MARK)) return; // 用户当次授权标记
				if (existsSync(allowFile())) return; // 用户当次授权文件
				return { block: true, reason: BASH_REASON };
			}

			// B) MCP：工具调用拦截
			const input = (event.input ?? {}) as { server?: unknown; tool?: unknown };
			const isGateway = name === "mcp";
			const isCuNamespace = /open[_-]?computer[_-]?use/i.test(name);
			const isDirectCuTool = CU_TOOLS.has(name);
			const targetsCu =
				isCuNamespace ||
				isDirectCuTool ||
				(isGateway &&
					(input.server === "open-computer-use" || CU_TOOLS.has(String(input.tool ?? ""))));
			if (!targetsCu) return;
			if (existsSync(allowFile())) return; // 用户当次授权文件
			return { block: true, reason: MCP_REASON };
		} catch {
			// 判定异常时不阻塞会话（与既有 guard 一致）
		}
	});
}
