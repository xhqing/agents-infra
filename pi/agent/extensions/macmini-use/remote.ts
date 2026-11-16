/**
 * macmini-use 的远端执行层：把命令送到 macmini 跑，并把结果带回来。
 *
 * 关键取舍：
 *   - 统一用 `ssh mac-mini bash -s` + stdin 传脚本，而不是把命令拼进 ssh 参数
 *     ——省掉多层引号地狱，命令原样执行，退出码也能原样带回。
 *   - 远端脚本开头固定 PATH：macmini 上 `bash -lc` 会拿到 Node 16（~/.profile 里的
 *     旧 nvm 路径），非登录 shell 的默认 PATH 才是 Node 22；显式钉住顺序，避免
 *     「同一个命令在两台机器上跑出不同 Node 版本」这种隐蔽差异。
 *   - 长任务用 **tmux 会话** + 独立日志（/tmp/macmini-jobs/），SSH 断了也不影响（2026-11-16
 *     用户立规：后台进程一律在 tmux 里跑，本机与 macmini 同此）；日志放 /tmp 是刻意的——
 *     那不在 Syncthing 镜像里，不会把日志刷回本机。
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** SSH 别名（见 ~/.ssh/config：Tailscale MagicDNS，任何网络都能连）。 */
export const REMOTE_HOST = "mac-mini";

/** macmini 上的家目录（本机是 /Users/xhq，两机目录结构一致、只差 home）。 */
export const REMOTE_HOME = "/Users/mac";

/** 远端固定 PATH：Node 22 在最前，其余是 macOS 默认位置。 */
const REMOTE_PATH_EXPORT =
	'export PATH="$HOME/.local/node/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"';

export interface MappedPath {
	/** macmini 上对应的绝对路径。 */
	remote: string;
	/** 是否落在两机镜像范围内（否：该路径在 macmini 上没有同一份数据）。 */
	mirrored: boolean;
}

/**
 * 把本机路径映射成 macmini 上的路径。
 * 规则：两机 home 不同（/Users/<用户>），其余路径按 home 相对映射；2026-11-05 起只有
 * `~/.pi/agent` 与 `~/.dev/private` 是共享目录，`~/Developer` 是各自独立的 clone。
 */
export function mapPath(localPath: string): MappedPath {
	let p = (localPath ?? "").trim();
	if (p === "" || p === "~") p = homedir();
	else if (p.startsWith("~/")) p = resolve(homedir(), p.slice(2));
	else if (!p.startsWith("/")) p = resolve(p);

	if (p === REMOTE_HOME || p.startsWith(REMOTE_HOME + "/")) {
		return { remote: p, mirrored: true }; // 调用方已经写了远端路径
	}
	const home = homedir();
	if (p === home) return { remote: REMOTE_HOME, mirrored: true };
	if (p.startsWith(home + "/")) return { remote: REMOTE_HOME + p.slice(home.length), mirrored: true };
	return { remote: p, mirrored: false };
}

/** 单引号安全引用（只用于我们自己拼的路径，不用于用户命令正文）。 */
export function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 组装远端要执行的脚本正文（带 PATH、可选 cd）。 */
export function buildScript(remoteCwd: string | null, command: string): string {
	const lines: string[] = [REMOTE_PATH_EXPORT];
	if (remoteCwd) {
		lines.push(`cd ${shq(remoteCwd)} || {`);
		lines.push(`  echo "[macmini-use] 远端目录不存在：${remoteCwd}" >&2`);
		lines.push(`  echo "[macmini-use] 多半是刚在本机建的目录、Syncthing 还没同步过去（约 3 秒）；确认远端存在再跑。" >&2`);
		lines.push(`  exit 97`);
		lines.push(`}`);
	}
	lines.push(command);
	return lines.join("\n") + "\n";
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	/** 远端退出码（SSH 自身失败时是 255 / null）。 */
	code: number | null;
	timedOut: boolean;
	durationMs: number;
}

export interface ExecOptions {
	timeoutMs: number;
	signal?: AbortSignal;
}

/**
 * 同步执行：把脚本从 stdin 交给远端 bash，等它跑完。
 * 超时只杀本地 ssh 进程，远端命令可能继续跑——长任务请改用 launchRemote。
 */
export function execRemote(script: string, opts: ExecOptions): Promise<ExecResult> {
	const started = Date.now();
	return new Promise((resolvePromise) => {
		const child = spawn(
			"ssh",
			[
				"-o", "BatchMode=yes",
				"-o", "ConnectTimeout=10",
				"-o", "ServerAliveInterval=20",
				"-o", "ServerAliveCountMax=3",
				REMOTE_HOST,
				"bash -s",
			],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener?.("abort", onAbort);
			resolvePromise({ stdout, stderr, code, timedOut, durationMs: Date.now() - started });
		};

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 1500);
		}, Math.max(1000, opts.timeoutMs));

		const onAbort = () => {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 1500);
		};
		opts.signal?.addEventListener?.("abort", onAbort, { once: true });

		child.stdout?.on("data", (b: Buffer) => {
			if (stdout.length < 4_000_000) stdout += b.toString("utf8");
		});
		child.stderr?.on("data", (b: Buffer) => {
			if (stderr.length < 1_000_000) stderr += b.toString("utf8");
		});
		child.on("error", (err) => {
			stderr += `[macmini-use] 无法启动 ssh：${err.message}\n`;
			finish(null);
		});
		child.on("close", (code) => finish(code));
		child.stdin?.end(script);
	});
}

export interface LaunchResult {
	jobId: string;
	pid: string;
	/** 承载任务的远端 tmux 会话名（pi-mm-<jobId>；可 attach 看实时输出）。 */
	session: string;
	logPath: string;
	scriptPath: string;
	error?: string;
}

/**
 * 后台启动：把脚本写成远端 /tmp 下的文件，在**独立 tmux 会话**里跑，立刻返回日志路径。
 * 2026-11-16 用户立规：后台进程一律在 tmux 里跑（SSH 断了 / 终端关了任务也不丢）。
 * 之后用 `macmini_run` 执行 `tail -n 60 <log>` 取进度 / 结果。
 */
export async function launchRemote(script: string, label: string): Promise<LaunchResult> {
	const jobId = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
	const session = `pi-mm-${jobId}`;
	const scriptPath = `/tmp/macmini-jobs/${jobId}.sh`;
	const logPath = `/tmp/macmini-jobs/${jobId}.log`;
	const rcPath = `/tmp/macmini-jobs/${jobId}.rc`;
	// 输出重定向 / 退出码都写进脚本自己（少一层引号地狱）：tmux 直接 exec 这个脚本即可。
	const wrapped = [
		"exec </dev/null",
		`exec > ${shq(logPath)} 2>&1`,
		"__pi_bg_finish() {",
		"  __pi_bg_rc=$?",
		"  exec >/dev/null 2>&1",
		`  printf '%s\\n' "$__pi_bg_rc" > ${shq(rcPath)}`,
		'  exit "$__pi_bg_rc"',
		"}",
		"trap __pi_bg_finish EXIT",
		script,
	].join("\n");
	const hex = Buffer.from(wrapped, "utf8").toString("hex");
	const launcher = [
		"set -e",
		"mkdir -p /tmp/macmini-jobs",
		// 用 hex + xxd 写脚本：避开所有引号 / 换行 / $ 的转义问题。
		`printf '%s' '${hex}' | xxd -r -p > ${scriptPath}`,
		`tmux kill-session -t =${session} 2>/dev/null || true`,
		`tmux new-session -d -s ${session} -c "$HOME" /bin/bash ${scriptPath}`,
		`tmux list-panes -t =${session} -F 'PID=#{pane_pid}'`,
		label ? `echo "LABEL=${label.replace(/"/g, "")}"` : "true",
	].join("\n");

	const res = await execRemote(launcher, { timeoutMs: 60_000 });
	if (res.code !== 0) {
		return { jobId, pid: "", session, logPath, scriptPath, error: (res.stderr || res.stdout || "").trim() };
	}
	const pid = res.stdout.match(/^PID=(\d+)$/m)?.[1] ?? "";
	return { jobId, pid, session, logPath, scriptPath };
}

/** 两机负载概览脚本（macmini_status 用）。 */
export const STATUS_SCRIPT = [
	REMOTE_PATH_EXPORT,
	'echo "host=$(hostname)  arch=$(uname -m)  cores=$(sysctl -n hw.ncpu)  mem=$(($(sysctl -n hw.memsize) / 1073741824))GB"',
	'echo "load=$(sysctl -n vm.loadavg | tr -d "{}")"',
	'echo "disk=$(df -h / | tail -1 | awk \'{print $4 " 可用 / " $2 " 总"}\')"',
	'echo "--- 占 CPU 前 5 的进程 ---"',
	"ps -Ao pcpu,pmem,comm -r | head -6",
	'echo "--- tmux 会话 ---"',
	"tmux ls 2>/dev/null | head -10 || echo '(无)'",
	'echo "--- /tmp/macmini-jobs 最近日志 ---"',
	"ls -t /tmp/macmini-jobs/*.log 2>/dev/null | head -5 || echo '(无)'",
].join("\n");
