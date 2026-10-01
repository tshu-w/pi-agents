import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { boundBlocks, boundText } from "../output.ts";
import { rejectFields } from "../params.ts";
import { renderTextResult, renderToolCall, startDuration, type DurationState } from "../render-call.ts";
import type { RootRuntime } from "../roots/runtime.ts";
import {
	deliver,
	label,
	listLine,
	nodes,
	resolveIn,
	searchEntries,
	THINKING_LEVELS,
	treeEntries,
	type AgentNode,
	type Entry,
	type Limits,
	type WaitOutcome,
	type WaitResult,
} from "./agents.ts";

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

/** Registers the `agent` tool. */
export function registerAgentTool(
	pi: ExtensionAPI,
	{ limits, roots, requireNode }: { limits: Limits; roots: RootRuntime; requireNode: (current: ExtensionContext) => AgentNode },
): void {
	/** Agents visible to a node: its tree, and for a root Agent also the other root Agents. */
	const visible = async (self: AgentNode, signal?: AbortSignal): Promise<Entry[]> => {
		const tree = treeEntries(self.scopeId);
		if (self.ownerId !== undefined) return tree;
		const others = (await roots.roots(signal))
			.filter((root) => !tree.some((entry) => entry.id === root.id))
			.map((root) => ({ ...root, remote: !nodes.has(root.id) }));
		return [...tree, ...others];
	};

	const { maxConcurrent, maxOutstanding } = limits;
	const slotsBusy = `all ${maxConcurrent} slots are busy`;

	pi.registerTool({
		name: "agent",
		label: "Agent",
		renderCall: (args, theme, context) => {
			startDuration(context.state as DurationState, args.action === "wait", context.executionStarted);
			return renderToolCall("agent", args, theme, context.lastComponent);
		},
		// `wait` shows how long it has waited.
		renderResult: (result, options, theme, context) => renderTextResult(result, options, theme, context, () => keyHint("app.tools.expand", "to expand")),
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
		async execute(_toolCallId, params, signal, onUpdate, current) {
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
					const tree = treeEntries(self.scopeId);
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
					// An empty partial result lets the row show the elapsed time.
					onUpdate?.({ content: [], details: undefined });
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
}
