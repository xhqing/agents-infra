/**
 * remote main 锁死守卫（pi 端，tool_call 拦截 + 后置审计，2026-11-02 用户立规；2026-11-24 补齐）。
 *
 * 规矩：所有智能体团队项目（Agent 项目 + 其名下子项目）一律锁死 remote main——
 * 不得从本地直接 push main，不得在 main 上直接 commit / add / 改历史；一切改动走
 * worktree 分支 → PR → CI → auto-merge → remote main → 本地 main 快进同步。
 * 文本规则在全局 `~/.pi/agent/AGENTS.md`「开发流程：worktree + PR」节。
 *
 * 拦截范围（只对带 GitHub remote 的仓库生效，避免误伤临时 / 本地实验仓库）：
 * 1. `git push` 的 refspec 指向 main / master（含裸 `git push` 且当前在 main、
 *    `git push origin`、`HEAD:main`、`refs/heads/main`、`--delete main`、
 *    `--all` / `--mirror` 等可能覆盖 main 的形态）；
 * 2. 当前分支为 main / master 时的 `git commit`（含 `git -C <path>` 形态）；
 * 3. 当前分支为 main / master 时的 `git add`（2026-11-03 用户立规：本地 main 只剩
 *    「生成 worktree」与被 remote main 快进同步两个职责，任何写操作第一步都是建 worktree）；
 * 4. **2026-11-24 补的子命令**（此前只有 push / commit / add，另三类 main 写操作全漏，
 *    实测 `git merge --no-ff`、`git reset --soft HEAD~1` 都能在 main 上直接改历史）：
 *    - 在 main 上禁 `reset`（会移动 HEAD 的 `--hard` / `--mixed` / `--soft` / 默认形态；
 *      `git reset <path>` 是暂存区操作，按「暂存区禁止 AI 自主增删改」红线一并拦）、
 *      `rebase`、`cherry-pick`、`revert`、`am`（后四者只放行 `--abort` / `--quit` / `--skip`
 *      这类恢复动作，避免把会话卡死在半途状态）；
 *    - 无论当前在哪个分支都禁「写 main 引用」的形态：`checkout -B main` / `switch -C main`、
 *      `branch -f|-D|-d|-m|-M main`、`update-ref ... refs/heads/main`；
 *    - `pull` **只在会产生非快进时拦**（`--ff-only` 直接放行；`--rebase` / `--no-ff` 拦；
 *      裸 pull 先 fetch 再判断 HEAD 是否为远端分支的祖先，是则放行）。
 *    `git merge` 不在这里判：它由钩子层的 `pre-merge-commit` 兜（快进合并不触发该钩子，
 *    所以 `git merge --ff-only origin/main` 天然不受影响）。
 *
 * 后置审计（只告警不阻塞，2026-11-24 加）：bash 每次执行前后各拍一次快照，`refs/heads/main`
 * 或「当前停在 main 的 HEAD」发生**非快进移动**时向会话发告警——覆盖 reset / force /
 * 别人脚本这类无法在调用前判断的形态（git 没有 pre-reset / pre-checkout 钩子）。
 * 判定用 `merge-base --is-ancestor`，所以正常的快进同步（merge --ff-only、pull --ff-only、
 * pa-merge.sh 的快进）不会误报。
 *
 * 逃生门（仅限用户当轮明确授权，AI 不得自行添加，命令末尾注释）：
 * - push：`# AI_AUTHORIZED_PUSH_MAIN`
 * - commit：`# AI_AUTHORIZED_COMMIT_MAIN`
 * - add：`# AI_AUTHORIZED_ADD_MAIN`
 * - 其余 main 写操作（reset / rebase / cherry-pick / revert / am / checkout -B / branch -f /
 *   update-ref / 非快进 pull）：`# AI_AUTHORIZED_WRITE_MAIN`
 *
 * 另有「门禁授权」（2026-11-23 统一公开 / 私有工作流时加）：私有仓库的 main 由本地门禁
 * `pa-merge.sh` 合入，它用 `PA_MERGE_GATE=1 git push origin HEAD:main`。这种形态属于
 * 「门禁已跑过」而不是「用户授权」，所以单独认 `PA_MERGE_GATE=1`——但**只对已确认私有的仓库**
 * 生效（公开仓库仍须用户授权标记），可见性查不到时按不放行处理（fail-closed）。
 *
 * 判定失败时 fail-open（与其它守卫一致）：守卫失灵不阻塞会话。
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PUSH_MARK = "AI_AUTHORIZED_PUSH_MAIN";
const COMMIT_MARK = "AI_AUTHORIZED_COMMIT_MAIN";
const ADD_MARK = "AI_AUTHORIZED_ADD_MAIN";
const WRITE_MARK = "AI_AUTHORIZED_WRITE_MAIN";
const PA_GATE_MARK = "PA_MERGE_GATE=1";

const VISIBILITY_CACHE = join(homedir(), ".pi", "agent", "state", "repo-visibility.json");
const VISIBILITY_TTL_MS = 24 * 60 * 60 * 1000;
const AUDIT_LOG = join(homedir(), ".pi", "agent", "state", "main-lock-audit.log");

const SEGMENT_SPLIT = /&&|\|\||;|\n|\|/;
const GIT_SEGMENT = /^git(?=\s|$)/;
// 命令前的环境变量赋值（`PA_MERGE_GATE=1 git push ...`、`FOO="a b" git ...`）：
// 这类前缀会把整段开头的 `git` 推到第二个 token——不剥掉就绕过全部检查（2026-11-23 实测发现）。
const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)[ \t]+)+/;
const MAIN_BRANCHES = new Set(["main", "master"]);
/** 半途恢复动作：允许（否则一旦进入 rebase / cherry-pick 中途，会话会被锁死）。 */
const RECOVERY_FLAGS = new Set(["--abort", "--quit", "--skip"]);

const PUSH_DENY =
	"[git-main-guard] 拦截：团队项目锁死 remote main，禁止直接 push main（2026-11-02 用户立规）。" +
	"正确流程：在独立 worktree 的功能分支上提交 → push 分支 → 开 PR → CI → auto-merge → remote main → 本地 main 快进同步。" +
	"确需直推时须用户当轮明确授权，并在命令末尾加 `# AI_AUTHORIZED_PUSH_MAIN`。";

const COMMIT_DENY =
	"[git-main-guard] 拦截：团队项目不允许在 main 上直接提交（2026-11-02 用户立规）。" +
	"正确流程：先建 worktree + 功能分支（`git worktree add ../<仓库>-<事项> -b <分支>`），在分支上提交并走 PR。" +
	"确需在 main 上提交时须用户当轮明确授权，并在命令末尾加 `# AI_AUTHORIZED_COMMIT_MAIN`。";

const ADD_DENY =
	"[git-main-guard] 拦截：local main 只剩两个职责——生成 worktree、被 remote main 快进同步，" +
	"不允许在 main 上 `git add`（2026-11-03 用户立规）。" +
	"正确流程：先生成 worktree（`git worktree add ../<仓库>-<事项> -b <分支>`），" +
	"任何写操作（含 add / commit）全部在 worktree 的功能分支上做。" +
	"确需在 main 上 add 时须用户当轮明确授权，并在命令末尾加 `# AI_AUTHORIZED_ADD_MAIN`。";

function mainWriteDeny(action: string, hint: string): string {
	return (
		`[git-main-guard] 拦截：local main 只承担两件事——生成 worktree、被 origin/main 快进同步，` +
		`不允许在 main 上${action}（2026-11-24 补齐工具强制）。` +
		`正确做法：${hint} ` +
		`确需在 main 上做这类操作时须用户当轮明确授权，并在命令末尾加 \`# ${WRITE_MARK}\`。`
	);
}

type RepoContext = { dir: string; root: string; branch: string; isGitHub: boolean };
type Visibility = "private" | "public" | "unknown";
type VisibilityCache = Record<string, { visibility?: string; checked?: number }>;

function execGit(dir: string, args: string[], timeout = 5000): string | null {
	try {
		return execFileSync("git", ["-C", dir, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout,
		}).trim();
	} catch {
		return null;
	}
}

/** 从 `git -C <path> ...` 里取出 -C 路径；没有则用调用方 cwd。 */
function repoDirFromSegment(segment: string, fallback: string): string {
	// 只认 git 的**全局选项** -C（必须出现在子命令之前）。子命令自己的 -C 不是路径：
	// `git switch -C main`（大写 C = 重建分支）、`git branch -C a b`（复制）都在此列，
	// 早期实现把 "main" 当成路径 → 仓库上下文解析失败 → 整条检查被 continue 放过
	// （2026-11-24 测试捕获）。
	const head = /^git(?:\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)|--\S+|-p|-P|-c\s+\S+))*\s+[a-z-]+/.exec(segment)?.[0] ?? segment;
	const match = /(?:^|\s)-C\s+("([^"]+)"|'([^']+)'|(\S+))/.exec(head);
	const dir = match?.[2] ?? match?.[3] ?? match?.[4];
	if (!dir) return fallback;
	return dir.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
}

/** 远端 origin 的 GitHub `owner/repo`；不是 GitHub 远端时返回 null。 */
function remoteSlug(dir: string): string | null {
	const url = execGit(dir, ["remote", "get-url", "origin"]);
	if (!url || !/github\.com[:/]/.test(url)) return null;
	const slug = url
		.replace(/^git@[^:]*:/, "")
		.replace(/^https?:\/\/[^/]*\//, "")
		.replace(/\.git$/, "")
		.replace(/\/+$/, "");
	const parts = slug.split("/");
	return parts.length === 2 && parts.every(Boolean) ? slug : null;
}

function readVisibilityCache(): VisibilityCache {
	try {
		const parsed: unknown = JSON.parse(readFileSync(VISIBILITY_CACHE, "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as VisibilityCache) : {};
	} catch {
		return {};
	}
}

/** 仓库可见性（本地缓存 1 天，未命中查 gh；查不到返回 unknown）。 */
function repoVisibility(dir: string): Visibility {
	const slug = remoteSlug(dir);
	if (!slug) return "unknown";
	const cache = readVisibilityCache();
	const hit = cache[slug];
	if (hit?.visibility && Date.now() - (hit.checked ?? 0) < VISIBILITY_TTL_MS) {
		return hit.visibility as Visibility;
	}
	let visibility: Visibility = "unknown";
	try {
		const out = execFileSync("gh", ["api", `repos/${slug}`, "--jq", ".private"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 8000,
		}).trim();
		visibility = out === "true" ? "private" : out === "false" ? "public" : "unknown";
	} catch {
		visibility = "unknown";
	}
	try {
		cache[slug] = { visibility, checked: Date.now() };
		writeFileSync(VISIBILITY_CACHE, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
	} catch {
		// 写缓存失败不影响判定
	}
	return visibility;
}

function repoContext(segment: string, cwd: string): RepoContext | null {
	const dir = repoDirFromSegment(segment, cwd);
	const root = execGit(dir, ["rev-parse", "--show-toplevel"]);
	if (!root) return null;
	const branch = execGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (!branch) return null;
	const remote = execGit(dir, ["remote", "-v"]) ?? "";
	const isGitHub = /github\.com[:/]/.test(remote);
	return { dir, root, branch, isGitHub };
}

/** 去掉引号、解析 `<sub>` 之后的 token（跳过 git 自身的全局选项）。 */
function argTokens(segment: string, sub: string): string[] {
	const match = new RegExp(`(?:^|\\s)${sub.replace(/[-]/g, "\\-")}(?=\\s|$)([\\s\\S]*)$`).exec(segment);
	if (!match) return [];
	return match[1]
		.replace(/["'`]/g, "")
		.split(/\s+/)
		.map((token) => token.trim())
		.filter(Boolean);
}

function targetsMain(tokens: string[], currentBranch: string): boolean {
	// `--all` / `--mirror` 会推送所有分支（含 main）；`--delete main` 会删 main。
	if (tokens.includes("--all") || tokens.includes("--mirror")) return true;

	const positional = tokens.filter((token) => !token.startsWith("-"));
	// positional[0] 是 remote，其余是 refspec。
	const refspecs = positional.slice(1);

	if (refspecs.length === 0) {
		// 裸 push（或只给 remote）：推当前分支 → 当前在 main 就命中。
		return MAIN_BRANCHES.has(currentBranch);
	}

	return refspecs.some((refspec) => {
		// `HEAD:main` / `main:main` / `refs/heads/main` / `+main` 等形态，取冒号右侧（无冒号则整体）。
		const target = refspec.includes(":") ? refspec.split(":").pop() ?? refspec : refspec;
		const normalized = target.replace(/^\+/, "").replace(/^refs\/heads\//, "");
		return MAIN_BRANCHES.has(normalized);
	});
}

/** `-f main` / `-B main` 这类「选项 + 参数」组合里，参数是否是 main。 */
function flagTargetsMain(tokens: string[], flags: Set<string>): boolean {
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (!flags.has(token)) continue;
		const next = tokens[i + 1];
		if (next && MAIN_BRANCHES.has(next.replace(/^refs\/heads\//, ""))) return true;
	}
	return false;
}

function hasRecoveryFlag(tokens: string[]): boolean {
	return tokens.some((token) => RECOVERY_FLAGS.has(token));
}

function isAncestor(dir: string, oldSha: string, newSha: string): boolean {
	if (!oldSha || !newSha || oldSha === newSha) return true;
	const out = execGit(dir, ["merge-base", "--is-ancestor", oldSha, newSha]);
	// 成功时 execGit 返回 ""（--is-ancestor 无输出）；失败返回 null。
	return out !== null;
}

/**
 * `git pull` 会不会产生非快进？
 * 先 fetch 一次拿到真实目标（否则判断基于过期引用），再用 is-ancestor 判。
 * fetch 失败（离线 / 无远端）时退回 @{u} 判断，仍判不出则按「会」处理（fail-closed）。
 */
function pullWouldNonFastForward(context: RepoContext, tokens: string[]): boolean {
	if (tokens.includes("--ff-only")) return false;
	if (tokens.includes("--rebase") || tokens.includes("--no-rebase") || tokens.includes("--no-ff")) return true;

	const positional = tokens.filter((token) => !token.startsWith("-"));
	const remote = positional[0] && !positional[0].includes("=") ? positional[0] : "origin";
	const branch = positional[1] ?? context.branch;

	const before = execGit(context.dir, ["rev-parse", "HEAD"]);
	if (!before) return true;
	const fetched = execGit(context.dir, ["fetch", "-q", remote, branch], 15000);
	let target = fetched === null ? execGit(context.dir, ["rev-parse", "@{u}"]) : execGit(context.dir, ["rev-parse", "FETCH_HEAD"]);
	if (!target) target = execGit(context.dir, ["rev-parse", `refs/remotes/${remote}/${branch}`]);
	if (!target) return true;
	return !isAncestor(context.dir, before, target);
}

// ── 后置审计：HEAD / main 引用的非快进移动 ────────────────────────────────
type RepoSnapshot = { branch: string; head: string; main: string };

const snapshots = new Map<string, RepoSnapshot>();

function snapshotOf(dir: string): { root: string; snap: RepoSnapshot } | null {
	const root = execGit(dir, ["rev-parse", "--show-toplevel"]);
	if (!root) return null;
	const head = execGit(root, ["rev-parse", "HEAD"]);
	if (!head) return null;
	const branch = execGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "";
	const main = execGit(root, ["rev-parse", "--verify", "-q", "refs/heads/main"]) ?? execGit(root, ["rev-parse", "--verify", "-q", "refs/heads/master"]) ?? "";
	return { root, snap: { branch, head, main } };
}

/**
 * 拍快照并在有前值时比对：main 引用或「当前停在 main 的 HEAD」发生非快进移动即返回告警文案。
 * 只告警、不阻塞（git 没有 pre-reset / pre-checkout 钩子，这类移动只能在事后发现）。
 */
function observe(dir: string): string | null {
	let parsed: { root: string; snap: RepoSnapshot } | null = null;
	try {
		parsed = snapshotOf(dir);
	} catch {
		return null;
	}
	if (!parsed) return null;
	const { root, snap } = parsed;
	const prev = snapshots.get(root);
	snapshots.set(root, snap);
	if (!prev) return null;

	const problems: string[] = [];
	if (prev.main && snap.main && prev.main !== snap.main && !isAncestor(root, prev.main, snap.main)) {
		problems.push(`main 引用被改成非快进提交：${prev.main.slice(0, 7)} → ${snap.main.slice(0, 7)}`);
	}
	if (
		problems.length === 0 &&
		MAIN_BRANCHES.has(snap.branch) &&
		prev.branch === snap.branch &&
		prev.head !== snap.head &&
		!isAncestor(root, prev.head, snap.head)
	) {
		problems.push(`${snap.branch} 的 HEAD 被改成非快进提交：${prev.head.slice(0, 7)} → ${snap.head.slice(0, 7)}`);
	}
	if (problems.length === 0) return null;
	return (
		`⚠️ [git-main-guard 后置审计] 检测到主分支的非快进移动（本次**不拦截**，只告警）：\n` +
		problems.map((p) => `- \`${root}\`：${p}`).join("\n") +
		`\n正常只有快进同步（\`git merge --ff-only origin/main\`、\`git pull --ff-only\`、pa-merge.sh）会移动 main；` +
		`reset / 强推 / 别人的脚本也会造成这种移动。请确认它是否符合预期，若来自非本会话操作，告知用户。`
	);
}

function logAudit(text: string): void {
	try {
		appendFileSync(AUDIT_LOG, `[${new Date().toISOString()}] ${text}\n`);
	} catch {
		// 日志失败不影响功能
	}
}

export default function (pi: ExtensionAPI) {
	/** 把审计告警发给会话（只告警、不阻塞），并落一份日志。 */
	const notify = (text: string): void => {
		logAudit(text);
		try {
			pi.sendMessage({ customType: "main-lock-audit", display: true, content: text }, { deliverAs: "steer" });
		} catch {
			// 发消息失败不影响工具调用
		}
	};

	// 每条 bash 命令涉及到的目录：从 `-C` 与 cwd 收集，供前后快照用。
	const dirsOf = (command: string, cwd: string): string[] => {
		const dirs = new Set<string>([cwd]);
		for (const raw of command.split(SEGMENT_SPLIT)) {
			const segment = raw.trim();
			if (!segment.includes("git")) continue;
			for (const match of segment.matchAll(/(?:^|\s)-C\s+("([^"]+)"|'([^']+)'|(\S+))/g)) {
				const dir = match[2] ?? match[3] ?? match[4];
				if (dir) dirs.add(dir.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
			}
		}
		return [...dirs];
	};

	pi.on("tool_call", async (event) => {
		try {
			if (!isToolCallEventType("bash", event)) return;
			const command = event.input.command ?? "";
			const cwd = process.cwd();
			const involved = dirsOf(command, cwd);

			// 前置审计：先对本次涉及的目录拍快照（同时补报「上次离开后发生的非快进移动」，
			// 例如用户在终端里自己 push -f / reset），得到的就是本命令执行「前」的 HEAD。
			const preWarnings: string[] = [];
			for (const dir of involved) {
				try {
					const warning = observe(dir);
					if (warning) preWarnings.push(warning);
				} catch {
					// 忽略单个目录的失败
				}
			}
			if (preWarnings.length > 0) notify(preWarnings.join("\n\n"));

			for (const raw of command.split(SEGMENT_SPLIT)) {
				const segment = raw.trim().replace(ENV_PREFIX, "");
				if (!GIT_SEGMENT.test(segment)) continue;

				const subcommand = /^git(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+)|\s+--\S+)*\s+([a-z-]+)/.exec(segment)?.[1];
				if (!subcommand) continue;

				// 只关心会改 main / 改历史的子命令
				if (
					!["push", "commit", "add", "reset", "rebase", "cherry-pick", "revert", "am", "checkout", "switch", "branch", "update-ref", "pull"].includes(
						subcommand,
					)
				) {
					continue;
				}

				// 三种情况都要先确认「是带 GitHub remote 的仓库」，避免误伤本地实验仓库。
				const context = repoContext(segment, cwd);
				if (!context || !context.isGitHub) continue;
				const tokens = argTokens(segment, subcommand);
				const onMain = MAIN_BRANCHES.has(context.branch);

				if (subcommand === "add") {
					if (!command.includes(ADD_MARK) && onMain) return { block: true, reason: ADD_DENY };
					continue;
				}

				if (subcommand === "commit") {
					if (!command.includes(COMMIT_MARK) && onMain) return { block: true, reason: COMMIT_DENY };
					continue;
				}

				if (subcommand === "push") {
					if (targetsMain(tokens, context.branch)) {
						// 门禁授权：只对已确认私有的仓库生效（公开仓库仍须用户授权标记）
						if (command.includes(PA_GATE_MARK) && repoVisibility(context.dir) === "private") continue;
						return { block: true, reason: PUSH_DENY };
					}
					continue;
				}

				if (command.includes(WRITE_MARK)) continue;

				if (subcommand === "reset") {
					if (!onMain) continue;
					const pathForm = tokens.some((token) => !token.startsWith("-") && token !== "HEAD" && !token.startsWith("HEAD"));
					return {
						block: true,
						reason: pathForm
							? // `git reset <path>` 不移动 HEAD，但会改暂存区——那是「暂存区禁止 AI 自主增删改」的红线
								`[git-main-guard] 拦截：\`git reset <path>\` 会改暂存区内容，而暂存区禁止 AI 自主增删改（全局红线），` +
								`当前又在 main 上（2026-11-24 补齐）。要看某个文件的历史用 \`git show HEAD:<path>\`；` +
								`确需改暂存区须用户当轮明确授权，并在命令末尾加 \`# ${WRITE_MARK}\`。`
							: mainWriteDeny(
									"用 `git reset` 移动 HEAD / 改暂存区",
									"同步 main 只走快进：`git merge --ff-only origin/main`（不要用 reset 对齐）；需要改动先建 worktree + 功能分支。",
								),
					};
				}

				if (subcommand === "rebase" || subcommand === "cherry-pick" || subcommand === "revert" || subcommand === "am") {
					if (!onMain) continue;
					if (hasRecoveryFlag(tokens)) continue; // --abort / --quit / --skip：半途恢复，放行
					const action =
						subcommand === "rebase"
							? "用 `git rebase` 改写历史"
							: subcommand === "cherry-pick"
								? "用 `git cherry-pick` 落提交"
								: subcommand === "revert"
									? "用 `git revert` 落提交"
									: "用 `git am` 落提交";
					return {
						block: true,
						reason: mainWriteDeny(
							action,
							"先在功能分支上做（`git switch -c <分支>` 或 `git worktree add ../<仓库>-<事项> -b <分支>`），再走 PR / pa-merge.sh。",
						),
					};
				}

				if (subcommand === "checkout" || subcommand === "switch") {
					const forceFlags = subcommand === "checkout" ? new Set(["-B"]) : new Set(["-C"]);
					if (flagTargetsMain(tokens, forceFlags)) {
						return {
							block: true,
							reason: mainWriteDeny(
								`用 \`git ${subcommand} -${subcommand === "checkout" ? "B" : "C"} main\` 重置 main 引用`,
								"要同步 main 用 `git merge --ff-only origin/main`；要把某个提交搬到 main 上，走功能分支 + PR / pa-merge.sh。",
							),
						};
					}
					continue;
				}

				if (subcommand === "branch") {
					const writeFlags = new Set(["-f", "--force", "-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy"]);
					if (flagTargetsMain(tokens, writeFlags)) {
						return {
							block: true,
							reason: mainWriteDeny(
								"用 `git branch` 强制改写 / 删除 / 移动 main",
								"main 只经快进同步（`git merge --ff-only origin/main`）；不要用 `branch -f` / `-D` 动 main。",
							),
						};
					}
					continue;
				}

				if (subcommand === "update-ref") {
					const touchesMain = tokens.some((token) =>
						/^refs\/heads\/(main|master)$/.test(token.replace(/^\+/, "")) || MAIN_BRANCHES.has(token.replace(/^refs\/heads\//, "")),
					);
					if (touchesMain) {
						return {
							block: true,
							reason: mainWriteDeny(
								"用 `git update-ref` 直接改 main 引用",
								"同步 main 用 `git merge --ff-only origin/main`（或 pa-merge.sh），不要直接改引用。",
							),
						};
					}
					continue;
				}

				if (subcommand === "pull") {
					if (!onMain) continue;
					if (!pullWouldNonFastForward(context, tokens)) continue;
					return {
						block: true,
						reason: mainWriteDeny(
							"用会产出非快进的 `git pull`",
							"同步 main 只用 `git pull --ff-only origin main`（或用 `git fetch` + `git merge --ff-only origin/main`）；" +
								"确实要合并别的分支，走 worktree + PR / pa-merge.sh。",
						),
					};
				}
			}
		} catch {
			// fail-open：守卫自身异常不阻塞会话
		}
	});

	// 后置审计：命令跑完比对快照（reset / 强推 / 别人的脚本这类动完才知道的移动）
	pi.on("tool_result", async (event, ctx) => {
		try {
			if (event.toolName !== "bash") return;
			const command = (event.input as { command?: string })?.command ?? "";
			const cwd = (ctx as { cwd?: string })?.cwd ?? process.cwd();
			const warnings: string[] = [];
			for (const dir of dirsOf(command, cwd)) {
				try {
					const warning = observe(dir);
					if (warning) warnings.push(warning);
				} catch {
					// 忽略单个目录的失败
				}
			}
			if (warnings.length === 0) return;
			notify(warnings.join("\n\n"));
		} catch {
			// fail-open
		}
	});
}
