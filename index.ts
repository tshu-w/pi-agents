import {
	AgentSession,
	AgentSessionRuntime,
	getAgentDir,
	parseSessionEntries,
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import {
	Agents,
	customMessage,
	deliver,
	label,
	listLine,
	messageText,
	nodes,
	receivedMessageIds,
	resolveIn,
	restoredUsage,
	searchEntries,
	setTreeUsage,
	treeEntries,
	treeIdle,
	treeMetadata,
	treeUsage,
	usageEntry,
	type AgentNode,
	type Entry,
	type Limits,
	type Usage,
	type WaitOutcome,
	type WaitResult,
} from "./agents.ts";
import { loadPiCodemode } from "./codemode.ts";
import { boundBlocks, boundText } from "./output.ts";
import { executeProgram, PROGRAM_TOOL_NAME } from "./program-execute.ts";
import { programListLine, Programs, renderProgramWait } from "./programs.ts";
import { installGuard } from "./roots/guard.mjs";
import ownershipExtension from "./roots/ownership-extension.mjs";
import { rootPaths } from "./roots/paths.mjs";
import { createRootRuntime } from "./roots/runtime.ts";
import { waitForBackground } from "./roots/wait-ui.ts";

const DEFAULT_LIMITS: Limits = { maxConcurrent: 3, maxOutstanding: 8 };
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

interface Settings extends Limits {
	extensions: string[];
}

/** Reads the "pi-agents" section of the global settings.json. */
export function readSettings(agentDir: string): Settings {
	let section: Record<string, unknown> = {};
	try {
		const document = JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		const value = document["pi-agents"];
		if (value && typeof value === "object") section = value as Record<string, unknown>;
	} catch { /* missing settings use the defaults */ }
	const settings: Settings = { ...DEFAULT_LIMITS, extensions: [] };
	const { maxConcurrent = DEFAULT_LIMITS.maxConcurrent, maxOutstanding = DEFAULT_LIMITS.maxOutstanding, extensions = [] } = section;
	const positive = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;
	if (positive(maxConcurrent) && positive(maxOutstanding) && maxConcurrent <= maxOutstanding) {
		settings.maxConcurrent = maxConcurrent;
		settings.maxOutstanding = maxOutstanding;
	} else {
		console.warn(`[pi-agents] invalid maxConcurrent/maxOutstanding ${JSON.stringify({ maxConcurrent, maxOutstanding })}; using ${DEFAULT_LIMITS.maxConcurrent}/${DEFAULT_LIMITS.maxOutstanding}`);
	}
	if (Array.isArray(extensions) && extensions.every((entry) => typeof entry === "string")) {
		settings.extensions = [...new Set(extensions.map((entry) => path.resolve(agentDir, entry)))];
	} else {
		console.warn("[pi-agents] invalid extensions; expected an array of paths");
	}
	return settings;
}

function resultBlock({ agent, input, history }: WaitResult): string {
	return `<agent-result name="${agent.name}" id="${agent.id}" status="${input.state}"${history ? ' history="true"' : ""}>\n${input.result ?? ""}\n</agent-result>`;
}

/** Renders wait results; returns the text and the results the caller has now read. */
export function renderWait(outcome: WaitOutcome): { text: string; read: WaitResult[]; details: Record<string, unknown> } {
	const { results, pending } = outcome;
	const pendingLine = pending.length > 0 ? `Still pending: ${pending.map(label).join(", ")}` : "";
	if (results.length === 0) return { text: pendingLine || "No results.", read: [], details: { pending: pending.map((agent) => agent.id) } };
	const only = results[0]!;
	if (results.length === 1 && pending.length === 0 && !only.history && only.input.state === "completed") {
		const bounded = boundText(only.input.result ?? "", "pi-agents-wait");
		return { text: bounded.text, read: results, details: { ...bounded.details } };
	}
	const bounded = boundBlocks(results.map(resultBlock), "agent-result", "pi-agents-wait");
	let text = bounded.text;
	const read = results.slice(0, bounded.shown);
	const omitted = results.slice(bounded.shown);
	if (omitted.length > 0) text += `\n\n[Results omitted: ${omitted.map((result) => label(result.agent)).join(", ")}. Use wait with fewer targets.]`;
	if (pendingLine) text += `\n\n${pendingLine}`;
	return { text, read, details: { pending: pending.map((agent) => agent.id), ...bounded.details } };
}

function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1000000) return `${Math.round(value / 1000)}k`;
	return `${(value / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: Usage): string {
	return `${usage.turns} turns ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} R${formatTokens(usage.cacheRead)} W${formatTokens(usage.cacheWrite)} $${usage.cost.toFixed(4)}`;
}

function rejectFields(params: Record<string, unknown>, action: string, fields: string[]): void {
	const present = fields.filter((field) => params[field] !== undefined);
	if (present.length > 0) throw new Error(`${action} does not accept: ${present.join(", ")}`);
}

const PROGRAM_DESCRIPTION = `Run JavaScript that composes tool calls and Agents; only its output and return value reach the caller. \`run\` runs a Program in the foreground, or in the background with \`background\`; \`wait\` waits for background Programs and returns their results; \`list\` lists background Programs; \`stop\` stops a running Program. When a background Program ends while its caller is not waiting for it, the caller receives a notification; \`wait\` returns the result.

Program code is the body of an async function. It calls the caller's tools through \`tools.*\`, which excludes \`program\`.`;

export default async function (pi: ExtensionAPI): Promise<void> {
	const agentDir = getAgentDir();
	const settings = readSettings(agentDir);
	const piCodemode = await loadPiCodemode();
	let node: AgentNode | undefined;
	let programs: Programs | undefined;
	let ctx: ExtensionContext | undefined;

	installGuard({ SessionManager, AgentSession, AgentSessionRuntime, parseSessionEntries, stateDir: rootPaths().ownership });
	const roots = createRootRuntime(pi, {
		receive: (message) => {
			const delivery = message.deliverAs ?? "followUp";
			node?.receive(messageText(message.sender, false, delivery, message.body), delivery, message.id);
		},
		treeIdle: () => node === undefined || treeIdle(node.rootId),
		receivedIds: receivedMessageIds,
	});
	ownershipExtension(pi, { start: (current: ExtensionContext) => roots.start(current), stop: () => roots.stop(), waitForBackground });

	/** Agents visible to a node: its tree, and for a root Agent also the other root Agents. */
	const visible = async (self: AgentNode, signal?: AbortSignal): Promise<Entry[]> => {
		const tree = treeEntries(self.rootId);
		if (self.ownerId !== undefined) return tree;
		const others = (await roots.roots(signal))
			.filter((root) => !tree.some((entry) => entry.id === root.id))
			.map((root) => ({ ...root, remote: !nodes.has(root.id) }));
		return [...tree, ...others];
	};

	const requireNode = (current: ExtensionContext): AgentNode => {
		if (!node) throw new Error("pi-agents is not initialized");
		ctx = current;
		node.agents.setContext(current);
		return node;
	};

	pi.on("session_start", (_event, current) => {
		ctx = current;
		const id = current.sessionManager.getSessionId();
		const metadata = treeMetadata(current);
		const rootId = metadata?.rootId ?? id;
		const self = { id, rootId, ownerId: metadata?.ownerId, name: () => pi.getSessionName() };
		const agents = new Agents(pi, self, agentDir, settings, settings.extensions);
		agents.setContext(current);
		agents.restore(current);
		node = {
			...self,
			agents,
			cwd: () => ctx?.cwd ?? current.cwd,
			busy: () => !(ctx?.isIdle() ?? true),
			sessionFile: () => ctx?.sessionManager.getSessionFile(),
			receive: (text, delivery, messageId) => {
				pi.sendMessage(customMessage(text, delivery, messageId), delivery === "write"
					? { deliverAs: "steer" }
					: { deliverAs: delivery, triggerTurn: true });
			},
			persistUsage: (usage) => {
				if (!metadata) pi.appendEntry(...usageEntry(usage));
			},
		};
		nodes.set(id, node);
		if (!metadata) setTreeUsage(id, restoredUsage(current));
		programs = new Programs({
			appendEntry: (customType, data) => pi.appendEntry(customType, data),
			notify: (text) => agents.notify(text),
		});
		programs.restore(current);
	});

	pi.on("session_shutdown", async () => {
		const closing = node;
		if (!closing) return;
		node = undefined;
		const stopping = programs;
		programs = undefined;
		try {
			await stopping?.shutdown();
			await closing.agents.shutdown();
		} finally {
			if (nodes.get(closing.id) === closing) nodes.delete(closing.id);
			if (closing.ownerId === undefined) setTreeUsage(closing.id, undefined);
		}
	});

	const { maxConcurrent, maxOutstanding } = settings;
	const slotsBusy = `all ${maxConcurrent} slots are busy`;

	pi.registerTool({
		name: "agent",
		label: "Agent",
		description: `Create, message, and coordinate Agents. \`spawn\` creates an owned Agent and sends its first input; \`send\` sends an input or a write to a visible Agent; \`wait\` waits for owned Agents and returns unread results; \`list\` finds visible Agents; \`abort\` stops an owned Agent's current turn and queued inputs while keeping it available. When an owned Agent finishes an input while its owner is not waiting for it, the owner receives a notification naming the Agent and outcome; \`wait\` returns the result. Owned Agents under the same root share \`${maxConcurrent}\` execution slots and a limit of \`${maxOutstanding}\` inputs that have not ended. Inputs that start a new turn queue when all slots are busy; new inputs are rejected at the input limit.`,
		promptSnippet: "Create, message, and coordinate Agents",
		promptGuidelines: [
			"Use `agent(action='spawn', name=..., message=...)` for concrete, bounded work with a clear expected result. Keep the first message self-contained; use `context='fork'` only when the Agent needs the caller's conversation.",
			"For independent work, start the Agents before waiting and partition tasks into non-overlapping responsibilities.",
			"Use `agent(action='wait', ...)` when the next step depends on Agent results. Prefer one longer wait over repeated short polling.",
		],
		parameters: Type.Object({
			action: StringEnum(["spawn", "send", "wait", "list", "abort"] as const, { description: "Operation and applicable parameters: `spawn(name, message, cwd?, context?, model?, thinkingLevel?)`, `send(target, message, deliverAs?)`, `wait(target?, history?, timeout?)`, `list(query?, state?, limit?, offset?)`, or `abort(target)`." }),
			name: Type.Optional(Type.String({ description: "Name of the new Agent for `spawn`; unique among the caller's Agents." })),
			message: Type.Optional(Type.String({ description: "Non-empty text for `spawn` or `send`." })),
			cwd: Type.Optional(Type.String({ description: "Working directory for `spawn` (default: the caller's current working directory)." })),
			context: Type.Optional(StringEnum(["fresh", "fork"] as const, { description: "Context for `spawn` (default: fresh). fresh starts without the caller's conversation; fork snapshots it." })),
			model: Type.Optional(Type.String({ description: "Model for `spawn` as provider/modelId (default: the caller's model)." })),
			thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Thinking level for `spawn`: off, minimal, low, medium, high, or xhigh (default: the caller's level)." })),
			target: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Agent ID or name for `send`, `wait`, or `abort`. `wait` and `send` with `deliverAs='write'` also accept an array. When omitted for `wait`, selects all owned Agents with pending or unread results." })),
			deliverAs: Type.Optional(StringEnum(["followUp", "steer", "write"] as const, { description: "Delivery for `send` (default: followUp). followUp waits until the recipient's current turn ends; steer delivers after its current tool calls, before the next model call; write delivers like steer but never starts a turn and has no result." })),
			history: Type.Optional(Type.Integer({ minimum: 0, description: "Number of most recent read results to return again per selected Agent for `wait` (default: 0)." })),
			timeout: Type.Optional(Type.Number({ minimum: 10, maximum: 3600, description: "Maximum seconds for `wait` (default: 30, min: 10, max: 3600). Timeout does not abort Agents." })),
			query: Type.Optional(Type.String({ description: "Search query for `list`, matching ID, name, cwd, summaries, and user messages. Case-insensitive; spaces mean AND; `|` means OR." })),
			state: Type.Optional(StringEnum(["busy", "idle", "offline"] as const, { description: "State for `list`: busy, idle, or offline." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Maximum Agents returned by `list` (default: 20, max: 200)." })),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Number of Agents to skip for `list` (default: 0)." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, current) {
			const self = requireNode(current);
			const agents = self.agents;
			const caller = { id: self.id, name: self.name() };
			const targets = params.target === undefined ? undefined : Array.isArray(params.target) ? params.target : [params.target];
			switch (params.action) {
				case "spawn": {
					rejectFields(params, "spawn", ["target", "deliverAs", "history", "timeout", "query", "state", "limit", "offset"]);
					if (!params.name?.trim() || !params.message?.trim()) throw new Error("spawn requires name and message");
					const { record, queued } = agents.spawn({
						name: params.name,
						message: params.message,
						cwd: params.cwd,
						context: params.context,
						model: params.model,
						thinkingLevel: params.thinkingLevel,
					});
					return {
						content: [{ type: "text", text: `Agent ${label(record)} ${queued ? `queued: ${slotsBusy}` : "started"}.` }],
						details: { id: record.id, name: record.name, queued },
					};
				}
				case "send": {
					rejectFields(params, "send", ["name", "cwd", "context", "model", "thinkingLevel", "history", "timeout", "query", "state", "limit", "offset"]);
					const delivery = params.deliverAs ?? "followUp";
					if (!targets?.length || !params.message?.trim()) throw new Error("send requires target and message");
					if (targets.length > 1 && delivery !== "write") throw new Error("Only a write can go to several Agents.");
					const tree = treeEntries(self.rootId);
					const candidates = targets.every((target) => tree.some((entry) => entry.id === target)) ? tree : await visible(self, signal);
					const entries = targets.map((target) => resolveIn(candidates, target));
					if (entries.some((entry) => entry.id === self.id)) throw new Error("An Agent cannot send to itself.");
					const body = params.message;
					const send = async (entry: Entry) => {
						if (!entry.remote) return deliver(caller, entry, delivery, body);
						await roots.send({ id: entry.id, label: label(entry) }, delivery, body, signal);
						return { queued: false };
					};
					if (delivery === "write") {
						for (const entry of entries) await send(entry);
						return {
							content: [{ type: "text", text: `Write accepted by ${entries.map(label).join(", ")}.` }],
							details: { ids: entries.map((entry) => entry.id) },
						};
					}
					const entry = entries[0]!;
					const { queued } = await send(entry);
					return {
						content: [{ type: "text", text: `Input accepted by ${label(entry)}${queued ? `, queued: ${slotsBusy}` : ""}.` }],
						details: { id: entry.id, queued },
					};
				}
				case "wait": {
					rejectFields(params, "wait", ["name", "message", "cwd", "context", "model", "thinkingLevel", "deliverAs", "query", "state", "limit", "offset"]);
					const selected = targets?.map((target) => agents.ownedTarget(target));
					const outcome = await agents.wait(selected, params.history ?? 0, params.timeout ?? 30, signal);
					const rendered = renderWait(outcome);
					agents.markRead(rendered.read);
					return { content: [{ type: "text", text: rendered.text }], details: rendered.details };
				}
				case "list": {
					rejectFields(params, "list", ["name", "message", "cwd", "context", "model", "thinkingLevel", "target", "deliverAs", "history", "timeout"]);
					const offset = params.offset ?? 0;
					const limit = params.limit ?? 20;
					const entries = (await visible(self, signal)).filter((entry) => entry.id !== self.id && (!params.state || entry.state === params.state));
					const items = searchEntries(entries, params.query);
					const page = items.slice(offset, offset + limit);
					if (page.length === 0) return { content: [{ type: "text", text: "No matching Agents." }], details: { total: items.length } };
					const lines = page.map(listLine);
					const remaining = items.length - offset - page.length;
					if (remaining > 0) lines.push(`[${remaining} more results. Use offset=${offset + page.length} to continue.]`);
					const text = boundText(lines.join("\n"), "pi-agents-list");
					return { content: [{ type: "text", text: text.text }], details: { total: items.length, ...text.details } };
				}
				case "abort": {
					rejectFields(params, "abort", ["name", "message", "cwd", "context", "model", "thinkingLevel", "deliverAs", "history", "timeout", "query", "state", "limit", "offset"]);
					if (targets?.length !== 1) throw new Error("abort requires one target");
					const agent = agents.ownedTarget(targets[0]!);
					const aborted = await agents.abort(agent);
					return {
						content: [{ type: "text", text: `Agent ${label(agent.record)} ${aborted ? "aborted" : "has no turn or queued inputs"}.` }],
						details: { id: agent.record.id, aborted },
					};
				}
			}
		},
	});

	const programOptions = {
		appendEntry: (customType: string, data: unknown) => pi.appendEntry(customType, data),
		getToolNamespace: (name: string) => pi.getAllTools().find((tool) => tool.name === name)?.namespace,
	};

	pi.registerTool({
		name: PROGRAM_TOOL_NAME,
		label: "Program",
		description: `${PROGRAM_DESCRIPTION}\n\n${piCodemode.createCodemodeDescription([], { models: true })}`,
		promptSnippet: "Run JavaScript that composes tool calls and Agents",
		promptGuidelines: [
			"Use `program(action='run', code=...)` to call tools or Agents several times without a model turn between the calls, for example to read many files, filter large tool output, fan out Agents, or loop until a condition holds.",
			"Use `Promise.allSettled` for independent calls. Return only what the caller needs; use `text()` for progress worth reading.",
			"Use `background=true` for long Programs, and `program(action='wait', ...)` when the next step depends on their results.",
		],
		parameters: Type.Object({
			action: StringEnum(["run", "wait", "list", "stop"] as const, { description: "Operation and applicable parameters: `run(code, background?, timeout?)`, `wait(target?, timeout?)`, `list(limit?, offset?)`, or `stop(target)`." }),
			code: Type.Optional(Type.String({ description: "JavaScript async-function body for `run`." })),
			background: Type.Optional(Type.Boolean({ description: "Whether `run` returns the Program ID at once (default: false)." })),
			timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Maximum seconds. For `run` (default: none), expiry stops the Program. For `wait` (default: 30, min: 10, max: 3600), expiry does not stop Programs." })),
			target: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Program ID for `wait` or `stop`. `wait` also accepts an array. When omitted for `wait`, selects running Programs and ended Programs whose result has not been returned." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Maximum Programs returned by `list` (default: 20, max: 200)." })),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Number of Programs to skip for `list` (default: 0)." })),
		}),
		async execute(toolCallId, params, signal, onUpdate, current) {
			const self = requireNode(current);
			if (!programs) throw new Error("pi-agents is not initialized");
			const targets = params.target === undefined ? undefined : Array.isArray(params.target) ? params.target : [params.target];
			switch (params.action) {
				case "run": {
					rejectFields(params, "run", ["target", "limit", "offset"]);
					if (!params.code?.trim()) throw new Error("run requires code");
					const code = params.code;
					if (params.background) {
						const record = programs.start(toolCallId, code, current, { ...programOptions, timeout: params.timeout });
						return { content: [{ type: "text", text: `Program ${record.id} started.` }], details: { id: record.id } };
					}
					const { result } = await self.agents.whileSuspended(() => executeProgram(toolCallId, code, signal ?? new AbortController().signal, current, {
						...programOptions,
						timeout: params.timeout,
						onUpdate: (details) => onUpdate?.({ content: [], details }),
					}), signal);
					return result;
				}
				case "wait": {
					rejectFields(params, "wait", ["code", "background", "limit", "offset"]);
					const timeout = params.timeout ?? 30;
					if (timeout < 10 || timeout > 3600) throw new Error("wait timeout must be between 10 and 3600 seconds");
					const selected = programs.select(targets);
					const waitFor = () => programs!.wait(selected, timeout, signal);
					const outcome = programs.running(selected) ? await self.agents.whileSuspended(waitFor, signal) : await waitFor();
					const rendered = renderProgramWait(outcome);
					programs.markReturned(rendered.returned);
					return { content: rendered.content, details: { running: outcome.running.map((record) => record.id) } };
				}
				case "list": {
					rejectFields(params, "list", ["code", "background", "timeout", "target"]);
					const offset = params.offset ?? 0;
					const limit = params.limit ?? 20;
					const records = programs.list();
					if (records.length === 0) return { content: [{ type: "text", text: "No Programs." }], details: { total: 0 } };
					const page = records.slice(offset, offset + limit);
					const lines = page.map(programListLine);
					const remaining = records.length - offset - page.length;
					if (remaining > 0) lines.push(`[${remaining} more results. Use offset=${offset + page.length} to continue.]`);
					return { content: [{ type: "text", text: lines.join("\n") }], details: { total: records.length } };
				}
				case "stop": {
					rejectFields(params, "stop", ["code", "background", "timeout", "limit", "offset"]);
					if (targets?.length !== 1) throw new Error("stop requires one target");
					const program = programs.target(targets[0]!);
					const stopped = await programs.stop(program);
					return {
						content: [{ type: "text", text: `Program ${program.record.id} ${stopped ? "stopped" : "has already ended"}.` }],
						details: { id: program.record.id, stopped },
					};
				}
			}
		},
	});

	pi.registerCommand("tasks", {
		description: "Show a summary of this Agent's owned Agents",
		handler: async (_args, current) => {
			const self = node;
			const { busy, queued, unread } = self?.agents.summary() ?? { busy: 0, queued: 0, unread: 0 };
			const counts = ([[busy, "busy"], [queued, "queued inputs"], [unread, "unread results"]] as const)
				.filter(([count]) => count > 0)
				.map(([count, text]) => `${count} ${text}`)
				.join(" · ") || "0";
			const { running, unreturned } = programs?.summary() ?? { running: 0, unreturned: 0 };
			const programCounts = ([[running, "running"], [unreturned, "unreturned results"]] as const)
				.filter(([count]) => count > 0)
				.map(([count, text]) => `${count} ${text}`)
				.join(" · ");
			const lines = [`Agents: ${counts}`, ...(programCounts ? [`Programs: ${programCounts}`] : []), `Usage: ${formatUsage(treeUsage(self?.rootId ?? ""))}`];
			current.ui.notify(lines.join("\n"), "info");
		},
	});
}
