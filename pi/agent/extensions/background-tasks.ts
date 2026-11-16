/**
 * pi 宿主后台任务工具（全局通用能力，2026-10-11 自 trading-agent 项目级扩展上移）。
 *
 * 为什么需要它：pi 官方设计「不内建后台 bash」（README 明说 use tmux），而
 * 「长任务放后台跑 → 完成时通知唤醒 AI → 继续下一步」是很多工作流的刚需
 * （长构建、批量任务、采样循环等）——没有后台任务能力，这类循环根本转不起来。
 * 本扩展用 **tmux 会话** + 完成时 `pi.sendMessage(..., { triggerTurn: true })` 补上这一能力：
 *
 *   - `background_run`   ≈ CC 的 `Bash(run_in_background=true)`：非阻塞启动、输出落文件，
 *                          进程结束时以通知消息唤醒 AI（消息里带输出尾部 + 完整日志路径）。
 *   - `background_stop`  ≈ CC 的 `TaskStop`：杀掉对应的 tmux 会话（含整棵进程树）。
 *   - `background_list`  ≈ 查看后台任务清单、tmux 会话名与日志路径。
 *
 * **2026-11-16 用户立规：后台进程一律在 tmux 里跑（本机与 macmini 同此）。**
 * 理由：前台窗口 / pi 会话挂掉时，普通子进程会一起没（工作白做）；tmux 会话独立于
 * 终端存活，窗口挂了任务照跑、日志照写，重新 attach 就能看。
 * 实现方式（本文件）：命令经一个由本扩展生成的 wrapper 脚本交给 `tmux new-session -d`
 * 启动，脚本自己把输出重定向进日志、结束时把退出码写进 `.rc` 文件；本扩展每 2 秒
 * `tmux has-session` 探测一次，会话消失即视为结束（读 `.rc` 拿到退出码）。
 *
 * 与「杀掉工作丢」相反的两条配套决定：
 *   ① `session_shutdown` **不再杀任务**——会话结束（含 Ctrl+C、窗口关闭、/new）时任务
 *      继续在 tmux 里跑，这正是本规则的意义；再进来用 `tmux attach -t <会话名>` 看。
 *   ② `session_start` 会**收养**本会话 id 遗留下来的 tmux 后台任务（读 meta JSON 恢复
 *      命令 / 日志 / 起始时间），继续探测与通知——窗口重开也不丢工作。
 *
 * 通知策略（2026-10-14 用户立：通知的显示与消费不需要用户感知）：
 *   ① 通知消息 `display: false`——不渲染到会话窗口（仍进 AI 上下文、仍触发唤醒）；
 *   ② 忙时聚合——AI 正在干活（agent_start..agent_settled）期间完成的任务不逐条投递，
 *      静默积攒，AI 空闲后合并为一条摘要发出（单条照旧附输出尾部；合并批次只列
 *      id / 状态 / 日志路径、不带尾部——AI 按需读日志，避免上下文被过期尾部灌满）。
 *
 * 与全局 agent-wait-banner 扩展联动：后台任务运行期间通过 pi.events 发
 * `agent-wait-banner:activity`（`{ source: "background-tasks", active }`），
 * 会话界面显示「🟥🟥🟥 还有后台进程在运行中，请稍等 🟥🟥🟥」；全部任务结束即撤。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface BgTask {
	id: string;
	command: string;
	label: string;
	/** 会话工作目录（启动命令与日志目录的基准）。 */
	cwd: string;
	/** 承载任务的 tmux 会话名（`pi-bg-<会话尾号>-<id>`；用户可 attach 进去看实时输出）。 */
	session: string;
	/** tmux 里跑的 wrapper 脚本（本扩展生成，位于 tmp/pi-bg/）。 */
	scriptPath: string;
	/** wrapper 退出时把退出码写到这里。 */
	rcPath: string;
	/** 恢复用的元数据（重启后收养任务时读它）。 */
	metaPath: string;
	logPath: string;
	/** 日志相对会话工作目录的路径（展示用，如 tmp/pi-bg/<stag>-bg-1.log）。 */
	logRel: string;
	/** tmux pane 的主进程 pid（进程组组长；停任务时兜底整组杀）。 */
	panePid: number;
	startedAt: number;
	endedAt?: number;
	status: "running" | "exited" | "killed" | "failed";
	exitCode: number | null;
	/** 结束时拿不到退出码的原因（如被 tmux kill-session 杀掉、机器重启）。 */
	note?: string;
	/** 是否已计入「运行中」联动计数（防重复扣减）。 */
	counted?: boolean;
}

/** 待投递的通知（AI 忙时积压，空闲后单条 / 合并发出，见文件头「通知策略」）。 */
interface PendingNote {
	/** 合并列表里的一行（短）。 */
	entryLine: string;
	/** 单条投递时的完整文本（带输出尾部）。 */
	fullText?: string;
}

/** 探测间隔：tmux 会话是否还在（秒级足够，开销可忽略）。 */
const POLL_MS = 2000;

/**
 * wrapper 里保留的环境变量（白名单）。
 *
 * 为什么要显式导出：tmux 新会话继承的是 **tmux server 启动时**的环境，不是当前 pi
 * 进程的——server 若是很久以前在别的终端里起的，PATH / 代理设置都会是旧的，
 * 后台任务就会用错工具链、或连不上网。这里把关键变量快照进 wrapper，保证后台任务
 * 看到的 PATH / 代理与发起它的 pi 会话一致。
 */
const ENV_KEEP =
	/^(PATH|HOME|SHELL|TERM|USER|LOGNAME|LANG|LC_[A-Z]+|TMPDIR|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|https?_proxy|all_proxy|no_proxy|GOPATH|GOROOT|JAVA_HOME|PYENV_ROOT|NVM_DIR|RUSTUP_HOME|CARGO_HOME)$/;

/** 单引号安全引用。 */
function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 输出尾部（通知里只带尾部，完整输出在日志文件）。 */
function tailOf(logPath: string, maxLines = 60, maxChars = 6000): string {
	try {
		const text = fs.readFileSync(logPath, "utf8");
		let lines = text.split("\n");
		if (lines.length > maxLines) lines = lines.slice(-maxLines);
		let out = lines.join("\n").trimEnd();
		if (out.length > maxChars) out = out.slice(-maxChars);
		return out;
	} catch {
		return "";
	}
}

function fmtDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s} 秒`;
	const m = Math.floor(s / 60);
	return `${m} 分 ${s % 60} 秒`;
}

/**
 * 生成 tmux 里跑的 wrapper 脚本。
 *
 * 结构（顺序有意义）：
 *   1. 导出环境白名单 → 2. 重定向 stdin/stdout/stderr 到日志 → 3. 装 EXIT trap 写退出码
 *   → 4. cd 到会话工作目录 → 5. 用户命令放进子 shell 跑（用户自己的 `exit` 只结束子 shell，
 *   不会让退出码丢失）。
 */
function buildWrapper(opts: {
	id: string;
	sid: string;
	session: string;
	logPath: string;
	rcPath: string;
	cwd: string;
	command: string;
}): string {
	const envLines = Object.entries(process.env)
		.filter(([k, v]) => v !== undefined && ENV_KEEP.test(k))
		.map(([k, v]) => `export ${k}=${shq(String(v).replace(/[\r\n]+/g, " "))}`);
	return (
		[
			"#!/bin/bash",
			`# 由 pi 的 background_run 生成（任务 ${opts.id}，来源会话 ${opts.sid}）。`,
			`# 本脚本在独立 tmux 会话 ${opts.session} 里执行：pi 窗口 / 终端挂掉不影响它继续跑。`,
			...envLines,
			"exec </dev/null",
			`exec > ${shq(opts.logPath)} 2>&1`,
			"__pi_bg_finish() {",
			"  __pi_bg_rc=$?",
			"  exec >/dev/null 2>&1",
			`  printf '%s\\n' "$__pi_bg_rc" > ${shq(opts.rcPath)}`,
			'  exit "$__pi_bg_rc"',
			"}",
			"trap __pi_bg_finish EXIT",
			`cd ${shq(opts.cwd)} || exit 97`,
			"(",
			opts.command,
			")",
			"",
		].join("\n")
	);
}

/** tmux 会话是否还在（`=名字` 表示精确匹配，避免前缀误命中）。 */
function tmuxAlive(session: string): boolean {
	try {
		execFileSync("tmux", ["has-session", "-t", `=${session}`], { stdio: "ignore", timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

/** 取 pane 主进程 pid（拿不到返回 0）。 */
function panePidOf(session: string): number {
	try {
		const out = execFileSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_pid}"], {
			encoding: "utf8",
			timeout: 5000,
		}).trim();
		const pid = Number.parseInt(out.split("\n")[0] ?? "", 10);
		return Number.isFinite(pid) ? pid : 0;
	} catch {
		return 0;
	}
}

/** tmux 会话清单（tmux 没跑 / 出错时返回空数组）。 */
function listSessions(): string[] {
	try {
		const out = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
			encoding: "utf8",
			timeout: 5000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.split("\n").map((s) => s.trim()).filter(Boolean);
	} catch {
		return [];
	}
}

export default function backgroundTasks(pi: ExtensionAPI) {
	const tasks = new Map<string, BgTask>();
	let counter = 0;
	let shuttingDown = false;
	let pollTimer: NodeJS.Timeout | undefined;
	// 通知聚合状态（2026-10-14，见文件头「通知策略」）：
	let agentBusy = false; // AI 是否正在干活（agent_start..agent_settled）
	let flushTimer: NodeJS.Timeout | undefined; // 聚合窗口定时器（收拢瞬时完成的多任务）
	const pending: PendingNote[] = []; // 待投递通知（忙时积压）

	// ---- 与全局 agent-wait-banner 扩展联动 ----
	// 后台任务运行期间，会话界面（footer 状态行）显示
	// 「🟥🟥🟥 还有后台进程在运行中，请稍等 🟥🟥🟥」，避免用户误以为会话已空闲而关掉窗口。
	// 协议：pi.events 事件 `agent-wait-banner:activity`，载荷 { source, active }。
	const ACTIVITY_EVENT = "agent-wait-banner:activity";
	const ACTIVITY_SOURCE = "background-tasks";
	let runningCount = 0;
	const publishActivity = (active: boolean): void => {
		try {
			pi.events.emit(ACTIVITY_EVENT, { source: ACTIVITY_SOURCE, active });
		} catch {
			// 事件总线不可用时忽略（提醒是增强项，不影响任务本身）
		}
	};
	const releaseCount = (task: BgTask): void => {
		if (!task.counted) return;
		task.counted = false;
		runningCount = Math.max(0, runningCount - 1);
		if (runningCount === 0) publishActivity(false);
	};

	/** 会话工作目录（日志与命令都以它为基准；取不到时退到进程 cwd）。 */
	function sessionCwd(ctx?: ExtensionContext): string {
		try {
			const cwd = ctx?.sessionManager?.getCwd?.();
			if (typeof cwd === "string" && cwd) return cwd;
		} catch {
			// 忽略，退到 process.cwd()
		}
		return process.cwd();
	}

	/** 完整会话标识（去非字母数字）：日志命名与 tmux 会话名都用它做隔离。 */
	function sessionSlug(ctx?: ExtensionContext): string {
		const sid = String(ctx?.sessionManager?.getSessionId?.() ?? "");
		const safe = sid.replace(/[^A-Za-z0-9]/g, "");
		return safe || `p${process.pid}${Date.now().toString(36)}`;
	}

	/**
	 * tmux 会话名里的短尾号。
	 * 用会话 id 的**后 8 位**（UUID 的随机段）而不是前 8 位：前 8 位是时间戳高位，
	 * 相近时间启动的两个会话会撞（2026-11-11 修过日志串号的同类问题）。
	 */
	function sessionTail(slug: string): string {
		return slug.length <= 8 ? slug : slug.slice(-8);
	}

	function killGroup(pid: number, signal: NodeJS.Signals): void {
		try {
			process.kill(-pid, signal); // 负号 = 杀整个进程组（含子进程）
		} catch {
			try {
				process.kill(pid, signal);
			} catch {
				// 进程已退出
			}
		}
	}

	function notifyCompletion(task: BgTask): void {
		const duration = fmtDuration((task.endedAt ?? Date.now()) - task.startedAt);
		const outcome =
			task.status === "exited"
				? `退出码 ${task.exitCode}`
				: task.status === "killed"
					? "已停止"
					: task.status === "failed"
						? `异常结束${task.note ? `（${task.note}）` : ""}`
						: "已结束";
		const tail = tailOf(task.logPath);
		const body = tail ? `\n──── 输出尾部 ────\n${tail}` : "\n（无输出）";
		const head =
			`[后台任务完成] ${task.id}${task.label ? `「${task.label}」` : ""} ${outcome}（运行 ${duration}）\n` +
			`命令：${task.command}\n` +
			`完整日志：${task.logRel}\n` +
			`请读取日志 / 输出完成分析，并按本会话的工作流程执行后续步骤。`;
		queueNote({
			entryLine: `- ${task.id}${task.label ? `「${task.label}」` : ""} ${outcome}（运行 ${duration}）| 日志 ${task.logRel}`,
			fullText: head + body,
		});
	}

	/** 通知入队：AI 空闲 → 短窗口后发出（收拢瞬时完成的多任务）；忙碌 → 静默积攒、等空闲再发。 */
	function queueNote(note: PendingNote): void {
		if (shuttingDown) return;
		pending.push(note);
		if (!agentBusy) scheduleFlush();
	}

	/** 调度 flush（1.2 秒聚合窗口；已有窗口在跑则不重复调度）。 */
	function scheduleFlush(): void {
		if (flushTimer || shuttingDown) return;
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			flushPending();
		}, 1200);
	}

	/** 发出积压通知：单条 → 完整文本（附输出尾部）；多条 → 合并摘要（不带尾部）。 */
	function flushPending(): void {
		if (pending.length === 0) return;
		const batch = pending.splice(0);
		const single = batch.length === 1 ? batch[0] : undefined;
		const text = single?.fullText
			? single.fullText
			: `[后台任务通知] ${batch.length} 个任务已结束：\n` + batch.map((n) => n.entryLine).join("\n") + `\n需要时读取对应日志分析。`;
		try {
			pi.sendMessage(
				{ customType: "bg-task", content: text, display: false },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			// pi 正在退出等场景：忽略
		}
	}

	/** 同步小睡（读退出码时的重试间隔用；不启子进程）。 */
	function sleepSync(ms: number): void {
		try {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
		} catch {
			// 极端环境不支持时直接跳过等待
		}
	}

	/** 读退出码文件（会话刚消失时文件可能还在写，给几次重试）。 */
	function readRc(rcPath: string): number | null {
		for (let i = 0; i < 5; i += 1) {
			try {
				const text = fs.readFileSync(rcPath, "utf8").trim();
				const code = Number.parseInt(text, 10);
				if (Number.isFinite(code)) return code;
			} catch {
				// 还没写出来，稍等再试
			}
			sleepSync(150);
		}
		return null;
	}

	/** 结账：把任务标成结束、扣计数、发通知。 */
	function finalize(task: BgTask, status: BgTask["status"], note?: string): void {
		if (task.status !== "running") return;
		task.status = status;
		task.endedAt = Date.now();
		task.note = note;
		releaseCount(task);
		if (!shuttingDown) notifyCompletion(task);
	}

	/** 轮询：tmux 会话消失 → 收尾。 */
	function pollOnce(): void {
		for (const task of tasks.values()) {
			if (task.status !== "running") continue;
			if (tmuxAlive(task.session)) continue;
			const code = readRc(task.rcPath);
			if (code === null) {
				finalize(task, "failed", "tmux 会话已消失但没拿到退出码（可能被 kill-session、或机器重启）");
			} else {
				task.exitCode = code;
				finalize(task, "exited", code === 0 ? undefined : `退出码 ${code}`);
			}
		}
		const stillRunning = [...tasks.values()].some((t) => t.status === "running");
		if (!stillRunning) stopPoll();
	}

	function stopPoll(): void {
		if (!pollTimer) return;
		clearInterval(pollTimer);
		pollTimer = undefined;
	}

	function ensurePoll(): void {
		if (pollTimer || shuttingDown) return;
		pollTimer = setInterval(pollOnce, POLL_MS);
	}

	/**
	 * 收养本会话遗留的后台任务（2026-11-16）。
	 * 场景：pi 窗口被关掉 / 崩了之后重开（或 /resume），任务还在 tmux 里跑——
	 * 读回 meta JSON 恢复登记，继续探测与通知，工作不丢。
	 */
	function adoptOrphans(ctx?: ExtensionContext): void {
		const slug = sessionSlug(ctx);
		const prefix = `pi-bg-${sessionTail(slug)}-`;
		const cwd = sessionCwd(ctx);
		const logDir = path.join(cwd, "tmp", "pi-bg");
		for (const name of listSessions()) {
			if (!name.startsWith(prefix)) continue;
			const id = name.slice(prefix.length);
			if (!id || tasks.has(id)) continue;
			const base = path.join(logDir, `${slug}-${id}`);
			let meta: Partial<BgTask> = {};
			try {
				meta = JSON.parse(fs.readFileSync(`${base}.json`, "utf8")) as Partial<BgTask>;
			} catch {
				// 元数据丢了也照样收养：至少还能探测、还能通知「结束了」
			}
			const task: BgTask = {
				id,
				command: String(meta.command ?? "(未知，元数据缺失)"),
				label: String(meta.label ?? ""),
				cwd: String(meta.cwd ?? cwd),
				session: name,
				scriptPath: `${base}.sh`,
				rcPath: `${base}.rc`,
				metaPath: `${base}.json`,
				logPath: `${base}.log`,
				logRel: String(meta.logRel ?? `tmp/pi-bg/${slug}-${id}.log`),
				panePid: panePidOf(name),
				startedAt: Number(meta.startedAt) || Date.now(),
				status: "running",
				exitCode: null,
				counted: true,
			};
			tasks.set(id, task);
			runningCount += 1;
			const n = Number.parseInt(id.replace(/^bg-/, ""), 10);
			if (Number.isFinite(n) && n >= counter) counter = n;
		}
		if (tasks.size > 0) {
			publishActivity(true);
			ensurePoll();
		}
	}

	pi.registerTool({
		name: "background_run",
		label: "后台运行（tmux）",
		description:
			"在后台运行一条 bash 命令（立即返回、不阻塞对话）；命令在**独立 tmux 会话**里执行——当前 pi 窗口 / 终端挂掉也不会中断，工作不会丢。" +
			"命令结束时 pi 会以通知消息唤醒你并附上输出尾部（若你正忙于其它工具调用，多个任务的完成通知会合并为一条摘要，届时按需读取日志）。" +
			"完整输出落在会话工作目录的 tmp/pi-bg/ 下（通知里给出具体路径）。" +
			"长任务（构建 / 批量处理 / 采样等）用它；项目若有自己的后台跑法规定，按其规定使用。",
		parameters: Type.Object({
			command: Type.String({
				description: "要后台运行的 bash 命令（不要自己加 nohup / 行尾 & / sleep 轮询，直接写原命令即可；tmux 由本工具负责）",
			}),
			label: Type.Optional(Type.String({ description: "任务标签，便于识别（如「全库构建」）" })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = sessionCwd(ctx);
			const logDir = path.join(cwd, "tmp", "pi-bg");
			try {
				fs.mkdirSync(logDir, { recursive: true });
			} catch (e) {
				return {
					content: [{ type: "text", text: `❌ 后台任务启动失败：无法创建日志目录 ${logDir}（${String(e)}）` }],
					isError: true,
					details: {},
				};
			}
			counter += 1;
			const id = `bg-${counter}`;
			// 日志 / 脚本 / 元数据按会话分名（<slug>-<id>）：任务编号是进程内计数、多会话
			// 并行时会重复（都从 bg-1 起），不加会话前缀会互相覆盖 / 混入别的会话的输出。
			const slug = sessionSlug(ctx);
			const session = `pi-bg-${sessionTail(slug)}-${id}`;
			const base = path.join(logDir, `${slug}-${id}`);
			const logPath = `${base}.log`;
			const rcPath = `${base}.rc`;
			const scriptPath = `${base}.sh`;
			const metaPath = `${base}.json`;
			const logRel = `tmp/pi-bg/${slug}-${id}.log`;
			const command = String(params.command ?? "");
			try {
				const wrapper = buildWrapper({ id, sid: slug, session, logPath, rcPath, cwd, command });
				fs.writeFileSync(scriptPath, wrapper, { mode: 0o755 });
				// 同一会话里若真有同名残留（极端情况），先清掉，避免 new-session 报错。
				if (tmuxAlive(session)) {
					try {
						execFileSync("tmux", ["kill-session", "-t", `=${session}`], { stdio: "ignore", timeout: 5000 });
					} catch {
						// 忽略
					}
				}
				execFileSync("tmux", ["new-session", "-d", "-s", session, "-c", cwd, "/bin/bash", scriptPath], {
					stdio: "pipe",
					timeout: 15000,
				});
				const panePid = panePidOf(session);
				const startedAt = Date.now();
				const task: BgTask = {
					id,
					command,
					label: params.label ?? "",
					cwd,
					session,
					scriptPath,
					rcPath,
					metaPath,
					logPath,
					logRel,
					panePid,
					startedAt,
					status: "running",
					exitCode: null,
					counted: true,
				};
				tasks.set(id, task);
				runningCount += 1;
				publishActivity(true);
				ensurePoll();
				try {
					fs.writeFileSync(
						metaPath,
						JSON.stringify(
							{ id, command, label: task.label, cwd, session, startedAt, logRel, sid: slug },
							null,
							2,
						),
					);
				} catch {
					// 元数据写不了不影响任务本身（只是重启后收养时缺信息）
				}
				return {
					content: [
						{
							type: "text",
							text:
								`后台任务已启动：${id}${task.label ? `「${task.label}」` : ""}\n` +
								`tmux 会话：${session}（想实时看输出：tmux attach -t ${session}）\n` +
								`日志：${logRel}\n` +
								`任务结束时你会收到通知（单条附输出尾部；多个任务在你忙碌期完成时会合并为一条摘要）；期间可继续其他工作，不要 sleep 等待。`,
						},
					],
					details: { id, pid: panePid, session, log: logRel },
				};
			} catch (e) {
				return {
					content: [{ type: "text", text: `❌ 后台任务启动失败（tmux）：${String(e)}` }],
					isError: true,
					details: { id, session },
				};
			}
		},
	});

	pi.registerTool({
		name: "background_list",
		label: "后台任务清单",
		description: "列出后台任务（运行中 / 已完成）及其 tmux 会话、日志路径。",
		parameters: Type.Object({}),
		async execute() {
			if (tasks.size === 0) {
				return { content: [{ type: "text", text: "（无后台任务记录）" }], details: {} };
			}
			const lines: string[] = [];
			for (const t of tasks.values()) {
				const state =
					t.status === "running"
						? `运行中（已 ${fmtDuration(Date.now() - t.startedAt)}）`
						: t.status === "killed"
							? "已停止"
							: t.status === "failed"
								? `异常结束${t.note ? `（${t.note}）` : ""}`
								: `已结束（退出码 ${t.exitCode ?? "?"}）`;
				const tail =
					t.status === "running"
						? ` | tmux ${t.session}（tmux attach -t ${t.session}）`
						: "";
				lines.push(`- ${t.id}${t.label ? `「${t.label}」` : ""} [${state}]${tail} ${t.command.slice(0, 100)} | 日志 ${t.logRel}`);
			}
			return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
		},
	});

	pi.registerTool({
		name: "background_stop",
		label: "停止后台任务",
		description: "停止一个后台任务（杀掉它所在的 tmux 会话，含其全部子进程）。",
		parameters: Type.Object({
			id: Type.String({ description: "后台任务 id（如 bg-3；用 background_list 可查）" }),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const task = tasks.get(params.id);
			if (!task) {
				const known = tasks.size ? [...tasks.keys()].join(", ") : "（无）";
				return {
					content: [{ type: "text", text: `❌ 未找到任务 ${params.id}。当前任务：${known}` }],
					isError: true,
					details: {},
				};
			}
			const previous = task.status;
			if (task.status === "running") {
				// 首选：杀掉 tmux 会话（会话里的进程组一起走）；失败再按进程组兜底。
				try {
					execFileSync("tmux", ["kill-session", "-t", `=${task.session}`], { stdio: "ignore", timeout: 5000 });
				} catch {
					if (task.panePid > 0) {
						killGroup(task.panePid, "SIGTERM");
						await new Promise((resolve) => setTimeout(resolve, 800));
						killGroup(task.panePid, "SIGKILL");
					}
				}
				finalize(task, "killed");
			}
			const stateText =
				previous === "running"
					? "运行中"
					: previous === "killed"
						? "已停止"
						: previous === "failed"
							? "异常结束"
							: `已结束（退出码 ${task.exitCode ?? "?"}）`;
			return {
				content: [
					{
						type: "text",
						text: `已停止 ${task.id}${task.label ? `「${task.label}」` : ""}（原状态：${stateText}）。${
							previous === "running" ? `tmux 会话 ${task.session} 已关闭。` : ""
						}`,
					},
				],
				details: { id: task.id, session: task.session },
			};
		},
	});

	// ---- 通知聚合：AI 忙闲感知（2026-10-14）----
	// AI 干活期间（agent_start..agent_settled）完成的任务不逐条投递——静默积攒；
	// settled（AI 不再自动继续）后统一 flush。正常「空闲等待 → 任务完成 → 唤醒」
	// 循环不受影响（完成时 AI 是空闲的 → 单条通知照常发出）。
	pi.on("agent_start", async () => {
		agentBusy = true;
	});
	pi.on("agent_settled", async () => {
		agentBusy = false;
		if (pending.length > 0) scheduleFlush();
	});

	// 会话退出（Ctrl+C / 窗口关闭 / /new / /resume）：**任务继续在 tmux 里跑**。
	// 2026-11-16 用户立规：后台进程必须在 tmux 里跑，「窗口挂了工作不丢」——所以关会话
	// 不再杀任务（杀 = 主动丢工作）。想停请用 background_stop 或 tmux kill-session。
	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		pending.length = 0;
		stopPoll();
		runningCount = 0;
		publishActivity(false);
	});

	// 新会话（含 /new、/resume、/fork 换会话）：重置状态，并收养本会话 id 遗留的
	// tmux 后台任务（窗口重开 / 崩溃后恢复也照样能探测、能通知）。
	pi.on("session_start", async (_event, ctx) => {
		shuttingDown = false;
		agentBusy = false;
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		pending.length = 0;
		tasks.clear();
		counter = 0;
		runningCount = 0;
		publishActivity(false);
		try {
			adoptOrphans(ctx);
		} catch {
			// 收养失败不影响新任务（旧任务仍在 tmux 里跑，可用 tmux ls 看到）
		}
	});
}
