/**
 * 后台进程一律在 tmux 里跑（2026-11-16 用户立，工具强制）。
 *
 * 用户原话：「在启动后台进程的时候所有后台进程都必须在 tmux 里面运行，这样保证工作
 * 不丢（即使当前前台窗口挂了）」「不论是本机还是 macmini，后台进程都要在 tmux 里面运行」。
 *
 * 为什么必须工具强制：`cmd &` / `nohup cmd &` / `setsid` 这类写法把进程挂到终端或 1 号
 * 进程下，看起来「放后台了」，但 pi 窗口一关、终端一挂、SSH 一断，任务就跟着没——
 * 长构建跑到一半白跑。tmux 会话独立于终端存活，窗口挂了任务照跑、日志照写。
 *
 * 本守卫拦两条入口（都是「AI 自己能启动后台进程」的地方）：
 *   ① `bash` 工具——本机 shell；
 *   ② `macmini_run` 工具——远端 shell（远端同样是终端会话，断了任务就没了）。
 *
 * 合法写法（不拦）：
 *   - `background_run`：扩展内部已经用 `tmux new-session -d` 启动，AI 不用自己加 tmux；
 *   - 命令里出现 tmux（`tmux new-session -d -s pi-xxx …` 自己包一层）；
 *   - 命令里有 `wait`（后台起、返回前等它，属于同步用法，不会丢）；
 *   - 命令末尾带逃生标记 `# AI_AUTHORIZED_BG_NO_TMUX`（仅限用户当次授权：例如确实要
 *     一个不受 tmux 管理的守护进程）。
 *
 * 判定细节：
 *   - `nohup` / `setsid` / `disown` / `start-stop-daemon` / `daemonize` 等关键词在**原文**
 *     里扫（这些词出现在引号里通常也是真的要后台运行，例如 `ssh host 'nohup x &'`）；
 *   - 单纯的后台符号 `&` 只在**去掉引号与 heredoc 正文之后**扫，避免 `echo "a & b"`、
 *     `awk '{print $1 & $2}'` 这类误报；同时排除 `&&`、`2>&1`、`&>`、`|&` 等合法形态。
 *   - 已知局限（诚实声明）：`bash -c "cmd &"`、`ssh host 'cmd &'` 这种把 `&` 塞进引号里
 *     的间接写法识别不到——本守卫是下限防线，判断仍靠本规则。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 逃生标记：命令末尾加它才放行（仅限用户当次授权）。 */
export const MARKER = "# AI_AUTHORIZED_BG_NO_TMUX";

/** 只要出现这些命令，就说明在把进程脱离终端（不论有没有 `&`）。 */
const DETACH_WORDS = /\b(nohup|setsid|disown|start-stop-daemon|daemonize)\b/;

/** 命令里是否已经有 tmux 参与（自己包了一层）。 */
const HAS_TMUX = /(^|[^A-Za-z0-9_-])tmux([^A-Za-z0-9_-]|$)/;

/**
 * 把引号内容与 heredoc 正文挖掉，只留真正会被 shell 当成语法的部分。
 * 目的：只对「真的会后台运行」的 `&` 报错，不被字符串里的 `&` 干扰。
 */
export function stripQuoted(src: string): string {
	let out = "";
	let i = 0;
	while (i < src.length) {
		const ch = src[i] as string;
		if (ch === "'") {
			const end = src.indexOf("'", i + 1);
			out += " ";
			i = end === -1 ? src.length : end + 1;
			continue;
		}
		if (ch === '"') {
			out += " ";
			i += 1;
			while (i < src.length) {
				const c = src[i];
				if (c === "\\") {
					i += 2;
					continue;
				}
				i += 1;
				if (c === '"') break;
			}
			continue;
		}
		if (ch === "<" && src[i + 1] === "<") {
			const m = /^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(src.slice(i));
			if (m) {
				const stripTabs = m[1] === "-";
				const delim = m[3] as string;
				out += " ";
				i += m[0].length;
				// 逐行跳到终止符（`<<-` 允许每行前缀 tab）
				while (i < src.length) {
					const nl = src.indexOf("\n", i);
					const lineEnd = nl === -1 ? src.length : nl;
					const line = src.slice(i, lineEnd);
					i = nl === -1 ? src.length : nl + 1;
					const cmp = stripTabs ? line.replace(/^\t+/, "") : line;
					if (cmp.trimEnd() === delim) break;
				}
				continue;
			}
		}
		out += ch;
		i += 1;
	}
	return out;
}

/**
 * 判定命令是否在「脱离终端的后台」启动进程。
 * @returns 命中说明（人类可读），或 null（合规）。
 */
export function findBackgrounding(command: string): string | null {
	const detach = DETACH_WORDS.exec(command);
	if (detach) return `${detach[1]}（脱离终端的后台写法）`;
	const code = stripQuoted(command);
	// 后台符号 `&`：排除 `&&`、`&>`、`>&2`、`|&`
	if (/(^|[^&>|])&(?![&>])/.test(code)) return "命令里的 `&`（把进程丢到后台）";
	return null;
}

/** 是否属于已放行的写法。 */
export function isAllowed(command: string): boolean {
	if (command.includes(MARKER)) return true;
	if (HAS_TMUX.test(command)) return true;
	if (/\bwait\b/.test(stripQuoted(command))) return true;
	return false;
}

const DENY = (hit: string, toolName: string) =>
	`[bg-tmux-guard] 拦截：检测到 ${hit}——后台进程必须跑在 tmux 里（2026-11-16 用户立规：` +
	`「不论是本机还是 macmini，后台进程都要在 tmux 里面运行」，否则当前窗口 / 终端 / SSH 一挂，任务就跟着没，工作白做）。\n` +
	`合规写法（任选其一）：\n` +
	`  1. 用 \`background_run\` 工具（本机；它内部已用 \`tmux new-session -d\` 启动，还会在完成时通知你）；\n` +
	`  2. 在 macmini 上跑长任务用 \`macmini_run\` 的 \`background:true\`（远端同样走 tmux 会话）；\n` +
	`  3. 自己包一层 tmux：\`tmux new-session -d -s pi-<名字> -c <目录> '<命令> > <日志> 2>&1'\`（会话名必须 pi- 前缀）；\n` +
	`  4. 确实是「后台起、返回前等它」的同步用法：命令里带上 \`wait\`。\n` +
	`确需 ${toolName} 里起不受 tmux 管理的后台进程时，命令末尾加标记 \`${MARKER}\`（仅限用户当次授权）。`;

export default function bgTmuxGuard(pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		try {
			const toolName = (event as { toolName?: string }).toolName;
			if (toolName !== "bash" && toolName !== "macmini_run") return;
			const command = String((event as { input?: { command?: unknown } }).input?.command ?? "");
			if (!command.trim()) return;
			const hit = findBackgrounding(command);
			if (!hit) return;
			if (isAllowed(command)) return;
			return { block: true, reason: DENY(hit, toolName) };
		} catch {
			// 判定异常时不阻塞会话（与其它守卫一致）
		}
	});

	// 每轮注入一行提示：规划「放后台跑」时第一时间想到 tmux（预防 > 拦截）。
	// 写法跟 macmini-use 一致：只往 systemPrompt 追加一段带哨兵的短文（已存在就不重复加），
	// 其它内容原样不动——避免覆盖掉别的扩展的提示链。
	const BRIEF = [
		"【后台进程一律 tmux（2026-11-16 用户立规）】",
		"所有后台进程都必须跑在 tmux 里（本机与 macmini 同此）——否则当前窗口 / 终端 / SSH 一挂，任务就跟着没，工作白做。",
		"合规做法：① 本机用 `background_run`（内部已 `tmux new-session -d`）；",
		"② macmini 长任务用 `macmini_run` 的 `background:true`（远端也是 tmux 会话）；",
		"③ 自己包 `tmux new-session -d -s pi-<名字> …`（会话名必须 pi- 前缀）；",
		"④ 「后台起、返回前等它」同步用法可带 `wait`。",
		"禁止 `nohup` / `setsid` / `disown` / 裸 `cmd &` 这类脱离终端的写法；确需如此时命令末尾加 `" + MARKER + "`（仅限用户当次授权）。",
	].join("\n");

	pi.on("before_agent_start", async (event) => {
		try {
			const systemPrompt = String((event as { systemPrompt?: string }).systemPrompt ?? "");
			if (systemPrompt.includes("【后台进程一律 tmux")) return undefined;
			return { systemPrompt: `${systemPrompt}\n\n${BRIEF}` };
		} catch {
			// 注入失败不影响会话
		}
	});
}
