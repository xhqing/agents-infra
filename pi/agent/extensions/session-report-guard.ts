/**
 * session-report-guard —— 禁止汇报别的会话的内容（2026-11-17 用户立规，工具强制）。
 *
 * 用户原话：「禁止汇报别的 session 的内容，全局工具强制」。
 * 立规起因：main-wip 自动搬运那一轮，我把同一目录下另一个 subagent 正在做的公式修复、
 * 它开的 PR #82、它建的 worktree 全写进了汇报——用户问的是 Threads 的问题，看到的是
 * 一堆跟他无关的会话动态。
 *
 * 规矩的本质：**用户只看得到自己这条会话**，别的 pi 会话（同目录 subagent、agent_call
 * 对象、tmux 后台会话）对他而言不存在。把它们的进展念给他听，等于拿别人的工作占用他
 * 的注意力。
 *
 * 三层实现（与 redundant-ask-guard 同一套思路）：
 *   ① 预防：before_agent_start 把规则追加进系统提示（每轮生效，防止上下文里那条读漏）。
 *   ② 数据源硬拦：tool_call 拦「读别的会话记录 / 枚举其它会话」的 bash 命令——
 *      拿不到别的会话的状态，就写不出它的汇报。逃生门 `# AI_AUTHORIZED_SESSION_READ`
 *      （仅用户当轮授权）＋ 用户当轮主动问起时自动放行。
 *   ③ 回复硬改：message_end 逐行检查回复，命中「另一个会话 / 它的 PR / 它建了」这类
 *      描述的整行删掉，末尾补一句中性说明；同时给 AI 下一轮投一条 display:false 回执
 *      （只进 AI 上下文，用户界面看不到）。
 *
 * 边界（写清楚，避免把正常说明也砍掉）：
 *   - 本会话发起的委派可以说一句（「已交给 Atlas，等它回」）——那是本会话的动作；
 *     它的回复内容、它的做事过程不转述。
 *   - 别的会话挡路时只说最小必要事实（「有未提交改动没进 main，已停止收尾」），
 *     不说是谁在做什么。
 *   - 用户当轮主动问起其它会话（问进展、问谁在做）→ 本轮不拦。
 *
 * 局限（诚实）：判定靠文本模式，「会话」这个词在中文里也用来说群聊，可能误伤；用户当轮
 * 提问放行、以及只删整行而不动其它内容，是两道兜底。它挡的是典型的汇报形态，不是银弹。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 用户本轮主动问起其它会话时，整轮放行。 */
const USER_ASKS_RE =
	/(其它|其他|别|另外|各个|哪些)\s*(会话|session)|会话\s*(列表|状态|进展)|谁在做|谁在改|还有谁|subagent|另一个\s*(会话|agent)|它在做什么/;

/** 会话身份的确定性标识：出现这些基本就是在报别人的会话。 */
const SESSION_ID_RE =
	/subagent-chat-[0-9a-f]{6,}|\bintercom\s+list\b|pi-intercom\s+list|\btmux\s+%[0-9]+/i;

/** 「别的会话」指代：必须带限定词，避免误伤「群聊会话」这类正常用法。 */
const OTHER_SESSION_RE = /(另一个|另一条|其它|其他|别的|对方)\s*(会话|session|subagent|主工作区会话)/i;

/** 转述别的会话的动作 / 产出。 */
const OTHER_ACTION_RE =
	/(它的|对方的|该会话的|那条会话的)\s*(PR|pull request|worktree|分支|提交|改动|进展|产出)|它(建了|提交了|改了|正在|还在|已经|那边)|对方(建了|提交了|改了|正在|那边)/;

/** 命中任一 → 该行属「汇报别的会话」。 */
function isOffendingLine(line: string): boolean {
	if (SESSION_ID_RE.test(line)) return true;
	return OTHER_SESSION_RE.test(line) || OTHER_ACTION_RE.test(line);
}

/** 从消息里取第一个 text part 的文本。 */
function textOf(message: unknown): string {
	try {
		const content = (message as { content?: unknown })?.content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map((part) => {
				const p = part as { type?: string; text?: string };
				return p?.type === "text" && typeof p.text === "string" ? p.text : "";
			})
			.filter(Boolean)
			.join("\n");
	} catch {
		return "";
	}
}

/** 把消息里第一个 text part 换成新文本（保持 role 不变）。 */
function replaceText(message: unknown, text: string): unknown {
	const msg = message as { content?: unknown } & Record<string, unknown>;
	const content = msg.content;
	if (typeof content === "string") return { ...msg, content: text };
	if (!Array.isArray(content)) return message;
	let done = false;
	const parts = content.map((part) => {
		const p = part as { type?: string; text?: string };
		if (!done && p?.type === "text" && typeof p.text === "string") {
			done = true;
			return { ...p, text };
		}
		return part;
	});
	return { ...msg, content: parts };
}

/** 命令里带读动词才算「读会话记录」，纯路径提到（如 cd）不算。 */
const READ_VERB_RE = /\b(cat|bat|less|more|head|tail|grep|rg|ag|find|ls|stat|wc|jq|python3?|node|open)\b/;

/** 会话记录 / 会话枚举的路径与命令。 */
const SESSIONS_PATH_RE = /\.pi\/agent\/sessions|\.pi\/agent\/state\/worktrees\.jsonl/;
const TMUX_ENUM_RE = /\btmux\s+(ls|list-sessions|list-panes|list-clients)\b/;
const SESSION_CLI_RE = /\b(pi-intercom|intercom)\s+(list|ls)\b/;

/** 待注入给 AI 的回执（下一轮 before_agent_start 消费，用户看不到）。 */
let pendingReminder: string | null = null;

/** 用户本轮提示词（判断「是不是他自己问的」）。 */
let currentPrompt = "";

const BRIEF =
	"【禁止汇报别的会话的内容（2026-11-17 用户立规，工具强制）】\n" +
	"回复里只讲**本会话**做了什么和用户这笔任务的结果。其它 pi 会话（同目录 subagent、agent_call 对象、tmux 后台会话）在做什么、产出了什么、开了哪个 PR、建了哪个 worktree，一律不写进回复。\n" +
	"- 自己发起的委派可以说一句（「已交给 Atlas，等回复」），但不转述对方的回复内容与做事过程。\n" +
	"- 被别的会话的未完成改动挡住时，只说最小必要事实（「有改动还没进 main，已停止收尾」），不说是谁在做什么。\n" +
	"- 用户当轮主动问起其它会话时，按他的问题回答。\n" +
	"- 工具层：读 ~/.pi/agent/sessions 记录、枚举其它会话的命令会被拦（逃生门 # AI_AUTHORIZED_SESSION_READ）；回复里命中「另一个会话 / 它的 PR / 它建了」的行会被直接删除。";

export default function (pi: ExtensionAPI) {
	// ① 预防 + 回执注入
	pi.on("before_agent_start", async (event) => {
		try {
			currentPrompt = String((event as { prompt?: unknown })?.prompt ?? "");
			const result: Record<string, unknown> = {};

			if (pendingReminder) {
				result.message = {
					customType: "session-report-guard",
					content: pendingReminder,
					display: false, // 只进 AI 上下文，用户界面不显示
				};
				pendingReminder = null;
			}

			const prompt = String((event as { systemPrompt?: unknown })?.systemPrompt ?? "");
			if (prompt && !prompt.includes("【禁止汇报别的会话的内容")) {
				result.systemPrompt = `${prompt}\n\n${BRIEF}`;
			}

			return Object.keys(result).length > 0 ? result : undefined;
		} catch {
			// 注入失败不影响会话
		}
	});

	// ② 数据源硬拦：拿不到别的会话的信息，就写不出它的汇报
	pi.on("tool_call", async (event) => {
		try {
			const e = event as { toolName?: string; args?: { command?: unknown } };
			if (e.toolName !== "bash") return;
			const cmd = String(e.args?.command ?? "");
			if (!cmd) return;
			if (cmd.includes("AI_AUTHORIZED_SESSION_READ")) return;
			if (currentPrompt && USER_ASKS_RE.test(currentPrompt)) return; // 用户自己问的，放行

			const hitsRecords = SESSIONS_PATH_RE.test(cmd) && READ_VERB_RE.test(cmd);
			const hitsTmux = TMUX_ENUM_RE.test(cmd);
			const hitsCli = SESSION_CLI_RE.test(cmd);
			if (!hitsRecords && !hitsTmux && !hitsCli) return;

			return {
				block: true,
				reason:
					"这条命令会读取 / 枚举别的 pi 会话（会话记录、tmux 会话列表或 intercom 列表）。\n" +
					"用户 2026-11-17 立规：禁止汇报别的 session 的内容，这类数据源默认不碰。\n" +
					"要么按本会话自己的信息完成任务，要么请用户当轮明确提出需要（他会主动问）；确需执行时命令末尾加 `# AI_AUTHORIZED_SESSION_READ`（仅限用户当次授权）。",
			};
		} catch {
			// 判定异常时不阻塞
		}
	});

	// ③ 回复硬改：删掉汇报别的会话的行，并给 AI 留一条回执
	pi.on("message_end", async (event) => {
		try {
			const message = (event as { message?: { role?: string } })?.message;
			if (message?.role !== "assistant") return;
			if (currentPrompt && USER_ASKS_RE.test(currentPrompt)) return; // 用户问的，不拦

			const text = textOf(message);
			if (!text) return;

			const lines = text.split("\n");
			const kept: string[] = [];
			const removed: string[] = [];
			for (const line of lines) {
				if (isOffendingLine(line)) removed.push(line.trim());
				else kept.push(line);
			}
			if (removed.length === 0) return;

			let cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
			cleaned += "\n\n（已隐去其它会话的内容）";

			pendingReminder =
				"【session-report-guard 回执】你上一轮回复里有 " +
				removed.length +
				" 行在汇报别的会话的内容，已被删除。示例：" +
				JSON.stringify(removed[0].slice(0, 80)) +
				"\n用户 2026-11-17 立规：别的会话在做什么、产出了什么、开了哪个 PR，一律不写进回复。" +
				"本会话自己的动作与结果照常汇报；被其它改动挡住时只说最小事实。";

			return { message: replaceText(message, cleaned) };
		} catch {
			// 判定异常时不阻塞会话
		}
	});
}
