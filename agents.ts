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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TreeScheduler } from "./scheduler.ts";

export const MESSAGE_TYPE = "pi-agents";
const AGENT_ENTRY = "pi-agents-agent";
const TREE_ENTRY = "pi-agents-tree";
const USAGE_ENTRY = "pi-agents-usage";
const SHUTDOWN_TIMEOUT_MS = 10_000;
const EXTENSION_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));

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
	ownerId?: string;
	name(): string | undefined;
	cwd(): string;
	busy(): boolean;
	sessionFile(): string | undefined;
	agents: Agents;
	/** Delivers a message to this node; used only for root Agents. */
	receive(text: string, delivery: Delivery): void;
	persistUsage(usage: Usage): void;
}

export interface Entry {
	id: string;
	name?: string;
	ownerId?: string;
	cwd: string;
	state: AgentState;
	sessionFile?: string;
}

interface Shared {
	scheduler: TreeScheduler;
	nodes: Map<string, AgentNode>;
	usage: Map<string, Usage>;
}

const shared = ((globalThis as Record<symbol, unknown>)[Symbol.for("pi-agents:runtime")] ??= {
	scheduler: new TreeScheduler(),
	nodes: new Map(),
	usage: new Map(),
}) as Shared;
// Child Sessions load their own copy of this module; keep shared state but adopt current methods.
Object.setPrototypeOf(shared.scheduler, TreeScheduler.prototype);

export const nodes = shared.nodes;

export function label(agent: { id: string; name?: string }): string {
	return agent.name ? `${agent.name} (${agent.id})` : agent.id;
}

export function entryLine(entry: Entry): string {
	return `${label(entry)}  ${entry.state}  ${entry.cwd}`;
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

/** Owner and root recorded in an owned Agent's Session. */
export function treeMetadata(ctx: ExtensionContext): { rootId: string; ownerId: string } | undefined {
	let metadata: { rootId: string; ownerId: string } | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === TREE_ENTRY) metadata = entry.data as typeof metadata;
	}
	return metadata;
}

/** Visible Agents of a tree, root first, then owned Agents depth-first. */
export function treeEntries(rootId: string): Entry[] {
	const root = shared.nodes.get(rootId);
	if (!root) return [];
	const entries: Entry[] = [{
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

export function resolveTarget(rootId: string, target: string): Entry {
	const entries = treeEntries(rootId);
	const byId = entries.find((entry) => entry.id === target);
	if (byId) return byId;
	const matches = entries.filter((entry) => entry.name === target);
	if (matches.length === 0) throw new Error(`No visible Agent matches "${target}". Use list to find Agents.`);
	if (matches.length > 1) {
		throw new Error(`"${target}" matches several Agents:\n${matches.map(entryLine).join("\n")}\n\nRetry with an ID.`);
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
	const text = from === undefined
		? body
		: `Message from ${label(from)}${!fromOwner && delivery !== "write" ? ". Reply with send" : ""}:\n${body}`;
	if (target.ownerId === undefined) {
		const node = shared.nodes.get(target.id);
		if (!node) throw new Error(`${label(target)} is offline.`);
		node.receive(text, delivery);
		return { queued: false };
	}
	const owner = shared.nodes.get(target.ownerId);
	if (!owner) throw new Error(`${label(target)} is offline.`);
	return owner.agents.accept(target.id, text, delivery, { fromOwner, notification: from === undefined });
}

export function customMessage(text: string, delivery: Delivery) {
	return { customType: MESSAGE_TYPE, content: text, display: true, details: { delivery } };
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

interface Deferred {
	promise: Promise<void>;
	resolve(): void;
}

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function ended(input: InputRecord): boolean {
	return input.state === "completed" || input.state === "failed" || input.state === "aborted";
}

interface Input {
	text: string;
	record?: InputRecord;
	permit?: symbol;
}

interface Turn {
	inputs: Input[];
	/** Messages that joined after the turn started and still need delivery. */
	pending: string[];
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
		private self: { id: string; rootId: string; ownerId?: string; name(): string | undefined },
		private agentDir: string,
		private limits: Limits,
		private extensions: string[],
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
		}));
	}

	summary(): { busy: number; queued: number; unread: number } {
		let busy = 0, queued = 0, unread = 0;
		for (const agent of this.agents.values()) {
			if (agent.turn?.started) busy += 1;
			queued += agent.queue.length + (agent.turn && !agent.turn.started ? agent.turn.inputs.length : 0);
			unread += agent.record.inputs.filter((input) => ended(input) && !input.read).length;
		}
		return { busy, queued, unread };
	}

	/** Resolves a visible target that this Agent owns. */
	ownedTarget(target: string): Owned {
		const entry = resolveTarget(this.self.rootId, target);
		const agent = this.agents.get(entry.id);
		if (!agent) throw new Error(`${label(entry)} is not owned by the caller.`);
		return agent;
	}

	spawn(request: SpawnRequest): { record: AgentRecord; queued: boolean } {
		const name = request.name.trim();
		const existing = [...this.agents.values()].find((agent) => agent.record.name === name);
		if (existing) throw new Error(`Name "${name}" is already used by ${existing.record.id}.`);
		const permit = this.reserve();
		let agent: Owned;
		try {
			const prepared = this.prepare(request, name);
			const sessionFile = prepared.sessionManager.getSessionFile()!;
			agent = {
				record: {
					id: prepared.sessionManager.getSessionId(),
					name,
					sessionFile,
					cwd: prepared.sessionManager.getCwd(),
					createdAt: new Date().toISOString(),
					inputs: [],
				},
				queue: [],
				prepared,
				waiters: 0,
			};
		} catch (error) {
			shared.scheduler.releaseOutstanding(this.self.rootId, permit);
			throw error;
		}
		this.agents.set(agent.record.id, agent);
		const text = `Message from ${label({ id: this.self.id, name: this.self.name() })}:\n${request.message}`;
		const queued = this.enqueue(agent, { text, permit, record: this.newRecord(agent) });
		return { record: agent.record, queued };
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
			agent.session.agent.steer({ role: "custom", ...customMessage(input.text, "steer"), timestamp: Date.now() });
		} else {
			turn.pending.push(input.text);
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
			let batch = turn.inputs.map((input) => input.text);
			while (batch.length > 0 && !turn.abort.signal.aborted) {
				for (const text of batch.slice(0, -1)) await session.sendCustomMessage(customMessage(text, "steer"), { triggerTurn: false });
				await session.sendCustomMessage(customMessage(batch.at(-1)!, "steer"), { triggerTurn: true });
				await session.waitForIdle();
				const leftover = takeQueued(session.agent);
				for (const message of leftover) {
					if ((message as { details?: { delivery?: Delivery } }).details?.delivery !== "write") continue;
					await session.sendCustomMessage(message as ReturnType<typeof customMessage>, { triggerTurn: false });
				}
				batch = [
					...turn.pending.splice(0),
					...leftover.flatMap((message) => (message as { details?: { delivery?: Delivery } }).details?.delivery === "write"
						? []
						: [String((message as { content: unknown }).content)]),
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
		record.state = outcome;
		record.result = result;
		this.persist(agent);
		if (agent.waiters === 0) this.notifyLater(agent, record);
	}

	private notifyLater(agent: Owned, record: InputRecord): void {
		queueMicrotask(() => {
			if (this.closing || record.notified || agent.waiters > 0) return;
			record.notified = true;
			this.persist(agent);
			try {
				deliver(undefined, { id: this.self.id, name: this.self.name(), ownerId: this.self.ownerId, cwd: "", state: "busy" },
					"steer", `Agent ${label(agent.record)} ${record.state}.`);
			} catch (error) {
				console.warn(`[pi-agents] notification failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
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
		if (this.closing && !agent.record.inputs.some((input) => !ended(input))) return;
		this.pi.appendEntry(AGENT_ENTRY, agent.record);
	}

	private changed(): void {
		const previous = this.change;
		this.change = deferred();
		previous.resolve();
	}

	private requireContext(): ExtensionContext {
		if (!this.ctx) throw new Error("pi-agents is not initialized");
		return this.ctx;
	}

	private prepare(request: SpawnRequest, name: string): Prepared {
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
			parentSession: ctx.sessionManager.getSessionFile(),
		});
		sessionManager.appendCustomEntry(TREE_ENTRY, { rootId: this.self.rootId, ownerId: this.self.id });
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
			tools: this.pi.getActiveTools(),
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

export function listLine(item: ListItem): string {
	const line = entryLine(item.entry);
	return item.match ? `${line}\n  ${formatTime(item.match.time)}  ${item.match.excerpt}` : line;
}
