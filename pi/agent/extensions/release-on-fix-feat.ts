/**
 * 有 fix / feat 前缀的 main 提交 → 强制自动发版（pi 端，`agent_settled` 巡检 + 定向指令注入）。
 *
 * 2026-11-25 用户立规：「有 fix 就要发版啊！为什么还问？把有 fix/feat 前缀的 main 内容变更
 * 用工具强制自动走发版流程，不要询问用户」。起因：cmux 的标题栏图标修复（PR #149）合并后，
 * AI 按 2026-10-13 的「只有核心功能 fix / feat 才发版」口径判成「UI 细节、非核心」，于是
 * 停下来问「要不要发 r32」——用户要的是**不判语义、只看前缀**：main 上自最新发布 tag 以来
 * 只要有 `fix:` / `feat:` / `fix(...):` / `feat(...)!:` 形态的提交，就必须直接走
 * /bump → /add → /commit → /release，不再询问。纯文档 / chore 类提交仍然不发版。
 *
 * 为什么靠工具而不是只写规则：这是「该不该发版」的判断，写成文字规则时 AI 每轮都要自己
 * 重新判一次语义（「核心功能」这种模糊词一判就偏）；写成前缀扫描后，判据是确定性的，
 * 由本扩展把结论直接推给会话。
 *
 * 检查范围（与 main-wip-guard 同口径，避免每个会话都去扫全团队）：
 *   cwd 仓库 + 本会话经 `git -C` 触及的仓库 + 本会话建过 worktree 的主仓库。
 *
 * 每个仓库要全部满足才提醒：
 *   ① 有 `VERSION` 文件（发版体系以它为准）；② `origin` 指向 github.com；
 *   ③ 有 `v*` tag 可作基线；④ 自最新 tag 至 main（或更新的 origin/main）之间
 *      匹配到带 fix / feat 前缀的提交；⑤ 工作区干净（脏改动交给 main-wip-guard 先搬运）；
 *   ⑥ 当前 HEAD 还没有被打 tag（避免同一条内容重复发版）；⑦ add / commit 模式没被关成 manual。
 *
 * 去重：`state/release-nudge.json` 按仓库记「基线 tag|Head SHA」签名，同一对不重复催；
 * 用户发新消息时清空内存记忆（下次收尾可再催）。
 *
 * 装到用户机器那一步（替换 /Applications 里的 app 等）仍按项目硬约束要用户单独点头——
 * 本扩展只负责「发版流程必须自动跑、不许问」。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOME = homedir();
const STATE_FILE = join(HOME, ".pi", "agent", "state", "release-nudge.json");
const ADD_STATE = join(HOME, ".pi", "agent", "state", "add-mode.json");
const COMMIT_STATE = join(HOME, ".pi", "agent", "state", "commit-mode.json");
const LOG_FILE = join(HOME, ".pi", "agent", "state", "release-nudge.log");

/** 判据：conventional commit 的 fix / feat 前缀（含可选 scope 与 `!` 破坏性标记）。 */
const FIX_FEAT_RE = /^(fix|feat)(\(([^)]*)\))?!?:/i;

/**
 * 只改测试 / 流水线 / 文档的 scope 不算产品改动（2026-11-17 用户实测口径：
 * `fix(tests)` / `fix(ci)` 改的东西用户在 app 里一个字都看不到，为它发一版纯属浪费），
 * 不发版。其余 scope（含无 scope）一律算「有 fix / feat」→ 发版。
 */
const NON_PRODUCT_SCOPES = new Set(["ci", "test", "tests", "docs", "chore"]);

function isProductFixFeat(subject: string): boolean {
	const matched = subject.match(FIX_FEAT_RE);
	if (!matched) return false;
	const scope = (matched[3] ?? "").trim().toLowerCase();
	return !NON_PRODUCT_SCOPES.has(scope);
}

function dbg(line: string): void {
	if (process.env.PI_RELEASE_NUDGE_DEBUG !== "1") return;
	try {
		writeFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, { flag: "a" });
	} catch {
		// 记日志失败不影响判定
	}
}

function git(dir: string, args: string[]): { ok: boolean; out: string } {
	try {
		const out = execFileSync("git", ["-C", dir, ...args], {
			encoding: "utf-8",
			timeout: 8000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return { ok: true, out: out.trim() };
	} catch {
		return { ok: false, out: "" };
	}
}

function normalize(raw: string): string {
	let p = raw.trim();
	if (p === "~") p = HOME;
	else if (p.startsWith("~/")) p = join(HOME, p.slice(2));
	const abs = resolve(p);
	return abs.replace(/\/+$/, "") || "/";
}

/** `state/*.json` 里登记为 manual 的目录清单。 */
function manualEntries(file: string): string[] {
	try {
		const raw = JSON.parse(readFileSync(file, "utf-8")) as { manual?: unknown };
		if (!Array.isArray(raw.manual)) return [];
		return raw.manual.filter((p): p is string => typeof p === "string").map(normalize);
	} catch {
		return [];
	}
}

function pausedByMode(root: string): boolean {
	const entryOf = (list: string[]) =>
		list.some((entry) => root === entry || root.startsWith(`${entry}/`));
	return entryOf(manualEntries(ADD_STATE)) || entryOf(manualEntries(COMMIT_STATE));
}

function readNudged(): Record<string, string> {
	try {
		const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as unknown;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return raw as Record<string, string>;
	} catch {
		return {};
	}
}

function writeNudged(state: Record<string, string>): void {
	try {
		writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
	} catch {
		// 状态写不进去最多重复催一次，不阻塞会话
	}
}

/** 本会话建过 worktree 的主仓库（读 worktree 所有权记录，与 settle-repo-check 同源）。 */
function sessionRepoRoots(sessionId: string): string[] {
	const roots = new Set<string>();
	const file = join(HOME, ".pi", "agent", "state", "worktrees.jsonl");
	if (!existsSync(file)) return [];
	try {
		for (const line of readFileSync(file, "utf-8").split("\n")) {
			if (!line.trim()) continue;
			const entry = JSON.parse(line) as { sessionId?: string; path?: string; cwd?: string };
			if (entry.sessionId !== sessionId) continue;
			for (const dir of [entry.path, entry.cwd]) {
				if (!dir) continue;
				const common = git(dir, ["rev-parse", "--git-common-dir"]).out;
				if (!common) continue;
				roots.add(resolve(common.startsWith("/") ? common : resolve(dir, common)));
			}
		}
	} catch {
		// 记录损坏时不扩大范围
	}
	return [...roots];
}

type ReleaseSignal = { root: string; tag: string; head: string; subjects: string[] };

/** 判定一个仓库是否需要发版；不需要返回 null。 */
function inspect(root: string): ReleaseSignal | null {
	if (!existsSync(join(root, "VERSION"))) return null;

	const originURL = git(root, ["remote", "get-url", "origin"]).out;
	if (!/github\.com/.test(originURL)) return null;

	// 工作区干净才提醒：脏改动由 main-wip-guard 先搬进 worktree，两条指令不能同时压给会话
	if (git(root, ["status", "--porcelain"]).out) return null;

	if (!git(root, ["rev-parse", "--verify", "-q", "main"]).ok) return null;

	// 基线 tag：main 上可达的最新 v* tag
	const tag = git(root, ["describe", "--tags", "--abbrev=0", "--match", "v*", "main"]).out;
	if (!tag) return null;

	// main 可能落后 origin/main（PR 刚合并、还没快进时以远端为准）
	let head = git(root, ["rev-parse", "main"]).out;
	const originMain = git(root, ["rev-parse", "--verify", "-q", "origin/main"]);
	if (originMain.ok && originMain.out) {
		const mainContainsOrigin = git(root, ["merge-base", "--is-ancestor", "origin/main", "main"]).ok;
		if (!mainContainsOrigin) head = originMain.out;
	}
	if (!head) return null;

	// 当前 HEAD 已经打过 tag → 这条内容已发过版
	if (git(root, ["tag", "--points-at", head]).out) return null;

	const subjects = git(root, ["log", `${tag}..${head}`, "--format=%s"]).out
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (!subjects.some((subject) => isProductFixFeat(subject))) return null;

	if (pausedByMode(root)) return null;

	return { root, tag, head, subjects };
}

/** 怎么发版：把发版链写清楚，避免会话自己发明步骤。 */
function directive(signal: ReleaseSignal, fixFeatSubjects: string[]): string {
	const listed = fixFeatSubjects.slice(0, 6).map((s) => `  - ${s}`).join("\n");
	const more = fixFeatSubjects.length > 6 ? `\n  …（共 ${fixFeatSubjects.length} 条）` : "";
	return (
		`【release-nudge】仓库 \`${signal.root}\` 的 main 自最新发布 tag \`${signal.tag}\` 以来有 ${fixFeatSubjects.length} 条带 fix / feat 前缀的提交：\n${listed}${more}\n\n` +
		`按 2026-11-25 用户立规：**main 上只要（自最新 tag 以来）有 fix / feat 前缀的提交就必须发版，不要判「是不是核心功能」、也不要问用户**（立规原话：「有 fix 就要发版啊！为什么还问？把有 fix/feat 前缀的 main 内容变更用工具强制自动走发版流程，不要询问用户」；只改测试或流水线的 scope（\`fix(ci)\` / \`fix(test)\` 这类）不算）。\n` +
		`现在直接按发版链走完，全程不询问：\n` +
		`1. 在主工作区对齐 main：\`git -C ${signal.root} fetch origin\` + \`git -C ${signal.root} merge --ff-only origin/main\`。\n` +
		`2. \`/bump\`：修订号 +1（或按 CHANGELOG 已定稿的版本号），走 bump 分支 → PR → CI 合并。\n` +
		`3. \`/release\`：在最新 main 上打 tag + 建 Release（产物按项目声明；cmux 由 CI 自动挂资产）。\n` +
		`4. 装到用户机器（替换 /Applications 里的 app 之类）按项目硬约束仍要用户单独点头，**只有这一步可以问**；发版流程本身一律不问。\n` +
		`被 add-mode / commit-mode 暂停、或工作区有改动没搬走时，先按对应规则处理，不要绕过。`
	);
}

export default function (pi: ExtensionAPI) {
	// 本会话经 `git -C` 触及过的仓库根
	const touchedRoots = new Set<string>();
	// 同一 (基线 tag, Head SHA) 不重复催
	const nudgedThisTurn = new Map<string, string>();

	pi.on("input", async (event) => {
		if ((event as { source?: string })?.source === "interactive") nudgedThisTurn.clear();
	});

	pi.on("tool_call", async (event, ctx) => {
		try {
			if (event.toolName !== "bash") return;
			const command = (event.input as { command?: string })?.command ?? "";
			if (!command.includes("git")) return;
			const cwd = (ctx as { cwd?: string })?.cwd ?? process.cwd();
			for (const raw of command.split(/&&|\|\||;|\n/)) {
				const segment = raw.trim();
				if (!/^(-\S+\s+)*git(?=\s|$)/.test(segment)) continue;
				const dirMatch = segment.match(/git\s+-C\s+("[^"]+"|'[^']+'|[^\s]+)/);
				let dir = cwd;
				if (dirMatch) {
					const rawDir = dirMatch[1].replace(/^["']|["']$/g, "");
					dir = normalize(rawDir);
				}
				if (!existsSync(dir)) continue;
				const root = git(dir, ["rev-parse", "--show-toplevel"]).out;
				if (root) touchedRoots.add(root);
			}
		} catch {
			// 判定异常不阻塞会话
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		try {
			const sessionCtx = ctx as { cwd?: string; sessionManager?: { getSessionId?: () => string } };
			const cwd = sessionCtx?.cwd ?? process.cwd();
			const sessionId = String(sessionCtx?.sessionManager?.getSessionId?.() ?? "");

			const candidates = new Set<string>([cwd, ...touchedRoots]);
			if (sessionId) for (const root of sessionRepoRoots(sessionId)) candidates.add(root);

			const persisted = readNudged();
			const toNotify: ReleaseSignal[] = [];

			for (const dir of candidates) {
				if (!existsSync(dir)) continue;
				const signal = inspect(dir);
				dbg(`agent_settled dir=${dir} signal=${signal ? `${signal.tag}..${signal.head.slice(0, 8)}` : "none"}`);
				if (!signal) continue;

				const signature = `${signal.tag}|${signal.head}`;
				if (nudgedThisTurn.get(signal.root) === signature) continue;
				if (persisted[signal.root] === signature) {
					dbg(`already nudged ${signal.root} ${signature}`);
					continue;
				}

				nudgedThisTurn.set(signal.root, signature);
				persisted[signal.root] = signature;
				toNotify.push(signal);
			}

			if (toNotify.length > 0) writeNudged(persisted);

			for (const signal of toNotify) {
				const fixFeat = signal.subjects.filter((subject) => isProductFixFeat(subject));
				dbg(`NUDGE root=${signal.root} tag=${signal.tag} fixFeat=${fixFeat.length}`);
				pi.sendMessage(
					{
						customType: "release-nudge",
						display: false,
						content: directive(signal, fixFeat),
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			}
		} catch {
			// 判定异常不阻塞会话
		}
	});
}

