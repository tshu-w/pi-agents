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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	customMessage,
	deliver,
	label,
	messageText,
	MESSAGE_TYPE,
	resolveTarget,
	scheduler,
	shortId,
	TREE_ENTRY,
	trackTreeWork,
	treeChanged,
	visibleIds,
	type Delivery,
	type Entry,
	type TreeMetadata,
} from "./registry.ts";

const AGENT_ENTRY = "pi-agents-agent";
const SHUTDOWN_TIMEOUT_MS = 10_000;
const EXTENSION_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));
export const SUBMIT_RESULT_TOOL_NAME = "submit_result";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type Outcome = "completed" | "failed" | "aborted";
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


function defaultSessionDirectory(cwd: string, agentDir: string): string {
	const safePath = `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.join(path.resolve(agentDir), "sessions", safePath);
}

function childSessionDirectory(cwd: string, currentCwd: string, currentSessionDir: string, agentDir: string): string {
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
function takeQueued(agent: AgentSession["agent"]) {
	// peekQueuedMessages returns one message in one-at-a-time mode; read the queues whole.
	const queues = agent as unknown as Record<"steeringQueue" | "followUpQueue", { messages: QueuedMessage[] }>;
	const steering = queues.steeringQueue.messages.slice();
	const followUps = queues.followUpQueue.messages.slice();
	agent.clearAllQueues();
	const ours = (message: QueuedMessage): message is QueuedMessage & ReturnType<typeof customMessage> =>
		message.role === "custom" && message.customType === MESSAGE_TYPE;
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

/** Resolves when `change` resolves, `ms` pass, or `signal` aborts. */
export async function waitForChange(change: Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		await Promise.race([
			change,
			new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
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

/** Whether `work` settles by `deadline`; a rejection passes through. */
export async function settlesBy(work: Promise<unknown>, deadline: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const settled = work.then(() => true);
		// A rejection after the deadline has no one to report to.
		settled.catch(() => {});
		return await Promise.race([
			settled,
			new Promise<boolean>((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now()), false); }),
		]);
	} finally {
		clearTimeout(timer);
	}
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
	/** Ended by the owner's abort, so the owner is not notified. */
	silent?: boolean;
}

type Message = Pick<Input, "text" | "user">;

interface Turn {
	inputs: Input[];
	/** Messages that joined after the turn started and still need delivery. */
	pending: Message[];
	abort: AbortController;
	started: boolean;
	/** Whether the turn holds a scheduler slot. */
	slot: boolean;
	finished: boolean;
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

	/** Whether an owned Agent has a turn or queued inputs. */
	live(): boolean {
		return [...this.agents.values()].some((agent) => agent.turn !== undefined || agent.queue.length > 0);
	}

	/** Whether an owned Agent is busy, and its queued inputs. */
	counts(id: string): { busy: boolean; queued: number } | undefined {
		const agent = this.agents.get(id);
		if (!agent) return undefined;
		return {
			busy: agent.turn?.started === true,
			queued: agent.queue.length + (agent.turn && !agent.turn.started ? agent.turn.inputs.length : 0),
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
		this.add(this.agent(id), { text, user: true, permit: this.reserve() }, delivery);
	}

	/** Loads an owned Agent's Session without starting a turn. */
	open(id: string): Promise<AgentSession> {
		return this.load(this.agent(id));
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
			scheduler.releaseOutstanding(this.self.rootId, permit);
			throw error;
		}
		const text = messageText({ id: this.self.id, name: this.self.name() }, true, "followUp", request.message, this.ids());
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
	 * `submit_result` with a matching value, which becomes the input's `value`; `text` tells it so.
	 */
	async request(id: string, text: string, delivery: "followUp" | "steer", schema?: unknown): Promise<InputRecord> {
		const agent = this.agent(id);
		const input: Input = { text, permit: this.reserve(), record: this.newRecord(agent), done: deferred() };
		if (schema !== undefined) input.schema = schema;
		this.add(agent, input, delivery);
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
		const agent = this.agent(id);
		if (delivery === "write") {
			this.write(agent, text);
			return { queued: false };
		}
		// Notifications keep their owner informed even at the input limit.
		const permit = options.notification ? undefined : this.reserve();
		const input: Input = { text, permit, record: options.fromOwner && !options.notification ? this.newRecord(agent) : undefined };
		return { queued: this.add(agent, input, delivery) };
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
			scheduler.suspend(this.self.rootId, this.self.id);
		let returned = false;
		try {
			const deadline = Date.now() + timeoutSeconds * 1000;
			while (unique.some((agent) => this.pending(agent))) {
				const remaining = deadline - Date.now();
				if (remaining <= 0) break;
				signal?.throwIfAborted();
				await waitForChange(this.change.promise, remaining, signal);
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
			if (suspended) await scheduler.resume(this.self.rootId, this.self.id, this.limits.maxConcurrent, signal);
			for (const agent of unique) {
				agent.waiters -= 1;
				let notified = false;
				for (const input of agent.record.inputs) {
					if (!ended(input) || input.notified) continue;
					if (returned) input.notified = notified = true;
					else this.notifyLater(agent, input);
				}
				if (notified) this.persist(agent);
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

	/**
	 * Stops the current turn and withdraws queued inputs; returns whether there was anything to stop.
	 * A turn that has not stopped by `deadline` is abandoned: its inputs end as aborted, and this throws.
	 * `silent` marks an abort by the owner, which is not notified of the inputs it ends.
	 */
	async abort(agent: Owned, { silent = false, deadline = Date.now() + SHUTDOWN_TIMEOUT_MS } = {}): Promise<boolean> {
		const turn = agent.turn;
		if (!turn && agent.queue.length === 0) return false;
		if (silent) for (const input of [...agent.queue, ...(turn?.inputs ?? [])]) input.silent = true;
		for (const input of agent.queue.splice(0)) this.end(agent, input, "aborted", "");
		this.changed();
		if (turn) {
			turn.abort.abort();
			const stopping = (async () => {
				if (turn.started && agent.session) {
					agent.session.abortCompaction();
					agent.session.abortRetry();
					await agent.session.abort();
				}
				await turn.done.promise;
			})();
			if (!await settlesBy(stopping, deadline)) {
				this.finish(agent, turn, { outcome: "aborted", result: "" });
				throw new Error(`Agent ${label(agent.record, this.ids())} did not stop within the timeout and may still be running.`);
			}
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
				input.result = "The process exited before this input ended.";
				input.notified = true;
			}
			this.persist(agent);
		}
	}

	/** Takes the Agents offline; aborting and shutting down share one timeout, after which work is abandoned and this throws. */
	async shutdown(): Promise<void> {
		this.closing = true;
		const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
		const agents = [...this.agents.values()];
		const aborted = await Promise.allSettled(agents.map((agent) => this.abort(agent, { deadline })));
		const closed = await Promise.allSettled(agents.map(async (agent) => {
			const session = agent.session ?? await agent.loading?.catch(() => undefined);
			if (!session) return;
			try {
				if (!await settlesBy(session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }), deadline)) {
					throw new Error(`Agent ${label(agent.record, this.ids())} did not shut down within the timeout and may still be running.`);
				}
			} finally {
				session.dispose();
				agent.session = undefined;
			}
		}));
		const errors = [...aborted, ...closed].flatMap((result) => result.status === "rejected" ? [result.reason] : []);
		if (errors.length > 0) throw new Error(errors.map((error) => error instanceof Error ? error.message : String(error)).join("\n"));
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
		const queued = !agent.turn && !scheduler.hasCapacity(this.self.rootId, this.limits.maxConcurrent);
		agent.queue.push(input);
		this.persist(agent);
		this.changed();
		this.pump(agent);
		return queued;
	}

	/** A steer joins the current turn; other inputs queue. Returns whether the input waits for a slot. */
	private add(agent: Owned, input: Input, delivery: "followUp" | "steer"): boolean {
		if (delivery !== "steer" || !agent.turn) return this.enqueue(agent, input);
		this.join(agent, agent.turn, input);
		return false;
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
		const turn: Turn = { inputs: [head], pending: [], abort: new AbortController(), started: false, slot: false, finished: false, done: deferred() };
		agent.turn = turn;
		void this.runTurn(agent, turn);
	}

	private async runTurn(agent: Owned, turn: Turn): Promise<void> {
		let answer: { outcome: Outcome; result: string } = { outcome: "aborted", result: "" };
		try {
			await scheduler.acquireQueued(this.self.rootId, agent.record.id, this.limits.maxConcurrent, turn.abort.signal);
			turn.slot = true;
			const session = await this.load(agent);
			turn.abort.signal.throwIfAborted();
			const before = session.getSessionStats().assistantMessages;
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
					if (message.details.delivery === "write") await session.sendCustomMessage(message, { triggerTurn: false });
				}
				batch = [
					...turn.pending.splice(0),
					...leftover.flatMap(({ content, details }) => details.delivery === "write" ? [] : [{ text: content, user: details.user }]),
				];
			}
			const last = lastAnswer(session, before);
			answer = !turn.abort.signal.aborted ? last : { outcome: "aborted", result: last.outcome === "failed" ? "" : last.result };
		} catch (error) {
			if (!turn.abort.signal.aborted) answer = { outcome: "failed", result: error instanceof Error ? error.message : String(error) };
		} finally {
			this.finish(agent, turn, answer);
		}
	}

	/** Ends a turn once: when it returns, or when an abort abandons it. */
	private finish(agent: Owned, turn: Turn, answer: { outcome: Outcome; result: string }): void {
		if (turn.finished) return;
		turn.finished = true;
		if (turn.slot) scheduler.release(this.self.rootId, agent.record.id);
		if (agent.turn === turn) agent.turn = undefined;
		for (const input of turn.inputs) this.end(agent, input, answer.outcome, answer.result);
		turn.done.resolve();
		this.changed();
		this.pump(agent);
	}

	private end(agent: Owned, input: Input, outcome: Outcome, result: string): void {
		if (input.permit) scheduler.releaseOutstanding(this.self.rootId, input.permit);
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
		if (input.silent) record.notified = true;
		this.persist(agent);
		input.done?.resolve();
		if (agent.waiters === 0 && !input.silent) this.notifyLater(agent, record);
	}

	private notifyLater(agent: Owned, record: InputRecord): void {
		if (this.program) return;
		// The tree stays busy until the notification is delivered.
		const release = trackTreeWork(this.self.rootId);
		queueMicrotask(() => {
			try {
				if (this.closing || record.notified || agent.waiters > 0) return;
				record.notified = true;
				this.persist(agent);
				this.notify(`Agent ${label(agent.record, this.ids())} ${record.state}.`);
			} finally {
				release();
			}
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
		const suspended = this.self.ownerId !== undefined && scheduler.suspend(this.self.rootId, this.self.id);
		try {
			return await work();
		} finally {
			if (suspended) await scheduler.resume(this.self.rootId, this.self.id, this.limits.maxConcurrent, signal);
		}
	}

	private agent(id: string): Owned {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Agent ${id} is not owned by ${this.self.id}.`);
		// Inputs after shutdown would never run.
		if (this.closing) throw new Error(`Agent ${label(agent.record, this.ids())} is offline.`);
		return agent;
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
		const permit = scheduler.reserveOutstanding(this.self.rootId, this.limits.maxOutstanding);
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
