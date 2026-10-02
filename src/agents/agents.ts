import {
	createAgentSession,
	DefaultResourceLoader,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionError,
} from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TreeScheduler } from "./scheduler.ts";

export const MESSAGE_TYPE = "pi-agents";
const AGENT_ENTRY = "pi-agents-agent";
const TREE_ENTRY = "pi-agents-tree";
const USAGE_ENTRY = "pi-agents-usage";
const SHUTDOWN_TIMEOUT_MS = 10_000;
const EXTENSION_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));
export const SUBMIT_RESULT_TOOL_NAME = "submit_result";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type Outcome = "completed" | "failed" | "aborted";
export type AgentState = "busy" | "idle" | "offline";
export type Delivery = "followUp" | "steer" | "write";
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type Model = NonNullable<ExtensionContext["model"]>;
type QueuedMessage = Parameters<AgentSession["agent"]["steer"]>[0];
type CreateOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;

export interface Limits {
	maxConcurrent: number;
	maxOutstanding: number;
}

export interface InputRecord {
	id: string;
	state: "queued" | "running" | Outcome;
	result?: string;
	/** The value submitted with `submit_result`, for an input with a schema. */
	value?: unknown;
	read: boolean;
	notified: boolean;
}

export interface AgentRecord {
	id: string;
	name: string;
	sessionFile: string;
	cwd: string;
	createdAt: string;
	inputs: InputRecord[];
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

/** An Agent loaded in this process: a root Session or an owned child Session. */
export interface AgentNode {
	id: string;
	rootId: string;
	/** The node whose tree this node sees: its root, or the Program its Agents belong to. */
	scopeId: string;
	ownerId?: string;
	/** A Program that owns Agents; it is not an Agent and no Agent sees it. */
	program?: boolean;
	name(): string | undefined;
	cwd(): string;
	busy(): boolean;
	sessionFile(): string | undefined;
	agents: Agents;
	/** Delivers a message to this node; used only for root Agents. */
	receive(text: string, delivery: Delivery, messageId?: string): void;
	persistUsage(usage: Usage): void;
}

export interface Entry {
	id: string;
	name?: string;
	ownerId?: string;
	cwd: string;
	state: AgentState;
	sessionFile?: string;
	/** When an owned Agent was spawned. */
	createdAt?: string;
	/** A root Agent loaded in another process. */
	remote?: boolean;
}

interface Shared {
	scheduler: TreeScheduler;
	nodes: Map<string, AgentNode>;
	usage: Map<string, Usage>;
	listeners?: Set<() => void>;
	/** The other root Agents last listed, for short IDs shown to a root Agent. */
	rootIds?: string[];
}

const shared = ((globalThis as Record<symbol, unknown>)[Symbol.for("pi-agents:runtime")] ??= {
	scheduler: new TreeScheduler(),
	nodes: new Map(),
	usage: new Map(),
}) as Shared;
// Child Sessions load their own copy of this module; keep shared state but adopt current methods.
Object.setPrototypeOf(shared.scheduler, TreeScheduler.prototype);
const listeners = shared.listeners ??= new Set();

export const nodes = shared.nodes;

/** Calls `listener` when an Agent's state, inputs, or usage change in any tree of this process. */
export function onTreeChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function treeChanged(): void {
	for (const listener of listeners) listener();
}

/** The shortest prefix of `id`, at least 8 characters, that none of the other `ids` starts with. */
export function shortId(id: string, ids: Iterable<string>): string {
	let length = Math.min(8, id.length);
	for (const other of ids) {
		while (other !== id && length < id.length && other.startsWith(id.slice(0, length))) length++;
	}
	return id.slice(0, length);
}

/** An Agent's name and short ID among `ids`, the IDs of the Agents visible to the reader. */
export function label(agent: { id: string; name?: string }, ids: Iterable<string>): string {
	const id = shortId(agent.id, ids);
	return agent.name ? `${agent.name} (${id})` : id;
}

export function entryLine(entry: Entry, ids: Iterable<string>): string {
	return `${label(entry, ids)}  ${entry.state}  ${entry.cwd}`;
}

export function rememberRoots(ids: string[]): void {
	shared.rootIds = ids;
}

/** IDs of the Agents visible to an Agent with the given scope; a root Agent also sees the other roots. */
export function visibleIds(scopeId: string, root: boolean): string[] {
	const ids = treeEntries(scopeId).map((entry) => entry.id);
	return root ? [...ids, ...(shared.rootIds ?? [])] : ids;
}

/** IDs of the Agents visible to `target`. */
function recipientIds(target: Entry): string[] {
	if (target.ownerId === undefined) return visibleIds(target.id, true);
	const owner = shared.nodes.get(target.ownerId);
	return visibleIds(owner?.program ? target.id : owner?.scopeId ?? target.id, false);
}

export function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

export function treeUsage(rootId: string): Usage {
	return shared.usage.get(rootId) ?? emptyUsage();
}

export function setTreeUsage(rootId: string, usage: Usage | undefined): void {
	if (usage) shared.usage.set(rootId, usage);
	else shared.usage.delete(rootId);
}

function addUsage(rootId: string, delta: Usage): void {
	const current = treeUsage(rootId);
	const next = {
		input: current.input + delta.input,
		output: current.output + delta.output,
		cacheRead: current.cacheRead + delta.cacheRead,
		cacheWrite: current.cacheWrite + delta.cacheWrite,
		cost: current.cost + delta.cost,
		turns: current.turns + delta.turns,
	};
	shared.usage.set(rootId, next);
	shared.nodes.get(rootId)?.persistUsage(next);
	treeChanged();
}

export function restoredUsage(ctx: ExtensionContext): Usage {
	let usage = emptyUsage();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === USAGE_ENTRY) usage = { ...emptyUsage(), ...(entry.data as Usage) };
	}
	return usage;
}

export function usageEntry(usage: Usage): [string, Usage] {
	return [USAGE_ENTRY, usage];
}

export interface TreeMetadata {
	rootId: string;
	ownerId: string;
	scopeId?: string;
}

/** Owner, root, and scope recorded in an owned Agent's Session. */
export function treeMetadata(ctx: ExtensionContext): TreeMetadata | undefined {
	let metadata: TreeMetadata | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === TREE_ENTRY) metadata = entry.data as typeof metadata;
	}
	return metadata;
}

/** Visible Agents of a scope, its root first, then owned Agents depth-first. */
export function treeEntries(scopeId: string): Entry[] {
	const root = shared.nodes.get(scopeId);
	if (!root) return [];
	const entries: Entry[] = root.program ? [] : [{
		id: root.id,
		name: root.name(),
		cwd: root.cwd(),
		state: root.busy() ? "busy" : "idle",
		sessionFile: root.sessionFile(),
	}];
	const visit = (node: AgentNode) => {
		for (const agent of node.agents.owned()) {
			entries.push({ ...agent, ownerId: node.id });
			const loaded = shared.nodes.get(agent.id);
			if (loaded) visit(loaded);
		}
	};
	visit(root);
	return entries;
}

export function resolveTarget(scopeId: string, target: string): Entry {
	return resolveIn(treeEntries(scopeId), target);
}

/** Resolves an ID, a name, or a unique ID prefix among the given visible Agents. */
export function resolveIn(entries: Entry[], target: string): Entry {
	const byId = entries.find((entry) => entry.id === target);
	if (byId) return byId;
	let matches = entries.filter((entry) => entry.name === target);
	if (matches.length === 0) matches = entries.filter((entry) => entry.id.startsWith(target));
	if (matches.length === 0) throw new Error(`No visible Agent matches "${target}". Use list to find Agents.`);
	if (matches.length > 1) {
		const ids = entries.map((entry) => entry.id);
		throw new Error(`"${target}" matches several Agents:\n${matches.map((entry) => entryLine(entry, ids)).join("\n")}\n\nRetry with a longer ID prefix.`);
	}
	return matches[0]!;
}

/** Sends a message from one Agent to another visible Agent. */
export function deliver(
	from: { id: string; name?: string } | undefined,
	target: Entry,
	delivery: Delivery,
	body: string,
): { queued: boolean } {
	const fromOwner = from !== undefined && target.ownerId === from.id;
	const ids = recipientIds(target);
	const text = from === undefined ? body : messageText(from, fromOwner, delivery, body, ids);
	if (target.ownerId === undefined) {
		const node = shared.nodes.get(target.id);
		if (!node) throw new Error(`${label(target, ids)} is offline.`);
		node.receive(text, delivery);
		return { queued: false };
	}
	const owner = shared.nodes.get(target.ownerId);
	if (!owner) throw new Error(`${label(target, ids)} is offline.`);
	return owner.agents.accept(target.id, text, delivery, { fromOwner, notification: from === undefined });
}

/** A message under a header naming its sender; an input from a sender other than the owner asks for a reply. */
export function messageText(from: { id: string; name?: string }, fromOwner: boolean, delivery: Delivery, body: string, ids: Iterable<string>): string {
	return `Message from ${label(from, ids)}${!fromOwner && delivery !== "write" ? ". Reply with send" : ""}:\n${body}`;
}

/**
 * `messageId` marks a message from a root Agent in another process, so it is added once; `user`
 * marks the user's input from the Agent viewer.
 */
export function customMessage(text: string, delivery: Delivery, messageId?: string, user?: boolean) {
	return { customType: MESSAGE_TYPE, content: text, display: true, details: { delivery, ...(messageId ? { messageId } : {}), ...(user ? { user } : {}) } };
}

export function receivedMessageIds(ctx: ExtensionContext): string[] {
	return ctx.sessionManager.getEntries().flatMap((entry) =>
		entry.type === "custom_message" && entry.customType === MESSAGE_TYPE && typeof (entry.details as { messageId?: unknown })?.messageId === "string"
			? [(entry.details as { messageId: string }).messageId]
			: []);
}

/** Whether a tree has no inputs that have not ended. */
export function treeIdle(rootId: string): boolean {
	return shared.scheduler.outstanding(rootId) === 0;
}

function defaultSessionDirectory(cwd: string, agentDir: string): string {
	const safePath = `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.join(path.resolve(agentDir), "sessions", safePath);
}

export function childSessionDirectory(cwd: string, currentCwd: string, currentSessionDir: string, agentDir: string): string {
	const targetDefault = defaultSessionDirectory(cwd, agentDir);
	if (!currentSessionDir) return path.join(targetDefault, "subagents");
	const current = path.resolve(currentSessionDir);
	const currentDefault = defaultSessionDirectory(currentCwd, agentDir);
	if (current === currentDefault ||
		(path.basename(current) === "subagents" && path.dirname(current) === currentDefault)) {
		return path.join(targetDefault, "subagents");
	}
	return path.basename(current) === "subagents" ? current : path.join(current, "subagents");
}

function persistPreparedSession(sessionManager: SessionManager, cwd: string): SessionManager {
	const sessionFile = sessionManager.getSessionFile()!;
	mkdirSync(path.dirname(sessionFile), { recursive: true });
	// SessionManager flushes itself once it holds an assistant message (a forked context);
	// otherwise write the prepared entries so the child can be reopened.
	if (!existsSync(sessionFile)) {
		const entries = [sessionManager.getHeader(), ...sessionManager.getEntries()];
		writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx" });
	}
	return SessionManager.open(sessionFile, path.dirname(sessionFile), cwd);
}

function resolveProjectTrust(cwd: string, current: ExtensionContext, agentDir: string): boolean {
	const resolvedCwd = path.resolve(cwd);
	if (resolvedCwd === path.resolve(current.cwd)) return current.isProjectTrusted();
	if (!hasTrustRequiringProjectResources(resolvedCwd)) return true;
	const saved = new ProjectTrustStore(agentDir).get(resolvedCwd);
	if (saved !== null) return saved;
	return SettingsManager.create(resolvedCwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust() === "always";
}

function lastAnswer(session: AgentSession, before: number): { outcome: Outcome; result: string } {
	const assistant = [...session.messages].reverse().find((message) => message.role === "assistant");
	if (!assistant || session.getSessionStats().assistantMessages <= before) {
		return { outcome: "failed", result: "The turn ended without an answer." };
	}
	const text = assistant.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
	if (assistant.stopReason === "aborted") return { outcome: "aborted", result: text };
	if (assistant.stopReason === "error") return { outcome: "failed", result: assistant.errorMessage || "Model request failed" };
	return { outcome: "completed", result: text };
}

/** Takes this extension's messages left in the agent queues after a run settles. */
function takeQueued(agent: AgentSession["agent"]): QueuedMessage[] {
	// peekQueuedMessages returns one message in one-at-a-time mode; read the queues whole.
	const queues = agent as unknown as Record<"steeringQueue" | "followUpQueue", { messages: QueuedMessage[] }>;
	const steering = queues.steeringQueue.messages.slice();
	const followUps = queues.followUpQueue.messages.slice();
	agent.clearAllQueues();
	const ours = (message: QueuedMessage) => message.role === "custom" && message.customType === MESSAGE_TYPE;
	for (const message of steering) if (!ours(message)) agent.steer(message);
	for (const message of followUps) if (!ours(message)) agent.followUp(message);
	return [...steering, ...followUps].filter(ours);
}

export interface Deferred {
	promise: Promise<void>;
	resolve(): void;
}

export function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function ended(input: InputRecord): boolean {
	return input.state === "completed" || input.state === "failed" || input.state === "aborted";
}

interface Input {
	text: string;
	/** The user's input from the Agent viewer. */
	user?: boolean;
	record?: InputRecord;
	permit?: symbol;
	schema?: unknown;
	submitted?: { value: unknown };
	done?: Deferred;
}

type Message = Pick<Input, "text" | "user">;

interface Turn {
	inputs: Input[];
	/** Messages that joined after the turn started and still need delivery. */
	pending: Message[];
	abort: AbortController;
	started: boolean;
	done: Deferred;
}

interface Prepared {
	sessionManager: SessionManager;
	model: Model;
	thinkingLevel: ThinkingLevel;
}

interface Owned {
	record: AgentRecord;
	queue: Input[];
	turn?: Turn;
	session?: AgentSession;
	loading?: Promise<AgentSession>;
	prepared?: Prepared;
	waiters: number;
}

export interface SpawnRequest {
	name: string;
	message: string;
	cwd?: string;
	context?: "fresh" | "fork";
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface WaitResult {
	agent: AgentRecord;
	input: InputRecord;
	history: boolean;
}

export interface WaitOutcome {
	results: WaitResult[];
	pending: AgentRecord[];
}

/** The Agents owned by one loaded Agent. */
export class Agents {
	private agents = new Map<string, Owned>();
	private change = deferred();
	private closing = false;
	private ctx?: ExtensionContext;

	constructor(
		private pi: ExtensionAPI,
		private self: { id: string; rootId: string; scopeId: string; ownerId?: string; name(): string | undefined },
		private agentDir: string,
		private limits: Limits,
		private extensions: string[],
		/** Agents of a Program: kept in memory only, with results returned by `request()` and no notifications. */
		private program = false,
	) {}

	setContext(ctx: ExtensionContext): void {
		this.ctx = ctx;
	}

	owned(): Array<Omit<Entry, "ownerId">> {
		return [...this.agents.values()].map((agent) => ({
			id: agent.record.id,
			name: agent.record.name,
			cwd: agent.record.cwd,
			state: agent.turn?.started ? "busy" : "idle",
			sessionFile: agent.record.sessionFile,
			createdAt: agent.record.createdAt,
		}));
	}

	/** Queued inputs and unread results of an owned Agent. */
	counts(id: string): { busy: boolean; queued: number; unread: number } | undefined {
		const agent = this.agents.get(id);
		if (!agent) return undefined;
		return {
			busy: agent.turn?.started === true,
			queued: agent.queue.length + (agent.turn && !agent.turn.started ? agent.turn.inputs.length : 0),
			unread: agent.record.inputs.filter((input) => ended(input) && !input.read).length,
		};
	}

	/** An owned Agent's loaded Session, or its saved messages while it is not loaded. */
	conversation(id: string): {
		session?: AgentSession;
		messages: AgentSession["messages"];
		cwd: string;
		model?: { provider: string; modelId: string };
		thinkingLevel?: string;
	} | undefined {
		const agent = this.agents.get(id);
		if (!agent) return undefined;
		const { session, record } = agent;
		if (session) {
			const model = session.model && { provider: session.model.provider, modelId: session.model.id };
			return { session, messages: session.messages, cwd: record.cwd, model, thinkingLevel: session.thinkingLevel };
		}
		const manager = agent.prepared?.sessionManager ??
			(existsSync(record.sessionFile) ? SessionManager.open(record.sessionFile, path.dirname(record.sessionFile), record.cwd) : undefined);
		const context = manager?.buildSessionContext();
		return { messages: context?.messages ?? [], cwd: record.cwd, model: context?.model ?? undefined, thinkingLevel: context?.thinkingLevel };
	}

	/**
	 * Sends the user's input to an owned Agent, as from Pi's editor: it has no sender header and no
	 * result. `steer` joins the current turn, or starts one when the Agent is idle.
	 */
	prompt(id: string, text: string, delivery: "followUp" | "steer"): void {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Agent ${id} is not owned by ${this.self.id}.`);
		const input: Input = { text, user: true, permit: this.reserve() };
		if (delivery === "steer" && agent.turn) this.join(agent, agent.turn, input);
		else this.enqueue(agent, input);
	}

	/** Loads an owned Agent's Session without starting a turn. */
	open(id: string): Promise<AgentSession> {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Agent ${id} is not owned by ${this.self.id}.`);
		return this.load(agent);
	}

	/** Stops an owned Agent's current turn and withdraws its queued inputs. */
	async abortAgent(id: string): Promise<boolean> {
		const agent = this.agents.get(id);
		return agent ? this.abort(agent) : false;
	}

	/** Resolves a visible target that this Agent owns. */
	ownedTarget(target: string): Owned {
		const entry = resolveTarget(this.self.scopeId, target);
		const agent = this.agents.get(entry.id);
		if (!agent) throw new Error(`${label(entry, this.ids())} is not owned by the caller.`);
		return agent;
	}

	/** IDs of the Agents visible to this Agent. */
	ids(): string[] {
		return visibleIds(this.self.scopeId, this.self.ownerId === undefined);
	}

	spawn(request: SpawnRequest): { record: AgentRecord; queued: boolean } {
		const permit = this.reserve();
		let agent: Owned;
		try {
			agent = this.create(request);
		} catch (error) {
			shared.scheduler.releaseOutstanding(this.self.rootId, permit);
			throw error;
		}
		const text = `Message from ${label({ id: this.self.id, name: this.self.name() }, this.ids())}:\n${request.message}`;
		const queued = this.enqueue(agent, { text, permit, record: this.newRecord(agent) });
		return { record: agent.record, queued };
	}

	/** Creates an idle Agent; `id` sets its ID. */
	create(request: Omit<SpawnRequest, "message">, id?: string): Owned {
		const name = request.name.trim();
		const existing = [...this.agents.values()].find((agent) => agent.record.name === name);
		if (existing) throw new Error(`Name "${name}" is already used by ${shortId(existing.record.id, this.ids())}.`);
		const prepared = this.prepare(request, name, id);
		const agent: Owned = {
			record: {
				id: prepared.sessionManager.getSessionId(),
				name,
				sessionFile: prepared.sessionManager.getSessionFile()!,
				cwd: prepared.sessionManager.getCwd(),
				createdAt: new Date().toISOString(),
				inputs: [],
			},
			queue: [],
			prepared,
			waiters: 0,
		};
		this.agents.set(agent.record.id, agent);
		return agent;
	}

	/**
	 * Sends an input from the owner and resolves when it ends. With a schema, the Agent must call
	 * `submit_result` with a matching value, which becomes the input's `value`.
	 */
	async request(id: string, text: string, delivery: "followUp" | "steer", schema?: unknown): Promise<InputRecord> {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Agent ${id} is not owned by ${this.self.id}.`);
		const input: Input = { text, permit: this.reserve(), record: this.newRecord(agent), done: deferred() };
		if (schema !== undefined) {
			input.schema = schema;
			input.text += `\n\nWhen done, call \`${SUBMIT_RESULT_TOOL_NAME}\` with a \`value\` that matches this JSON Schema:\n${JSON.stringify(schema)}`;
		}
		if (delivery === "steer" && agent.turn) this.join(agent, agent.turn, input);
		else this.enqueue(agent, input);
		await input.done!.promise;
		return input.record!;
	}

	/** Records a value from `submit_result` for the Agent's current input with a schema. */
	submit(id: string, value: unknown): void {
		const input = this.agents.get(id)?.turn?.inputs.find((candidate) => candidate.schema !== undefined);
		if (!input) throw new Error("No current input asks for a result.");
		const args = validateToolArguments(
			{ name: SUBMIT_RESULT_TOOL_NAME, description: "", parameters: { type: "object", properties: { value: input.schema }, required: ["value"] } as never },
			{ type: "toolCall", id: "", name: SUBMIT_RESULT_TOOL_NAME, arguments: { value } as never },
		) as { value: unknown };
		input.submitted = { value: args.value };
	}

	accept(id: string, text: string, delivery: Delivery, options: { fromOwner: boolean; notification: boolean }): { queued: boolean } {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Agent ${id} is not owned by ${this.self.id}.`);
		if (delivery === "write") {
			this.write(agent, text);
			return { queued: false };
		}
		// Notifications keep their owner informed even at the input limit.
		const permit = options.notification ? undefined : this.reserve();
		const input: Input = { text, permit, record: options.fromOwner && !options.notification ? this.newRecord(agent) : undefined };
		if (delivery === "steer" && agent.turn) {
			this.join(agent, agent.turn, input);
			return { queued: false };
		}
		return { queued: this.enqueue(agent, input) };
	}

	async wait(targets: Owned[] | undefined, history: number, timeoutSeconds: number, signal?: AbortSignal): Promise<WaitOutcome> {
		const selected = targets ?? [...this.agents.values()].filter((agent) =>
			this.pending(agent) || agent.record.inputs.some((input) => ended(input) && !input.read));
		const unique = [...new Set(selected)];
		const replay = new Map(unique.map((agent) => [agent, history === 0
			? []
			: agent.record.inputs.filter((input) => ended(input) && input.read).slice(-history)]));
		for (const agent of unique) agent.waiters += 1;
		const suspended = unique.some((agent) => this.pending(agent)) && this.self.ownerId !== undefined &&
			shared.scheduler.suspend(this.self.rootId, this.self.id);
		let returned = false;
		try {
			const deadline = Date.now() + timeoutSeconds * 1000;
			while (unique.some((agent) => this.pending(agent))) {
				const remaining = deadline - Date.now();
				if (remaining <= 0) break;
				signal?.throwIfAborted();
				let timer: ReturnType<typeof setTimeout> | undefined;
				let onAbort: (() => void) | undefined;
				try {
					await Promise.race([
						this.change.promise,
						new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); }),
						new Promise<void>((resolve) => {
							onAbort = resolve;
							signal?.addEventListener("abort", onAbort, { once: true });
						}),
					]);
				} finally {
					clearTimeout(timer);
					if (onAbort) signal?.removeEventListener("abort", onAbort);
				}
			}
			signal?.throwIfAborted();
			const results: WaitResult[] = [];
			for (const agent of unique) {
				for (const input of replay.get(agent)!) results.push({ agent: agent.record, input, history: true });
				for (const input of agent.record.inputs) {
					if (ended(input) && !input.read) results.push({ agent: agent.record, input, history: false });
				}
			}
			returned = true;
			return { results, pending: unique.filter((agent) => this.pending(agent)).map((agent) => agent.record) };
		} finally {
			if (suspended) await shared.scheduler.resume(this.self.rootId, this.self.id, this.limits.maxConcurrent, signal);
			for (const agent of unique) {
				agent.waiters -= 1;
				for (const input of agent.record.inputs) {
					if (!ended(input) || input.notified) continue;
					if (returned) input.notified = true;
					else this.notifyLater(agent, input);
				}
				this.persist(agent);
			}
		}
	}

	markRead(results: WaitResult[]): void {
		const changed = new Set<string>();
		for (const { agent, input, history } of results) {
			if (history || input.read) continue;
			input.read = true;
			changed.add(agent.id);
		}
		for (const id of changed) this.persist(this.agents.get(id)!);
		if (changed.size > 0) treeChanged();
	}

	/** Stops the current turn and withdraws queued inputs; returns whether there was anything to stop. */
	async abort(agent: Owned): Promise<boolean> {
		const turn = agent.turn;
		if (!turn && agent.queue.length === 0) return false;
		for (const input of agent.queue.splice(0)) this.end(agent, input, "aborted", "");
		this.changed();
		if (turn) {
			turn.abort.abort();
			if (turn.started && agent.session) {
				agent.session.abortCompaction();
				agent.session.abortRetry();
				await agent.session.abort();
			}
			await turn.done.promise;
		}
		return true;
	}

	restore(ctx: ExtensionContext): void {
		const records = new Map<string, AgentRecord>();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== AGENT_ENTRY) continue;
			const record = entry.data as AgentRecord;
			records.set(record.id, record);
		}
		for (const record of records.values()) {
			const agent: Owned = { record, queue: [], waiters: 0 };
			this.agents.set(record.id, agent);
			if (!record.inputs.some((input) => !ended(input))) continue;
			for (const input of record.inputs) {
				if (ended(input)) continue;
				input.state = "aborted";
				input.result = "";
				input.notified = true;
			}
			this.persist(agent);
		}
	}

	async shutdown(): Promise<void> {
		this.closing = true;
		const agents = [...this.agents.values()];
		await Promise.allSettled(agents.map((agent) => this.abort(agent)));
		await Promise.allSettled(agents.map(async (agent) => {
			const session = agent.session ?? await agent.loading?.catch(() => undefined);
			if (!session) return;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
					new Promise((resolve) => { timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS); }),
				]);
			} finally {
				clearTimeout(timer);
				session.dispose();
				agent.session = undefined;
			}
		}));
	}

	private write(agent: Owned, text: string): void {
		const message = customMessage(text, "write");
		const session = agent.session;
		if (session?.isStreaming) {
			session.agent.steer({ role: "custom", ...message, timestamp: Date.now() });
			return;
		}
		if (session) {
			void session.sendCustomMessage(message, { triggerTurn: false });
			return;
		}
		// Loading an idle Agent does not start a turn.
		void this.load(agent).then(
			(loaded) => loaded.sendCustomMessage(message, { triggerTurn: false }),
			(error) => console.warn(`[pi-agents] write to ${agent.record.id} failed: ${error instanceof Error ? error.message : String(error)}`),
		);
	}

	private enqueue(agent: Owned, input: Input): boolean {
		const queued = !agent.turn && !shared.scheduler.hasCapacity(this.self.rootId, this.limits.maxConcurrent);
		agent.queue.push(input);
		this.persist(agent);
		this.changed();
		this.pump(agent);
		return queued;
	}

	private join(agent: Owned, turn: Turn, input: Input): void {
		turn.inputs.push(input);
		if (input.record && turn.started) input.record.state = "running";
		this.persist(agent);
		this.changed();
		if (!turn.started) return;
		if (agent.session?.isStreaming) {
			agent.session.agent.steer({ role: "custom", ...customMessage(input.text, "steer", undefined, input.user), timestamp: Date.now() });
		} else {
			turn.pending.push({ text: input.text, user: input.user });
		}
	}

	private pump(agent: Owned): void {
		if (agent.turn || this.closing) return;
		const head = agent.queue.shift();
		if (!head) return;
		const turn: Turn = { inputs: [head], pending: [], abort: new AbortController(), started: false, done: deferred() };
		agent.turn = turn;
		void this.runTurn(agent, turn);
	}

	private async runTurn(agent: Owned, turn: Turn): Promise<void> {
		const rootId = this.self.rootId;
		let slot = false;
		let session: AgentSession | undefined;
		let before: ReturnType<AgentSession["getSessionStats"]> | undefined;
		let answer: { outcome: Outcome; result: string } = { outcome: "aborted", result: "" };
		try {
			await shared.scheduler.acquireQueued(rootId, agent.record.id, this.limits.maxConcurrent, turn.abort.signal);
			slot = true;
			session = await this.load(agent);
			turn.abort.signal.throwIfAborted();
			before = session.getSessionStats();
			turn.started = true;
			for (const input of turn.inputs) if (input.record) input.record.state = "running";
			this.persist(agent);
			this.changed();
			let batch: Message[] = turn.inputs.map(({ text, user }) => ({ text, user }));
			while (batch.length > 0 && !turn.abort.signal.aborted) {
				for (const { text, user } of batch.slice(0, -1)) await session.sendCustomMessage(customMessage(text, "steer", undefined, user), { triggerTurn: false });
				const last = batch.at(-1)!;
				await session.sendCustomMessage(customMessage(last.text, "steer", undefined, last.user), { triggerTurn: true });
				await session.waitForIdle();
				const leftover = takeQueued(session.agent);
				for (const message of leftover) {
					if ((message as { details?: { delivery?: Delivery } }).details?.delivery !== "write") continue;
					await session.sendCustomMessage(message as ReturnType<typeof customMessage>, { triggerTurn: false });
				}
				batch = [
					...turn.pending.splice(0),
					...leftover.flatMap((message) => {
						const details = (message as { details?: { delivery?: Delivery; user?: boolean } }).details;
						return details?.delivery === "write" ? [] : [{ text: String((message as { content: unknown }).content), user: details?.user }];
					}),
				];
			}
			answer = turn.abort.signal.aborted ? { outcome: "aborted", result: "" } : lastAnswer(session, before.assistantMessages);
			if (turn.abort.signal.aborted) {
				const last = lastAnswer(session, before.assistantMessages);
				if (last.outcome !== "failed") answer.result = last.result;
			}
		} catch (error) {
			if (!turn.abort.signal.aborted) answer = { outcome: "failed", result: error instanceof Error ? error.message : String(error) };
		} finally {
			if (slot) shared.scheduler.release(rootId, agent.record.id);
			if (session && before) {
				const after = session.getSessionStats();
				addUsage(rootId, {
					input: Math.max(0, after.tokens.input - before.tokens.input),
					output: Math.max(0, after.tokens.output - before.tokens.output),
					cacheRead: Math.max(0, after.tokens.cacheRead - before.tokens.cacheRead),
					cacheWrite: Math.max(0, after.tokens.cacheWrite - before.tokens.cacheWrite),
					cost: Math.max(0, after.cost - before.cost),
					turns: Math.max(0, after.assistantMessages - before.assistantMessages),
				});
			}
			agent.turn = undefined;
			for (const input of turn.inputs) this.end(agent, input, answer.outcome, answer.result);
			turn.done.resolve();
			this.changed();
			this.pump(agent);
		}
	}

	private end(agent: Owned, input: Input, outcome: Outcome, result: string): void {
		if (input.permit) shared.scheduler.releaseOutstanding(this.self.rootId, input.permit);
		input.permit = undefined;
		const record = input.record;
		if (!record || ended(record)) return;
		if (input.schema !== undefined && outcome !== "aborted") {
			if (input.submitted) {
				outcome = "completed";
				record.value = input.submitted.value;
			} else if (outcome === "completed") {
				outcome = "failed";
				result = `The turn ended without calling ${SUBMIT_RESULT_TOOL_NAME}.`;
			}
		}
		record.state = outcome;
		record.result = result;
		this.persist(agent);
		input.done?.resolve();
		if (agent.waiters === 0) this.notifyLater(agent, record);
	}

	private notifyLater(agent: Owned, record: InputRecord): void {
		if (this.program) return;
		queueMicrotask(() => {
			if (this.closing || record.notified || agent.waiters > 0) return;
			record.notified = true;
			this.persist(agent);
			this.notify(`Agent ${label(agent.record, this.ids())} ${record.state}.`);
		});
	}

	/** Delivers a notification to this Agent as a steer. */
	notify(text: string): void {
		try {
			deliver(undefined, { id: this.self.id, name: this.self.name(), ownerId: this.self.ownerId, cwd: "", state: "busy" }, "steer", text);
		} catch (error) {
			console.warn(`[pi-agents] notification failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Runs `work` while an owned caller gives up its slot, and takes one again before returning. */
	async whileSuspended<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const suspended = this.self.ownerId !== undefined && shared.scheduler.suspend(this.self.rootId, this.self.id);
		try {
			return await work();
		} finally {
			if (suspended) await shared.scheduler.resume(this.self.rootId, this.self.id, this.limits.maxConcurrent, signal);
		}
	}

	private pending(agent: Owned): boolean {
		return agent.record.inputs.some((input) => !ended(input));
	}

	private newRecord(agent: Owned): InputRecord {
		const record: InputRecord = { id: `${agent.record.id}:${agent.record.inputs.length + 1}`, state: "queued", read: false, notified: false };
		agent.record.inputs.push(record);
		return record;
	}

	private reserve(): symbol {
		const permit = shared.scheduler.reserveOutstanding(this.self.rootId, this.limits.maxOutstanding);
		if (!permit) throw new Error(`Input rejected: ${this.limits.maxOutstanding} inputs have not ended. Wait for results or abort an Agent.`);
		return permit;
	}

	private persist(agent: Owned): void {
		if (this.program) return;
		if (this.closing && !agent.record.inputs.some((input) => !ended(input))) return;
		this.pi.appendEntry(AGENT_ENTRY, agent.record);
	}

	private changed(): void {
		const previous = this.change;
		this.change = deferred();
		previous.resolve();
		treeChanged();
	}

	private requireContext(): ExtensionContext {
		if (!this.ctx) throw new Error("pi-agents is not initialized");
		return this.ctx;
	}

	private prepare(request: Omit<SpawnRequest, "message">, name: string, id?: string): Prepared {
		const ctx = this.requireContext();
		let model = ctx.model;
		if (request.model !== undefined) {
			const separator = request.model.indexOf("/");
			model = separator > 0
				? ctx.modelRegistry.find(request.model.slice(0, separator), request.model.slice(separator + 1))
				: undefined;
			if (!model) throw new Error(`Unknown model "${request.model}". Use provider/modelId.`);
		}
		if (!model) throw new Error("Cannot spawn an Agent without a model.");
		const thinkingLevel = request.thinkingLevel ?? this.pi.getThinkingLevel();
		const cwd = path.resolve(ctx.cwd, request.cwd ?? ".");
		const sessionManager = SessionManager.create(cwd, childSessionDirectory(cwd, ctx.cwd, ctx.sessionManager.getSessionDir(), this.agentDir), {
			id: id ?? randomUUID(),
			parentSession: ctx.sessionManager.getSessionFile(),
		});
		// Each of a Program's Agents heads its own scope, so it sees only itself and the Agents under it.
		const scopeId = this.program ? sessionManager.getSessionId() : this.self.scopeId;
		sessionManager.appendCustomEntry(TREE_ENTRY, { rootId: this.self.rootId, ownerId: this.self.id, scopeId } satisfies TreeMetadata);
		sessionManager.appendSessionInfo(name);
		sessionManager.appendModelChange(model.provider, model.id);
		sessionManager.appendThinkingLevelChange(thinkingLevel);
		const sshState = ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "ssh-state").pop();
		if (sshState?.type === "custom") sessionManager.appendCustomEntry("ssh-state", structuredClone(sshState.data));
		if (request.context === "fork") {
			// Tools run after Pi persists the assistant message that called them; fork before it
			// so the child never inherits a tool call without its result.
			const messages = (ctx.sessionManager as SessionManager).buildSessionContext().messages;
			const last = messages.at(-1);
			const forked = last?.role === "assistant" && last.content.some((part) => part.type === "toolCall") ? messages.slice(0, -1) : messages;
			for (const message of forked) sessionManager.appendMessage(structuredClone(message) as Parameters<SessionManager["appendMessage"]>[0]);
		}
		return { sessionManager: persistPreparedSession(sessionManager, cwd), model, thinkingLevel };
	}

	private load(agent: Owned): Promise<AgentSession> {
		if (agent.session) return Promise.resolve(agent.session);
		agent.loading ??= this.createSession(agent).then((session) => {
			agent.session = session;
			agent.prepared = undefined;
			return session;
		}).finally(() => { agent.loading = undefined; });
		return agent.loading;
	}

	private async createSession(agent: Owned): Promise<AgentSession> {
		const ctx = this.requireContext();
		const { cwd, sessionFile } = agent.record;
		const settingsManager = SettingsManager.create(cwd, this.agentDir, { projectTrusted: resolveProjectTrust(cwd, ctx, this.agentDir) });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: this.agentDir,
			settingsManager,
			noExtensions: true,
			additionalExtensionPaths: [EXTENSION_PATH, ...this.extensions],
		});
		await resourceLoader.reload();
		const loadErrors = resourceLoader.getExtensions().errors;
		if (loadErrors.length > 0) throw new Error(`Extension loading failed: ${loadErrors.map((error) => `${error.path}: ${error.error}`).join("; ")}`);
		if (!agent.prepared && !existsSync(sessionFile)) throw new Error(`Session file is missing: ${sessionFile}`);
		const sessionManager = agent.prepared?.sessionManager ?? SessionManager.open(sessionFile, path.dirname(sessionFile), cwd);
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd,
			agentDir: this.agentDir,
			// Share the owner's model runtime so extension-registered providers and auth carry over.
			modelRuntime: (ctx.modelRegistry as unknown as { runtime: CreateOptions["modelRuntime"] }).runtime,
			settingsManager,
			resourceLoader,
			sessionManager,
			model: agent.prepared?.model,
			thinkingLevel: agent.prepared?.thinkingLevel,
			tools: [
				...this.pi.getActiveTools().filter((name) => name !== SUBMIT_RESULT_TOOL_NAME),
				...(this.program ? [SUBMIT_RESULT_TOOL_NAME] : []),
			],
			sessionStartEvent: { type: "session_start", reason: agent.prepared ? "new" : "resume" },
		});
		if (!session.model) {
			session.dispose();
			throw new Error(modelFallbackMessage ?? "No model available.");
		}
		const errors: ExtensionError[] = [];
		const unsupported = async (): Promise<never> => { throw new Error("Session control is not supported in owned Agents."); };
		try {
			await session.bindExtensions({
				mode: "print",
				onError: (error) => errors.push(error),
				commandContextActions: {
					waitForIdle: () => session.waitForIdle(),
					newSession: unsupported,
					switchSession: unsupported,
					fork: unsupported,
					navigateTree: unsupported,
					reload: unsupported,
				},
			});
			if (errors.length > 0) {
				throw new Error(`Extension initialization failed: ${errors.map((error) => `${error.extensionPath} (${error.event}): ${error.error}`).join("; ")}`);
			}
		} catch (error) {
			try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
			finally { session.dispose(); }
			throw error;
		}
		return session;
	}
}

interface SearchText {
	time: number;
	text: string;
}

function sessionTexts(sessionFile: string | undefined): SearchText[] {
	if (!sessionFile || !existsSync(sessionFile)) return [];
	const texts: SearchText[] = [];
	for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
		if (!line) continue;
		let entry: Record<string, any>;
		try { entry = JSON.parse(line); } catch { continue; }
		const time = Date.parse(entry.timestamp ?? "") || 0;
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			if (typeof entry.summary === "string") texts.push({ time, text: entry.summary });
		} else if (entry.type === "message" && entry.message?.role === "user") {
			const content = entry.message.content;
			const text = typeof content === "string"
				? content
				: Array.isArray(content) ? content.flatMap((part: any) => part?.type === "text" ? [part.text] : []).join("\n") : "";
			if (text) texts.push({ time, text });
		} else if (entry.type === "custom_message" && entry.customType === MESSAGE_TYPE && typeof entry.content === "string") {
			texts.push({ time, text: entry.content });
		}
	}
	return texts;
}

function matcher(query: string): (text: string) => string[] | undefined {
	const groups = query.toLowerCase().split("|").map((group) => group.trim().split(/\s+/).filter(Boolean)).filter((group) => group.length > 0);
	return (text) => {
		const lower = text.toLowerCase();
		return groups.find((terms) => terms.every((term) => lower.includes(term)));
	};
}

function excerpt(text: string, term: string): string {
	const flat = text.replace(/\s+/g, " ");
	const index = Math.max(0, flat.toLowerCase().indexOf(term));
	const start = Math.max(0, index - 40);
	const end = Math.min(flat.length, index + term.length + 80);
	return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

function formatTime(time: number): string {
	const date = new Date(time);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface ListItem {
	entry: Entry;
	match?: SearchText & { excerpt: string };
}

/** Filters entries by a query over ID, name, cwd, summaries, and user messages, most recent match first. */
export function searchEntries(entries: Entry[], query: string | undefined): ListItem[] {
	if (!query?.trim()) return entries.map((entry) => ({ entry }));
	const match = matcher(query);
	const items: Array<ListItem & { time: number }> = [];
	for (const entry of entries) {
		let latest: ListItem["match"];
		for (const text of sessionTexts(entry.sessionFile)) {
			const terms = match(text.text);
			if (terms && (!latest || text.time >= latest.time)) latest = { ...text, excerpt: excerpt(text.text, terms[0]!) };
		}
		if (latest) items.push({ entry, match: latest, time: latest.time });
		else if (match([entry.id, entry.name ?? "", entry.cwd].join("\n"))) items.push({ entry, time: 0 });
	}
	return items.sort((left, right) => right.time - left.time).map(({ time: _time, ...item }) => item);
}

export function listLine(item: ListItem, ids: Iterable<string>): string {
	const line = entryLine(item.entry, ids);
	return item.match ? `${line}\n  ${formatTime(item.match.time)}  ${item.match.excerpt}` : line;
}

/** The first input an Agent received, without its sender header; a forked conversation is not its input. */
export function firstInput(sessionFile: string | undefined): string | undefined {
	if (!sessionFile || !existsSync(sessionFile)) return undefined;
	let text: string | undefined;
	for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
		let entry: Record<string, any>;
		try { entry = JSON.parse(line); } catch { continue; }
		if (entry.type === "custom_message" && entry.customType === MESSAGE_TYPE && typeof entry.content === "string") {
			text = entry.content;
			break;
		}
	}
	if (text === undefined) return undefined;
	return (text.startsWith("Message from ") ? text.slice(text.indexOf("\n") + 1) : text).replace(/\s+/g, " ").trim();
}
