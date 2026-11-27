/**
 * Goal extension — a persistent completion contract for the current session.
 *
 * Modeled on Codex CLI `/goal` (codex-rs/ext/goal):
 *   - one goal per session, persisted to disk and restored on resume
 *   - `/goal <objective>` sets it, `/goal` inspects, plus pause / resume / clear / edit / budget
 *   - model-facing tools: create_goal / get_goal / update_goal
 *   - after every run, if the goal is still active and the budget allows, a continuation
 *     turn is queued automatically (followUp), so the work keeps going without re-prompting
 *
 * Continuation is queued from `agent_end`, not `agent_settled`: by the time
 * `agent_settled` fires Pi will not start a turn on its own, and a manual turn
 * started from that handler does not run (verified on pi 0.0.12 / 0.0.13).
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "pi-coding-agent";
import { Type } from "typebox";
import {
	activeGoalNote,
	budgetLimitPrompt,
	continuationPrompt,
	goalSetNotice,
	type GoalSnapshot,
	objectiveUpdatedPrompt,
	statusLine,
} from "./templates.ts";

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

type GoalStatus = "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";

interface GoalState {
	version: 1;
	sessionId: string;
	goalId: string;
	objective: string;
	status: GoalStatus;
	tokensUsed: number;
	costUsed: number;
	timeUsedSeconds: number;
	turns: number;
	createdAt: number;
	updatedAt: number;
	tokenBudget?: number;
	lastReason?: string;
	lastBlocker?: string;
	noToolTurns: number;
	haltReason?: string;
	completedAt?: number;
}

interface RunStats {
	tokens: number;
	cost: number;
	seconds: number;
	usedTools: boolean;
	lastText?: string;
	stopReason?: string;
	errorMessage?: string;
}

const STATE_DIR = join(homedir(), ".pi", "agent", "state", "goal");
const NO_TOOL_LIMIT = 3;
const REASON_MAX_CHARS = 200;

const UNFINISHED: GoalStatus[] = ["active", "paused", "blocked", "usage_limited", "budget_limited"];

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function newGoalId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function stateFile(sessionId: string): string {
	return join(STATE_DIR, `${sessionId}.json`);
}

function sessionIdOf(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
}

function loadState(sessionId: string | undefined): GoalState | undefined {
	if (!sessionId) return undefined;
	try {
		const raw = readFileSync(stateFile(sessionId), "utf-8");
		const parsed = JSON.parse(raw) as GoalState;
		if (parsed.version !== 1) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

function saveState(state: GoalState | undefined): void {
	if (!state) return;
	try {
		mkdirSync(STATE_DIR, { recursive: true });
		writeFileSync(stateFile(state.sessionId), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
	} catch {
		// Persistence is best-effort: a failed write must not break the turn.
	}
}

function dropState(state: GoalState | undefined): void {
	if (!state) return;
	try {
		rmSync(stateFile(state.sessionId), { force: true });
	} catch {
		// ignore
	}
}

function snapshotOf(state: GoalState): GoalSnapshot {
	return {
		objective: state.objective,
		status: state.status,
		turns: state.turns,
		tokensUsed: state.tokensUsed,
		tokenBudget: state.tokenBudget,
		lastReason: state.lastReason,
	};
}

function touch(state: GoalState): void {
	state.updatedAt = Date.now();
}

function finite(n: unknown): number {
	return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/** Pull per-run stats out of the messages of a finished run. */
function collectRunStats(messages: readonly unknown[], startedAt: number): RunStats {
	let tokens = 0;
	let cost = 0;
	let usedTools = false;
	let lastText: string | undefined;
	let stopReason: string | undefined;
	let errorMessage: string | undefined;

	for (const raw of messages) {
		const msg = raw as {
			role?: string;
			content?: unknown;
			usage?: { totalTokens?: number; cost?: { total?: number } };
			stopReason?: string;
			errorMessage?: string;
		};
		if (!msg || typeof msg !== "object") continue;

		if (msg.role === "assistant") {
			const usage = msg.usage;
			if (usage) {
				tokens += finite(usage.totalTokens);
				cost += finite(usage.cost?.total);
			}
			if (msg.stopReason) stopReason = msg.stopReason;
			if (msg.errorMessage) errorMessage = msg.errorMessage;
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					const b = block as { type?: string; text?: string };
					if (!b || typeof b !== "object") continue;
					if (b.type === "toolCall" || b.type === "tool_use") usedTools = true;
					if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
						lastText = b.text.trim();
					}
				}
			}
		}
		if (msg.role === "toolResult" || msg.role === "tool") usedTools = true;
	}

	return {
		tokens,
		cost,
		seconds: startedAt > 0 ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0,
		usedTools,
		lastText,
		stopReason,
		errorMessage,
	};
}

/** Last meaningful line of an assistant reply, trimmed for the status display. */
function clipReason(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const line = text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.pop();
	if (!line) return undefined;
	return line.length > REASON_MAX_CHARS ? `${line.slice(0, REASON_MAX_CHARS - 1)}…` : line;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function goalExtension(pi: ExtensionAPI): void {
	let state: GoalState | undefined;
	let runStartedAt = 0;
	let pendingContinuation = false;
	let budgetWrapupSent = false;
	let lastStopReason: string | undefined;
	let lastRunHadTools = false;
	let runStartedWithActiveGoal = false;

	function refreshStatus(ctx: ExtensionContext): void {
		if (!state || state.status === "complete") {
			ctx.ui.setStatus("goal", undefined);
			return;
		}
		ctx.ui.setStatus("goal", statusLine(snapshotOf(state)));
	}

	function persist(ctx?: ExtensionContext): void {
		if (state) {
			touch(state);
			saveState(state);
		}
		if (ctx) refreshStatus(ctx);
	}

	function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
		try {
			ctx.ui.notify(text, level);
		} catch {
			// notify is best-effort (no-op in print mode)
		}
	}

	function startGoal(ctx: ExtensionContext, objective: string, budget: number | undefined): void {
		const sessionId = sessionIdOf(ctx);
		if (!sessionId) {
			notify(ctx, "Cannot set a goal: session id unavailable.", "error");
			return;
		}
		const now = Date.now();
		state = {
			version: 1,
			sessionId,
			goalId: newGoalId(),
			objective,
			status: "active",
			tokensUsed: 0,
			costUsed: 0,
			timeUsedSeconds: 0,
			turns: 0,
			createdAt: now,
			updatedAt: now,
			tokenBudget: budget,
			noToolTurns: 0,
		};
		budgetWrapupSent = false;
		persist(ctx);
		notify(ctx, goalSetNotice(snapshotOf(state)));
	}

	function clearGoal(ctx: ExtensionContext, reason: string): void {
		if (!state) {
			notify(ctx, "No goal set.", "info");
			return;
		}
		const objective = state.objective;
		dropState(state);
		state = undefined;
		budgetWrapupSent = false;
		pendingContinuation = false;
		ctx.ui.setStatus("goal", undefined);
		notify(ctx, `Goal cleared: ${objective}${reason ? ` (${reason})` : ""}`, "info");
	}

	function setStatus(ctx: ExtensionContext, status: GoalStatus, reason?: string): void {
		if (!state) return;
		state.status = status;
		if (reason !== undefined) state.haltReason = reason;
		if (status === "complete") state.completedAt = Date.now();
		persist(ctx);
	}

	async function resumeGoal(ctx: ExtensionCommandContext): Promise<void> {
		if (!state) {
			notify(ctx, "No goal set. Use /goal <objective>.", "info");
			return;
		}
		if (state.status === "complete") {
			notify(ctx, "This goal is already complete. Set a new one with /goal <objective>.", "info");
			return;
		}
		state.status = "active";
		state.haltReason = undefined;
		state.noToolTurns = 0;
		budgetWrapupSent = false;
		persist(ctx);
		notify(ctx, `Goal resumed: ${state.objective}`, "info");
		await kickFromCommand(ctx, continuationPrompt(snapshotOf(state)), "goal-continuation");
	}

	async function kickOff(content: string, customType: string): Promise<void> {
		pendingContinuation = true;
		try {
			// pi.sendMessage() is fire-and-forget (returns void); the queued followUp is
			// drained by the session once the current run settles.
			pi.sendMessage({ customType, content, display: false }, { deliverAs: "followUp", triggerTurn: true });
		} catch {
			// If the turn cannot be started, the goal stays active for the next user turn.
		}
	}

	/**
	 * Start a goal turn from a command handler.
	 *
	 * In one-shot modes (print / json) the command handler is the only thing keeping
	 * the process alive, so it waits for the whole goal loop to settle. In interactive
	 * modes the command returns immediately and the turn runs in the background.
	 */
	async function kickFromCommand(ctx: ExtensionCommandContext, content: string, customType: string): Promise<void> {
		const oneShot = ctx.mode === "print" || ctx.mode === "json";
		await kickOff(content, customType);
		if (!oneShot) return;
		try {
			await ctx.waitForIdle();
		} catch {
			// ignore: the run may have already finished or been aborted
		}
	}

	function helpText(): string {
		return [
			"Usage:",
			"  /goal <objective>        set (or replace) the goal and start immediately",
			"  /goal                    show the current goal",
			"  /goal pause              pause",
			"  /goal resume             resume and continue",
			"  /goal edit               edit the objective",
			"  /goal budget <tokens>    set a token budget (0 clears it)",
			"  /goal clear              remove the goal",
			"",
			"The goal persists across turns until it is completed, blocked, cleared, or out of budget.",
		].join("\n");
	}

	function describe(): string {
		if (!state) return "No goal set. Use /goal <objective> to create one.";
		const lines = [
			`Status: ${state.status}`,
			`Objective: ${state.objective}`,
			`Turns: ${state.turns}`,
			`Tokens: ${state.tokensUsed}${state.tokenBudget === undefined ? "" : ` / ${state.tokenBudget}`}`,
			`Cost: US$${state.costUsed.toFixed(4)}`,
			`Elapsed: ${state.timeUsedSeconds}s`,
		];
		if (state.lastReason) lines.push(`Last turn: ${state.lastReason}`);
		if (state.haltReason) lines.push(`Note: ${state.haltReason}`);
		return lines.join("\n");
	}

	// -----------------------------------------------------------------------
	// Commands
	// -----------------------------------------------------------------------

	pi.registerCommand("goal", {
		description: "Set, inspect, pause, resume or clear a persistent goal",
		getArgumentCompletions: (prefix: string) => {
			const items = ["pause", "resume", "edit", "clear", "budget", "help"].map((value) => ({
				value,
				label: value,
			}));
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			const [head, ...rest] = raw.split(/\s+/);
			const tail = rest.join(" ").trim();

			if (!raw) {
				notify(ctx, describe(), "info");
				return;
			}

			switch (head) {
				case "help":
					notify(ctx, helpText(), "info");
					return;
				case "pause": {
					if (!state) {
						notify(ctx, "No goal set.", "info");
						return;
					}
					setStatus(ctx, "paused", "paused by user");
					notify(ctx, `Goal paused: ${state.objective}`, "info");
					return;
				}
				case "resume":
					await resumeGoal(ctx);
					return;
				case "clear":
					clearGoal(ctx, "cleared by user");
					return;
				case "edit": {
					if (!state) {
						notify(ctx, "No goal set. Use /goal <objective>.", "info");
						return;
					}
					if (!ctx.hasUI || ctx.mode !== "tui") {
						notify(ctx, "Editing requires an interactive session. Use /goal <objective> to replace it.", "warning");
						return;
					}
					const next = await ctx.ui.editor("Edit goal objective:", state.objective);
					if (!next || !next.trim() || next.trim() === state.objective) return;
					state.objective = next.trim();
					persist(ctx);
					notify(ctx, `Goal updated: ${state.objective}`, "info");
					if (state.status === "active") {
						await kickFromCommand(ctx, objectiveUpdatedPrompt(snapshotOf(state)), "goal-updated");
					}
					return;
				}
				case "budget": {
					const parsed = Number.parseInt(tail, 10);
					if (!tail || !Number.isFinite(parsed) || parsed < 0) {
						notify(ctx, "Usage: /goal budget <tokens> (0 clears the budget)", "warning");
						return;
					}
					if (!state) {
						notify(ctx, "No goal set. Use /goal <objective>.", "info");
						return;
					}
					state.tokenBudget = parsed === 0 ? undefined : parsed;
					budgetWrapupSent = false;
					persist(ctx);
					notify(ctx, parsed === 0 ? "Token budget cleared." : `Token budget set to ${parsed}.`, "info");
					return;
				}
				default:
					break;
			}

			// Anything else is an objective.
			const budgetMatch = raw.match(/\s+--budget(=|\s+)(\d+)\s*$/);
			let objective = raw;
			let budget: number | undefined;
			if (budgetMatch) {
				budget = Number.parseInt(budgetMatch[2] ?? "", 10);
				objective = raw.slice(0, budgetMatch.index).trim();
			}
			if (!objective) {
				notify(ctx, helpText(), "info");
				return;
			}
			if (objective.length > 4000) {
				notify(ctx, `Goal objective must be at most 4000 characters (got ${objective.length}).`, "warning");
				return;
			}
			startGoal(ctx, objective, budget);
			if (state) await kickFromCommand(ctx, continuationPrompt(snapshotOf(state)), "goal-continuation");
		},
	});

	// -----------------------------------------------------------------------
	// Model-facing tools
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description:
			"Get the current goal for this session: objective, status, token budget, token and elapsed-time usage, and the remaining token budget.",
		promptSnippet: "Read the current session goal state",
		parameters: Type.Object({}),
		async execute() {
			if (!state) {
				return { content: [{ type: "text" as const, text: "No goal is set for this session." }] };
			}
			const payload = {
				goal: {
					goalId: state.goalId,
					objective: state.objective,
					status: state.status,
					turns: state.turns,
					tokensUsed: state.tokensUsed,
					tokenBudget: state.tokenBudget ?? null,
					remainingTokens:
						state.tokenBudget === undefined ? null : Math.max(0, state.tokenBudget - state.tokensUsed),
					costUsedUsd: Number(state.costUsed.toFixed(4)),
					timeUsedSeconds: state.timeUsedSeconds,
					lastReason: state.lastReason ?? null,
					haltReason: state.haltReason ?? null,
				},
			};
			return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
		},
	});

	pi.registerTool({
		name: "create_goal",
		label: "Create Goal",
		description:
			"Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; use update_goal only for status.",
		parameters: Type.Object({
			objective: Type.String({
				description:
					"Required. The concrete objective to start pursuing, written so a separate check could verify it.",
			}),
			token_budget: Type.Optional(
				Type.Integer({ description: "Positive token budget for the new goal. Omit unless explicitly requested." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (state && UNFINISHED.includes(state.status)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Cannot create a new goal: this session already has an unfinished goal (status: ${state.status}). Complete or clear it first.`,
						},
					],
					isError: true,
				};
			}
			if (!params.objective || !params.objective.trim()) {
				return { content: [{ type: "text" as const, text: "objective must not be empty" }], isError: true };
			}
			if (params.objective.length > 4000) {
				return {
					content: [{ type: "text" as const, text: "goal objective must be at most 4000 characters" }],
					isError: true,
				};
			}
			if (params.token_budget !== undefined && (!Number.isFinite(params.token_budget) || params.token_budget <= 0)) {
				return {
					content: [{ type: "text" as const, text: "goal budgets must be positive when provided" }],
					isError: true,
				};
			}
			startGoal(ctx, params.objective.trim(), params.token_budget);
			return {
				content: [
					{
						type: "text" as const,
						text: `Goal created and active: ${state?.objective ?? params.objective}`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description:
			'Update the existing goal. Set status to "paused" only at the user\'s explicit request, never on your own initiative. Set status to "complete" only when the objective has actually been achieved and no required work remains. Set status to "blocked" only after the same blocking condition has repeated for at least three consecutive goal turns and you are at an impasse. Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work. You cannot resume, budget-limit, or usage-limit a goal with this tool; those states are controlled by the user or system.',
		parameters: Type.Object({
			status: StringEnum(["complete", "blocked", "paused"] as const, {
				description: "New status for the existing goal.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state) {
				return { content: [{ type: "text" as const, text: "No goal exists for this session." }], isError: true };
			}
			const status = params.status;
			if (status === "complete") {
				const usage = {
					turns: state.turns,
					tokensUsed: state.tokensUsed,
					tokenBudget: state.tokenBudget ?? null,
					costUsedUsd: Number(state.costUsed.toFixed(4)),
					timeUsedSeconds: state.timeUsedSeconds,
				};
				setStatus(ctx, "complete");
				notify(ctx, `Goal achieved: ${state.objective}`, "info");
				return {
					content: [
						{
							type: "text" as const,
							text: `Goal marked complete. Report the final usage to the user.\n${JSON.stringify(usage, null, 2)}`,
						},
					],
					details: usage,
				};
			}
			if (status === "blocked") {
				setStatus(ctx, "blocked", "blocked by model after repeated blocker");
				notify(ctx, `Goal blocked: ${state.objective}`, "warning");
				return {
					content: [
						{ type: "text" as const, text: "Goal marked blocked. The user can resume it with /goal resume." },
					],
				};
			}
			setStatus(ctx, "paused", "paused at user request");
			notify(ctx, `Goal paused: ${state.objective}`, "info");
			return { content: [{ type: "text" as const, text: "Goal paused." }] };
		},
	});

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		state = loadState(sessionIdOf(ctx));
		budgetWrapupSent = false;
		pendingContinuation = false;
		refreshStatus(ctx);
		if (state && state.status === "active") {
			notify(
				ctx,
				`Goal restored (${state.status}): ${state.objective}\nSend a message or run /goal resume to continue.`,
			);
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!state || state.status !== "active") return undefined;
		if (pendingContinuation) return undefined; // the continuation message already carries the goal
		// A user-initiated turn: clear the no-progress guard so the goal may continue afterwards.
		if (state.noToolTurns > 0 || state.haltReason) {
			state.noToolTurns = 0;
			state.haltReason = undefined;
			persist(ctx);
		}
		return {
			message: {
				customType: "goal-context",
				content: activeGoalNote(snapshotOf(state)),
				display: false,
			},
		};
	});

	pi.on("agent_start", async () => {
		runStartedAt = Date.now();
		lastRunHadTools = false;
		runStartedWithActiveGoal = state?.status === "active";
		if (pendingContinuation) pendingContinuation = false;
	});

	pi.on("agent_end", async (event, ctx) => {
		lastStopReason = undefined;
		if (!state) return;

		const stats = collectRunStats(event.messages as readonly unknown[], runStartedAt);
		runStartedAt = 0;
		lastStopReason = stats.stopReason;
		lastRunHadTools = stats.usedTools;

		// Account usage only for runs that started while the goal was active, so a
		// finished goal does not keep absorbing the cost of later conversation.
		if (runStartedWithActiveGoal) {
			state.tokensUsed += stats.tokens;
			state.costUsed += stats.cost;
			state.timeUsedSeconds += stats.seconds;
			state.turns += 1;
			state.lastReason = clipReason(stats.lastText) ?? state.lastReason;
			state.noToolTurns = stats.usedTools ? 0 : state.noToolTurns + 1;
			persist(ctx);
		}

		if (state.status !== "active") return;

		// Aborted or failed runs are settled on agent_settled; do not queue another turn.
		if (stats.stopReason === "aborted" || stats.stopReason === "error") return;

		// Budget exhausted: one wrap-up turn, then stop.
		if (state.tokenBudget !== undefined && state.tokensUsed >= state.tokenBudget) {
			state.status = "budget_limited";
			state.haltReason = "token budget exhausted";
			persist(ctx);
			if (!budgetWrapupSent) {
				budgetWrapupSent = true;
				try {
					pi.sendMessage(
						{ customType: "goal-budget", content: budgetLimitPrompt(snapshotOf(state)), display: false },
						{ deliverAs: "followUp", triggerTurn: true },
					);
				} catch {
					// ignore
				}
			}
			return;
		}

		// No-progress guard: stop automatic continuation and hand control back.
		if (state.noToolTurns >= NO_TOOL_LIMIT) {
			state.haltReason = `paused automatically after ${NO_TOOL_LIMIT} turns without tool use`;
			state.noToolTurns = 0;
			persist(ctx);
			notify(
				ctx,
				`Goal waiting for input: ${state.haltReason}. Send a message or /goal resume to continue.`,
				"warning",
			);
			return;
		}

		try {
			pi.sendMessage(
				{ customType: "goal-continuation", content: continuationPrompt(snapshotOf(state)), display: false },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			// If the follow-up could not be queued, leave the goal active for the next user turn.
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!state || state.status !== "active") return;
		if (lastStopReason === "aborted") {
			setStatus(ctx, "paused", "paused automatically after the turn was interrupted");
			notify(ctx, "Goal paused: the turn was interrupted. Use /goal resume to continue.", "info");
			return;
		}
		if (lastStopReason === "error") {
			setStatus(ctx, "blocked", "turn failed with an error");
			notify(ctx, "Goal blocked: the last turn failed. Fix the cause, then /goal resume.", "warning");
			return;
		}
		refreshStatus(ctx);
	});

	// Keep only the newest goal message of each kind in model context, so long
	// goals do not accumulate a copy of the continuation template on every turn.
	pi.on("context", async (event) => {
		const messages = event.messages as readonly { role?: string; customType?: string }[];
		let lastContinuation = -1;
		let lastContext = -1;
		let lastBudget = -1;
		let lastUpdated = -1;
		messages.forEach((m, i) => {
			if (m?.role !== "custom") return;
			if (m.customType === "goal-continuation") lastContinuation = i;
			else if (m.customType === "goal-context") lastContext = i;
			else if (m.customType === "goal-budget") lastBudget = i;
			else if (m.customType === "goal-updated") lastUpdated = i;
		});
		if (lastContinuation < 0 && lastContext < 0 && lastBudget < 0 && lastUpdated < 0) return undefined;
		const kept = messages.filter((m, i) => {
			if (m?.role !== "custom") return true;
			switch (m.customType) {
				case "goal-continuation":
					return i === lastContinuation;
				case "goal-context":
					return i === lastContext;
				case "goal-budget":
					return i === lastBudget;
				case "goal-updated":
					return i === lastUpdated;
				default:
					return true;
			}
		});
		return { messages: kept };
	});

	pi.on("session_shutdown", async () => {
		if (state) saveState(state);
	});
}
