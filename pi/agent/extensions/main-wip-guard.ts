/**
 * 主工作区 main 上的写操作守卫（pi 端：当场拦 + 自动搬运，2026-11-05 立规、2026-11-24 升级）。
 *
 * 规矩：local main 只承担两件事——① 生成 worktree、② 被 origin/main 快进同步；它不承载任何
 * 写操作。`git-main-guard.ts` 拦的是 `git add` / `git commit` / 其它改历史与引用形态，但
 * 「先把文件改脏、再想办法提交」这条路一直没人挡——2026-11-24 实测：会话在别的仓库主工作区
 * 跑 `bash tools/install_hooks.sh`，把 `.githooks/pre-commit` 的权限位改脏约 1 分钟，靠脚本
 * 自己 chmod 644 才恢复。这类改动会让 main 无法快进同步（脏工作区会被 git 拒绝），
 * 且完全绕过「分支 → PR → 门禁」这条唯一通路。
 *
 * 三层动作：
 *
 * 1. **当场拦（tool_call，主力，2026-11-24 加）**：
 *    - `write` / `edit` 工具的目标路径落在「停在 main 的主工作区」里 → 直接 block；
 *    - `bash` 的写动作（重定向 / `sed -i` / `cp` / `mv` / `tee` / `chmod` / `mkdir` / `rm` …）
 *      命中同样的路径 → 直接 block。
 *    只对**带 GitHub remote 的仓库**生效（临时 / 本地实验仓库不受影响），只对**主工作区**生效
 *    （linked worktree 就是干活的地方，一律放行）。
 *
 * 2. **自动搬运（agent_settled，2026-11-05 立，2026-11-24 去掉冷却与次数上限）**：
 *    兜住「工具层没覆盖到的写」（脚本内部写盘、用户手动改、绕过守卫的旁路）。检查范围为
 *    「会话 cwd 仓库 + 本会话经 `git -C` 触及的主仓库 + 本会话建过的 worktree 所属主仓库」，
 *    命中「main + 有改动 + 暂存区空 + add/commit 模式不是 manual」时注入一条 `display: false`
 *    的 followUp 并主动触发新一轮，让 AI 执行 `worktree-adopt.py` → worktree 上 /add → /commit → PR。
 *    保留了「同一处改动（签名不变）不重复提醒」——这不是次数上限，改动一变就会立刻再提醒；
 *    用户一发新消息即清空记忆。
 *
 * 3. **不改主工作区**：搬运脚本默认复制、不清理主工作区（PR 合并后由 `--finalize` 收尾）。
 *
 * 逃生门（仅限用户当轮明确授权，AI 不得自行添加）：
 * - bash：命令末尾 `# AI_AUTHORIZED_MAIN_WIP`；
 * - `write` / `edit`（没有注释位）：`touch ~/.pi/agent/state/main-wip-allow` 开 10 分钟窗口。
 *
 * 已知局限（诚实声明）：
 * - bash 只认显式写动词与重定向，`python` / `node` 脚本内部写盘不在覆盖范围
 *   （硬认会把 `worktree-adopt.py` 这类正常流程误拦）；这类漏网由第 2 层自动搬运兜住。
 * - 命令里用相对路径、而 cwd 不在受保护仓库里时判断不出目标（只在 cwd / `-C` / 绝对路径上判）。
 *
 * 判定全程防御性 catch：本扩展失灵时不阻塞会话（与其它守卫一致）。
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEBUG = process.env.MW_DEBUG === "1";
const DEBUG_FILE = "/tmp/main-wip-debug.log";
function dbg(message: string): void {
	if (!DEBUG) return;
	try {
		appendFileSync(DEBUG_FILE, `[${new Date().toISOString()}] ${message}\n`);
	} catch {
		// 调试日志失败不影响功能
	}
}

const HOME = homedir();
const ADD_STATE = join(HOME, ".pi", "agent", "state", "add-mode.json");
const COMMIT_STATE = join(HOME, ".pi", "agent", "state", "commit-mode.json");
const ADOPT = join(HOME, ".pi", "agent", "patch", "worktree-adopt", "worktree-adopt.py");
// 「已搬过、等合并」状态（worktree-adopt.py 的 HOLD 模式写、finalize 成功清）：
// 主工作区保留改动期间，靠它避免把同一批改动反复搬进新 worktree。
const HOLD_STATE = join(HOME, ".pi", "agent", "state", "adopt-hold.json");
// 本会话建过的 worktree（worktree-name-guard.ts / worktree-adopt.py 追加写）
const WORKTREE_LOG = join(HOME, ".pi", "agent", "state", "worktrees.jsonl");
// write / edit 的逃生窗口（存在且 10 分钟内修改过 → 放行）
const ALLOW_FILE = join(HOME, ".pi", "agent", "state", "main-wip-allow");
const ALLOW_TTL_MS = 10 * 60 * 1000;
const BASH_MARK = "AI_AUTHORIZED_MAIN_WIP";
const MAIN_BRANCHES = new Set(["main", "master"]);

const SEGMENT_SPLIT = /&&|\|\||;|\n|\|/;
const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)[ \t]+)+/;
/** 会写盘 / 删文件的 shell 动词（故意不含 python / node：会把 worktree-adopt.py 误拦）。 */
const WRITE_VERBS = new Set([
	"cp",
	"mv",
	"tee",
	"sed",
	"chmod",
	"chown",
	"ln",
	"touch",
	"mkdir",
	"rmdir",
	"install",
	"rsync",
	"tar",
	"unzip",
	"ditto",
	"dd",
	"truncate",
	"patch",
	"shred",
	"rm",
]);

const DENY = (root: string, branch: string, what: string) =>
	`[main-wip-guard] 拦截：\`${root}\` 停在 ${branch} 上（主工作区），而 local ${branch} 不承载任何写操作` +
	`（2026-11-24 起当场拦，不再只事后搬运；本次命中：${what}）。\n` +
	`正确做法（二选一）：\n` +
	`  ① 已有改动要搬走：\`python3 ${ADOPT} --repo ${root}\` —— 自动建 worktree + 功能分支、把改动复制过去，主工作区保持原样；\n` +
	`  ② 还没动手：先建 worktree（\`git -C ${root} worktree add ../${root.split("/").pop()}-<事项> -b <分支>\`），在 worktree 里改。\n` +
	`   然后在 worktree 上走 /add → /commit → PR。\n` +
	`确需在主工作区写文件时须用户当轮明确授权：bash 命令末尾加 \`# ${BASH_MARK}\`；` +
	`write / edit 没有注释位，用 \`touch ${ALLOW_FILE}\` 开 10 分钟窗口。`;

interface RepoState {
	root: string;
	branch: string;
	changed: string[];
	staged: boolean;
}

function git(cwd: string, args: string[], timeout = 8000): { ok: boolean; out: string } {
	try {
		const out = execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf-8",
			timeout,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return { ok: true, out: out ?? "" };
	} catch {
		return { ok: false, out: "" };
	}
}

function normalize(raw: string): string {
	let p = raw.trim();
	if (p === "~") p = HOME;
	else if (p.startsWith("~/")) p = join(HOME, p.slice(2));
	try {
		return resolve(p);
	} catch {
		return p;
	}
}

/** write / edit 的逃生窗口是否打开（存在且 10 分钟内动过）。 */
function allowWindowOpen(): boolean {
	try {
		const st = statSync(ALLOW_FILE);
		return Date.now() - st.mtimeMs < ALLOW_TTL_MS;
	} catch {
		return false;
	}
}

function manualEntries(file: string): string[] {
	try {
		const data = JSON.parse(readFileSync(file, "utf8")) as { manual?: unknown };
		if (!Array.isArray(data?.manual)) return [];
		return data.manual.filter((x): x is string => typeof x === "string" && x.trim() !== "").map(normalize);
	} catch {
		return [];
	}
}

/** add-mode / commit-mode 是否把这个仓库切成了手动（是则不自动搬运）。 */
function pausedByMode(repo: string): string | null {
	for (const [label, file] of [
		["add-mode", ADD_STATE],
		["commit-mode", COMMIT_STATE],
	] as const) {
		if (manualEntries(file).some((p) => repo === p || repo.startsWith(`${p.replace(/\/+$/, "")}/`))) {
			return label;
		}
	}
	return null;
}

/** 这个仓库是否已被 worktree-adopt 复制过、改动还在主工作区等合并；是则返回那批路径。 */
function heldPaths(root: string): string[] | null {
	try {
		const data = JSON.parse(readFileSync(HOLD_STATE, "utf-8")) as Record<string, { paths?: string[] }>;
		const paths = data[root]?.paths;
		return Array.isArray(paths) ? paths : null;
	} catch {
		return null;
	}
}

/** 最近的已存在目录（新建嵌套路径时从最近祖先判仓库归属）。 */
function nearestExistingDir(path: string): string | null {
	let dir = path;
	for (let i = 0; i < 40; i += 1) {
		if (existsSync(dir)) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

/**
 * 候选目录归属的「停在 main 的主工作区」；不是就返回 null。
 * 判据：① 是 git 仓库；② 是**主工作区**（git-dir == git-common-dir，linked worktree 一律放行）；
 * ③ 分支是 main / master；④ 带 GitHub remote（只约束团队仓库，临时 / 本地实验仓库不受影响）。
 */
function protectedMainAt(dir: string): { root: string; branch: string } | null {
	const root = git(dir, ["rev-parse", "--show-toplevel"]).out.trim();
	if (!root) return null;

	const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]).out.trim();
	const commonRaw = git(root, ["rev-parse", "--git-common-dir"]).out.trim();
	if (!gitDir || !commonRaw) return null;
	const common = commonRaw.startsWith("/") ? commonRaw : resolve(root, commonRaw);
	if (resolve(gitDir) !== resolve(common)) return null; // linked worktree：干活的地方，放行

	const branch = git(root, ["branch", "--show-current"]).out.trim();
	if (!MAIN_BRANCHES.has(branch)) return null;

	const remote = git(root, ["remote", "-v"]).out;
	if (!/github\.com[:/]/.test(remote)) return null;
	return { root, branch };
}

function isInside(root: string, target: string): boolean {
	return target === root || target.startsWith(`${root.replace(/\/+$/, "")}/`);
}

/** 从一段 shell 命令里取出「写动作的目标路径」（重定向目标 + 写动词之后的参数）。 */
function writeTargets(segment: string): string[] {
	const tokens = (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ""));
	const targets: string[] = [];
	let sawVerb = false;
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		const redirect = /^(>>?)(\S*)$/.exec(token);
		if (redirect) {
			if (redirect[2]) targets.push(redirect[2]);
			else if (tokens[i + 1]) {
				targets.push(tokens[i + 1]);
				i += 1;
			}
			continue;
		}
		if (WRITE_VERBS.has(token)) {
			// sed 只有带 -i 才是写；不带就是纯读（`sed -n '1,5p' file`）
			if (token === "sed" && !tokens.some((t) => /^-[a-zA-Z]*i[a-zA-Z]*$/.test(t))) continue;
			sawVerb = true;
			continue;
		}
		if (sawVerb && !token.startsWith("-")) targets.push(token);
	}
	return targets.filter(Boolean);
}

/** 候选目录：cwd、`git -C` 目标、以及命令里出现的绝对 / ~ 路径的所在目录。 */
function candidateDirs(segment: string, cwd: string): string[] {
	const dirs = new Set<string>([cwd]);
	for (const match of segment.matchAll(/(?:^|\s)-C\s+("([^"]+)"|'([^']+)'|(\S+))/g)) {
		const dir = match[2] ?? match[3] ?? match[4];
		if (dir) dirs.add(normalize(dir));
	}
	for (const match of segment.matchAll(/(?:^|\s)(~\/\S+|\$\{?HOME\}?\/\S+|\/[^\s"';|&]+)/g)) {
		const raw = match[1].replace(/^\$\{?HOME\}?/, HOME).replace(/^~/, HOME);
		for (const candidate of [raw, dirname(raw)]) {
			const abs = normalize(candidate);
			if (existsSync(abs)) dirs.add(abs);
		}
	}
	return [...dirs];
}

function inspect(cwd: string): RepoState | null {
	const top = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!top.ok || !top.out.trim()) return null;
	const root = top.out.trim();

	const branch = git(root, ["branch", "--show-current"]).out.trim();
	if (!MAIN_BRANCHES.has(branch)) return null;

	const status = git(root, ["status", "--porcelain", "-z"]);
	if (!status.ok || !status.out.trim()) return null;
	const changed = status.out
		.split("\0")
		.filter((entry) => entry.trim() !== "")
		.map((entry) => entry.slice(3));
	const staged = git(root, ["diff", "--cached", "--quiet"]).ok === false;

	return { root, branch, changed, staged };
}

/** 本会话在 worktrees.jsonl 里留下的记录所属的主仓库根（按 path 反查 git-common-dir）。 */
function sessionRepos(sessionId: string): string[] {
	const roots = new Set<string>();
	try {
		const lines = readFileSync(WORKTREE_LOG, "utf8").split("\n");
		for (const line of lines) {
			if (!line.trim()) continue;
			let entry: { sessionId?: string; path?: string; cwd?: string };
			try {
				entry = JSON.parse(line) as { sessionId?: string; path?: string; cwd?: string };
			} catch {
				continue;
			}
			if (entry.sessionId !== sessionId) continue;
			for (const dir of [entry.path, entry.cwd]) {
				if (!dir) continue;
				const common = git(dir, ["rev-parse", "--git-common-dir"]).out.trim();
				if (!common) continue;
				const mainRoot = dirname(common.startsWith("/") ? common : resolve(dir, common));
				roots.add(resolve(mainRoot));
			}
		}
	} catch {
		// 没有记录就用其它来源
	}
	return [...roots];
}

/** cmux 里以 markdown 面板打开的文件名集合（没装 cmux / 没在运行 → 空集）。 */
function cmuxOpenMarkdown(): Set<string> {
	const names = new Set<string>();
	try {
		const out = execFileSync("cmux", ["list-panels"], {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		for (const line of out.split("\n")) {
			const parts = line.trim().split(/\s+/);
			if (!parts.includes("markdown")) continue;
			const title = (parts[parts.length - 1] ?? "").replace(/^"|"$/g, "");
			if (title) names.add(title);
		}
	} catch {
		// cmux 不在 / 未运行 → 视为没有打开的文件
	}
	return names;
}

export default function (pi: ExtensionAPI) {
	// 本会话经 `git -C` 触及过的仓库根（供 agent_settled 扩大搬运范围）
	const touchedRoots = new Set<string>();
	// 已提醒过的「仓库 → 改动签名」：同一处改动不重复催，改动一变立刻再催（不是次数上限）
	const kicked = new Map<string, string>();

	pi.on("input", async (event) => {
		// 用户发了新消息 → 清空提醒记忆，下一轮收尾可以重新提醒
		if ((event as { source?: string })?.source === "interactive") kicked.clear();
	});

	pi.on("tool_call", async (event, ctx) => {
		try {
			const cwd = (ctx as { cwd?: string })?.cwd ?? process.cwd();

			// A) write / edit：目标路径落在「停在 main 的主工作区」→ 当场拦
			if (event.toolName === "write" || event.toolName === "edit") {
				const raw = (event.input as { path?: string })?.path ?? "";
				if (!raw) return;
				const path = normalize(raw);
				const parent = nearestExistingDir(existsSync(path) && statSync(path).isDirectory() ? path : dirname(path));
				if (!parent) return;
				const hit = protectedMainAt(parent);
				if (!hit) return;
				if (allowWindowOpen()) return;
				return { block: true, reason: DENY(hit.root, hit.branch, `\`${raw}\``) };
			}

			if (event.toolName !== "bash") return;
			const command = (event.input as { command?: string })?.command ?? "";
			if (!command || command.includes(BASH_MARK)) return;

			// 顺手记「本会话已经触及的仓库根」，供收尾巡检扩面
			for (const raw of command.split(SEGMENT_SPLIT)) {
				const segment = raw.trim().replace(ENV_PREFIX, "");
				if (!/^git(?=\s|$)/.test(segment)) continue;
				for (const dir of candidateDirs(segment, cwd)) {
					const root = git(dir, ["rev-parse", "--show-toplevel"]).out.trim();
					if (root) touchedRoots.add(root);
				}
			}

			// B) bash 写动作：目标落在「停在 main 的主工作区」→ 当场拦
			// `cd <目录> && …`：写目标落在 cd 之后的目录，不是会话 cwd——不跟着 cd 会误拦
			// 「在别的目录 / worktree 里写文件」这类正常命令（2026-11-24 实测发现）。
			const cdDirs = [...command.matchAll(/(?:^|&&|;|\|\|)\s*cd\s+("([^"]+)"|'([^']+)'|(\S+))/g)]
				.map((m) => m[2] ?? m[3] ?? m[4])
				.filter((d): d is string => Boolean(d));
			const base = cdDirs.length > 0 ? normalize(cdDirs[cdDirs.length - 1]) : cwd;

			for (const raw of command.split(SEGMENT_SPLIT)) {
				const segment = raw.trim().replace(ENV_PREFIX, "");
				if (!segment || /^git(?=\s|$)/.test(segment)) continue; // git 子命令由 git-main-guard 管
				const targets = writeTargets(segment);
				if (targets.length === 0) continue;

				// 先看命令里出现的绝对路径，再看相对路径（相对路径按 base 解析）
				const dirs = new Set<string>();
				for (const target of targets) {
					const abs = normalize(target.replace(/^\$\{?HOME\}?/, HOME));
					if (target.startsWith("/") || target.startsWith("~") || target.startsWith("$")) {
						dirs.add(existsSync(abs) && statSync(abs).isDirectory() ? abs : dirname(abs));
					} else {
						dirs.add(base);
					}
				}
				for (const dir of candidateDirs(segment, base)) dirs.add(dir);

				for (const dir of dirs) {
					const existing = nearestExistingDir(dir);
					const hit = existing ? protectedMainAt(existing) : null;
					if (!hit) continue;
					const inside = targets.some((target) => {
						const abs = normalize(target.replace(/^\$\{?HOME\}?/, HOME));
						return isInside(hit.root, abs);
					});
					// 相对路径（或是 cd 后的隐式目标）按「落在受保护仓库里」处理
					const implicit = targets.every((t) => !t.startsWith("/") && !t.startsWith("~") && !t.startsWith("$"));
					if (!inside && !implicit) continue;
					dbg(`BLOCK bash root=${hit.root} targets=${targets.join(",")}`);
					return { block: true, reason: DENY(hit.root, hit.branch, `\`${segment.slice(0, 120)}\``) };
				}
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

			// 检查范围：cwd 仓库 + 本会话经 `git -C` 触及的仓库 + 本会话建过 worktree 的主仓库
			const candidates = new Set<string>([cwd, ...touchedRoots, ...(sessionId ? sessionRepos(sessionId) : [])]);

			for (const dir of candidates) {
				if (!existsSync(dir)) continue;
				const state = inspect(dir);
				dbg(`agent_settled dir=${dir} state=${JSON.stringify(state)}`);
				if (!state) continue;

				// 暂存区有内容 → 轮不到 AI 动（暂存区红线），等用户处理
				if (state.staged) continue;

				const paused = pausedByMode(state.root);
				dbg(`paused=${paused}`);
				if (paused) continue;

				// 已经把改动复制进 worktree、只等 PR 合并 → 不再重复搬（否则会建出第二个 worktree）
				const held = heldPaths(state.root);
				if (held && state.changed.every((p) => held.includes(p))) {
					dbg(`held in worktree, skip kick root=${state.root}`);
					continue;
				}

				// 同一处改动不重复催（改动变了或用户发过新消息 → 会再催）
				const signature = `${state.branch}|${[...state.changed].sort().join("\u0000")}`;
				if (kicked.get(state.root) === signature) {
					dbg(`same signature, skip kick root=${state.root}`);
					continue;
				}
				kicked.set(state.root, signature);

				// 改动文件在 cmux 里打开：只记日志、不再阻断搬运（2026-11-22 修订）
				// 搬运只往新 worktree 复制、不改主工作区；真正会写磁盘的收尾（--finalize）
				// 自己检查「全文与 origin/main 一致」，不在这里提前挡。
				const opened = cmuxOpenMarkdown();
				const busy = state.changed.filter((p) => opened.has(p.split("/").pop() ?? ""));
				if (busy.length > 0) dbg(`opened in cmux (continue kick): ${busy.join(", ")}`);

				const preview = state.changed.slice(0, 8).join("、");
				dbg(`KICK root=${state.root} changed=${state.changed.length}`);
				pi.sendMessage(
					{
						customType: "main-wip",
						display: false,
						content:
							`【main-wip】主工作区 \`${state.root}\` 停在 ${state.branch} 上，还有 ${state.changed.length} 处未提交改动（${preview}${state.changed.length > 8 ? " …" : ""}）。\n` +
							`按 2026-11-05 规则（用户立规，所有 Agent 遵循）：local main 不承载写操作，这些改动要**自动**搬到功能分支的 worktree 再提交，不询问、不汇报。现在做：\n` +
							`1. \`python3 ${ADOPT} --repo ${state.root}\`（脚本会建 worktree、逐路径复制，**主工作区保留原样**；失败会回滚，主工作区不动）。输出里取 \`WORKTREE=\` 与 \`BRANCH=\`。\n` +
							`2. 在 worktree 上用 \`git -C <WORKTREE>\` 走 /add 预检 → /commit（含 PR 与 CI 合并），全部 git 命令带 \`-C\`，不要 cd。\n` +
							`3. PR 合并后回主工作区跑 \`python3 ${ADOPT} --finalize --repo ${state.root}\` 收尾（校对 origin/main、丢弃已进 main 的改动并快进），否则主工作区会一直挂着「改动」。\n` +
							`4. 脚本拒绝执行时（暂存区有内容 / 有冲突 / add-mode 或 commit-mode 为手动）就停下，按它给的提示处理，不要绕过。`,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			}
		} catch {
			// 判定异常不阻塞会话
		}
	});
}
