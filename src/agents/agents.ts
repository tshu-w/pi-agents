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
import { boundText } from "../output.ts";
import {
	customMessage,
	deliver,
	messageParts,
	type NotifiedResult,
	addProgramSpend,
	addSpend,
	label,
	messageText,
	MESSAGE_TYPE,
	nodes,
	resolveTarget,
	scheduler,
	sender,
	shortId,
	TREE_ENTRY,
	trackTreeWork,
	treeChanged,
	visibleIds,
	type AgentState,
	type Delivery,
	type Sender,
	type Entry,
	type Notice,
	type Spend,
	type TreeMetadata,
} from "./registry.ts";
import { releaseSession } from "../roots/guard.mjs";
import { defaultSessionDir, sessionDir as rootSessionDir } from "../roots/paths.mjs";

const AGENT_ENTRY = "pi-agents-agent";
const SHUTDOWN_TIMEOUT_MS = 10_000;
const EXTENSION_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));
export const SUBMIT_RESULT_TOOL_NAME = "submit_result";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

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
}

export interface AgentRecord {
	id: string;
	name: string;
	sessionFile: string;
	cwd: string;
	createdAt: string;
	inputs: InputRecord[];
}


function childSessionDirectory(cwd: string, currentCwd: string, currentSessionDir: string, agentDir: string): string {
	const targetDefault = defaultSessionDir(cwd, agentDir);
	if (!currentSessionDir) return path.join(targetDefault, "subagents");
	const current = path.resolve(currentSessionDir);
	const currentDefault = defaultSessionDir(currentCwd, agentDir);
	if (current === currentDefault ||
		(path.basename(current) === "subagents" && path.dirname(current) === currentDefault)) {
		return path.join(targetDefault, "subagents");
	}
	return path.basename(current) === "subagents" ? current : path.join(current, "subagents");
}

function writePreparedSession(sessionManager: SessionManager): string {
	const sessionFile = sessionManager.getSessionFile()!;
	mkdirSync(path.dirname(sessionFile), { recursive: true });
	// SessionManager flushes itself once it holds an assistant message (a forked context);
	// otherwise write the prepared entries so the Session can be reopened.
	if (!existsSync(sessionFile)) {
		const entries = [sessionManager.getHeader(), ...sessionManager.getEntries()];
		writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx" });
	}
	return sessionFile;
}

function persistPreparedSession(sessionManager: SessionManager, cwd: string): SessionManager {
	const sessionFile = writePreparedSession(sessionManager);
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

/** Takes this extension's messages out of the agent queues. */
export function takeQueued(agent: AgentSession["agent"]) {
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

/** Whether a steer, which this turn must take in before its next model call, waits in the agent's queue; a write does not count. */
export function steerQueued(agent: AgentSession["agent"] | undefined): boolean {
	if (!agent) return false;
	const queue = (agent as unknown as { steeringQueue: { messages: QueuedMessage[] } }).steeringQueue.messages;
	return queue.some((message) => !(message.role === "custom" && message.customType === MESSAGE_TYPE
		&& (message as { details?: { delivery?: string } }).details?.delivery === "write"));
}

// Pi does not report steers queued by extensions, so a wait checks the queue this often.
export const STEER_POLL_MS = 250;

export const RESULT_TAG = "agent-result";

/** How a wait ended: what it waited for ended, its timeout expired, another message ended it, or it had nothing to wait for. */
export type WaitEnd = "completed" | "timedOut" | "interrupted" | "nothing";

/** The text `wait` returns, naming what it still waits for as `still` does. */
export function waitText(end: WaitEnd, still: string): string {
	if (end === "nothing") return "Nothing to wait for.";
	if (end === "completed") return "Wait completed.";
	return `${end === "timedOut" ? "Wait timed out." : "Wait interrupted by a new message."} ${still}`;
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
	/** The user's input from the task viewer. */
	user?: boolean;
	/** The Agent that sent it. */
	sender?: Sender;
	notice?: Notice;
	record?: InputRecord;
	permit?: symbol;
	schema?: unknown;
	submitted?: { value: unknown };
	done?: Deferred;
	/** Ended by the owner's abort, so the owner is not notified. */
	silent?: boolean;
}

type Message = Pick<Input, "text" | "user" | "sender" | "notice">;

interface Turn {
	inputs: Input[];
	/** Messages that joined after the turn started and still need delivery. */
	pending: Message[];
	abort: AbortController;
	started: boolean;
	/** Whether the turn holds a scheduler slot. */
	slot: boolean;
	/** When the turn got its slot, in milliseconds. */
	since?: number;
	/** What the turn's replies have cost. */
	spent: Spend;
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
	/** Its turn was stopped: messages from other Agents become writes until its owner's or user's next input. */
	stopped?: boolean;
}

export interface SpawnRequest {
	name: string;
	message: string;
	cwd?: string;
	context?: "fresh" | "fork";
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

/** A notification a wait holds; every wait for its Agent or Program holds it, and the first to end delivers it. */
interface HeldNotice {
	text: string;
	result: NotifiedResult;
	images?: NonNullable<Notice["images"]>;
	delivered?: boolean;
}

/** A wait in progress: the IDs of the Agents or Programs it waits for, and their notifications it holds. */
export interface Held {
	ids: Set<string>;
	notices: HeldNotice[];
}

/** Has the waits in progress for `id` hold a notification; returns whether any does. */
export function hold(waits: Held[], id: string, notice: HeldNotice): boolean {
	const holding = waits.filter(({ ids }) => ids.has(id));
	for (const wait of holding) wait.notices.push(notice);
	return holding.length > 0;
}

/** The notifications a wait holds that no other wait has delivered, as one notification, or undefined if none. */
export function release(wait: Held): { text: string; notice: Notice } | undefined {
	const notices = wait.notices.filter(({ delivered }) => !delivered);
	if (notices.length === 0) return undefined;
	for (const notice of notices) notice.delivered = true;
	const images = notices.flatMap((notice) => notice.images ?? []);
	return { text: notices.map(({ text }) => text).join("\n\n"), notice: { results: notices.map(({ result }) => result), ...(images.length ? { images } : {}) } };
}

export interface WaitOutcome {
	end: WaitEnd;
	pending: AgentRecord[];
}

/** The Agents owned by one loaded Agent. */
export class Agents {
	/** Waits in progress that keep this Agent's turn `waiting`. */
	waiting = 0;
	/** The notifications held by the waits in progress. */
	private held: Held[] = [];
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
			state: this.state(agent),
			sessionFile: agent.record.sessionFile,
			createdAt: agent.record.createdAt,
		}));
	}

	/** Whether an owned Agent has a turn or queued inputs. */
	live(): boolean {
		return [...this.agents.values()].some((agent) => agent.turn !== undefined || agent.queue.length > 0);
	}

	/** An owned Agent's state, its inputs pending behind its current or next turn, when its turn got a slot, and what the turn has cost. */
	counts(id: string): { state: AgentState; pending: number; since?: number; spent?: Spend } | undefined {
		const agent = this.agents.get(id);
		if (!agent) return undefined;
		return { state: this.state(agent), pending: agent.queue.length, since: agent.turn?.since, spent: agent.turn?.spent };
	}

	private state(agent: Owned): AgentState {
		if (!agent.turn) return "idle";
		if (!agent.turn.slot) return "queued";
		return (nodes.get(agent.record.id)?.agents.waiting ?? 0) > 0 ? "waiting" : "running";
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
		const self = { id: this.self.id, name: this.self.name() };
		const text = messageText(self, true, "followUp", request.message, this.ids());
		const queued = this.enqueue(agent, { text, sender: sender(self, this.ids()), permit, record: this.newRecord(agent) });
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
		};
		this.agents.set(agent.record.id, agent);
		return agent;
	}

	/**
	 * Sends an input from the owner, `from` as its text names it, and resolves when it ends. With a schema, the Agent must call
	 * `submit_result` with a matching value, which becomes the input's `value`; `text` tells it so.
	 * An input not ended within `timeoutMs` is aborted alone, and `timedOut` is set.
	 */
	async request(id: string, text: string, delivery: "followUp" | "steer", from: Sender, schema?: unknown, timeoutMs?: number): Promise<{ record: InputRecord; timedOut: boolean }> {
		const agent = this.agent(id);
		const input: Input = { text, sender: from, permit: this.reserve(), record: this.newRecord(agent), done: deferred() };
		if (schema !== undefined) input.schema = schema;
		this.add(agent, input, delivery);
		let stopping: Promise<void> | undefined;
		const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
			stopping = this.cancel(agent, input);
			stopping.catch(() => {});
		}, timeoutMs);
		try {
			await input.done!.promise;
		} finally {
			clearTimeout(timer);
		}
		await stopping;
		return { record: input.record!, timedOut: stopping !== undefined && input.record!.state === "aborted" };
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

	accept(id: string, text: string, delivery: Delivery, options: { fromOwner: boolean; notice?: Notice; sender?: Sender }): { queued: boolean } {
		const agent = this.agent(id);
		if (agent.stopped && !options.fromOwner) delivery = "write";
		if (delivery === "write") {
			this.write(agent, text, options.sender, options.notice);
			return { queued: false };
		}
		// Notifications keep their owner informed even at the input limit.
		const permit = options.notice ? undefined : this.reserve();
		const input: Input = { text, sender: options.sender, notice: options.notice, permit, record: options.fromOwner && !options.notice ? this.newRecord(agent) : undefined };
		return { queued: this.add(agent, input, delivery) };
	}

	/**
	 * Waits until `targets`, or the Agents with pending inputs, have none; a steer ends it early. Their notifications
	 * are held until it ends, then delivered as one.
	 */
	async wait(targets: Owned[] | undefined, timeoutSeconds: number, signal?: AbortSignal, steered?: () => boolean): Promise<WaitOutcome> {
		const unique = [...new Set(targets ?? [...this.agents.values()])].filter((agent) => this.pending(agent));
		if (unique.length === 0) return { end: "nothing", pending: [] };
		const held: Held = { ids: new Set(unique.map((agent) => agent.record.id)), notices: [] };
		this.held.push(held);
		const suspended = this.self.ownerId !== undefined && scheduler.suspend(this.self.rootId, this.self.id);
		this.markWaiting(1);
		let interrupted = false;
		try {
			const deadline = Date.now() + timeoutSeconds * 1000;
			while (unique.some((agent) => this.pending(agent))) {
				const remaining = deadline - Date.now();
				if (remaining <= 0) break;
				if (steered?.()) {
					interrupted = true;
					break;
				}
				signal?.throwIfAborted();
				await waitForChange(this.change.promise, steered ? Math.min(remaining, STEER_POLL_MS) : remaining, signal);
			}
			signal?.throwIfAborted();
			const pending = unique.filter((agent) => this.pending(agent)).map((agent) => agent.record);
			return { end: pending.length === 0 ? "completed" : interrupted ? "interrupted" : "timedOut", pending };
		} finally {
			this.held.splice(this.held.indexOf(held), 1);
			const released = this.closing ? undefined : release(held);
			if (released) this.notify(released.text, released.notice);
			this.markWaiting(-1);
			if (suspended) await scheduler.resume(this.self.rootId, this.self.id, this.limits.maxConcurrent, signal);
		}
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
		if (turn) await this.stop(agent, turn, deadline);
		return true;
	}

	/** Ends one input as aborted: withdraws it if queued, or else stops its turn, as `abort` does. */
	private async cancel(agent: Owned, input: Input): Promise<void> {
		const index = agent.queue.indexOf(input);
		if (index !== -1) {
			agent.queue.splice(index, 1);
			this.end(agent, input, "aborted", "");
			this.changed();
		} else if (agent.turn?.inputs.includes(input)) {
			await this.stop(agent, agent.turn, Date.now() + SHUTDOWN_TIMEOUT_MS);
		}
	}

	/** Stops a turn; one that has not stopped by `deadline` is abandoned: its inputs end as aborted, and this throws. */
	private async stop(agent: Owned, turn: Turn, deadline: number): Promise<void> {
		agent.stopped = true;
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

	restore(ctx: ExtensionContext): void {
		const records = new Map<string, AgentRecord>();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== AGENT_ENTRY) continue;
			const record = entry.data as AgentRecord;
			records.set(record.id, record);
		}
		for (const record of records.values()) {
			const agent: Owned = { record, queue: [] };
			this.agents.set(record.id, agent);
			if (!record.inputs.some((input) => !ended(input))) continue;
			for (const input of record.inputs) {
				if (ended(input)) continue;
				input.state = "aborted";
				input.result = "The process exited before this input ended.";
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
		const close = async (agent: Owned, session: AgentSession) => {
			try {
				if (!await settlesBy(session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }), deadline)) {
					throw new Error(`Agent ${label(agent.record, this.ids())} did not shut down within the timeout and may still be running.`);
				}
			} finally {
				session.dispose();
				agent.session = undefined;
			}
		};
		const closed = await Promise.allSettled(agents.map(async (agent) => {
			const loading = agent.loading;
			if (!agent.session && loading && !await settlesBy(loading, deadline)) {
				// A Session that loads after the timeout is closed once it does.
				void loading.then((late) => close(agent, late).catch(() => {}), () => {});
				throw new Error(`Agent ${label(agent.record, this.ids())} did not shut down within the timeout and may still be running.`);
			}
			const session = agent.session ?? await loading?.catch(() => undefined);
			if (session) await close(agent, session);
		}));
		const errors = [...aborted, ...closed].flatMap((result) => result.status === "rejected" ? [result.reason] : []);
		if (errors.length > 0) throw new Error(errors.map((error) => error instanceof Error ? error.message : String(error)).join("\n"));
	}

	private write(agent: Owned, text: string, from?: Sender, notice?: Notice): void {
		const message = customMessage(text, "write", { sender: from, notice });
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
		// While stopped, other senders' messages become writes, so this is the owner's or user's next input.
		agent.stopped = false;
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
			agent.session.agent.steer({ role: "custom", ...customMessage(input.text, "steer", { user: input.user, sender: input.sender, notice: input.notice }), timestamp: Date.now() });
		} else {
			turn.pending.push({ text: input.text, user: input.user, sender: input.sender, notice: input.notice });
		}
	}

	private pump(agent: Owned): void {
		if (agent.turn || this.closing) return;
		const head = agent.queue.shift();
		if (!head) return;
		const turn: Turn = { inputs: [head], pending: [], abort: new AbortController(), started: false, slot: false, spent: { cost: 0, tokens: 0, unpriced: false }, finished: false, done: deferred() };
		agent.turn = turn;
		void this.runTurn(agent, turn);
	}

	private async runTurn(agent: Owned, turn: Turn): Promise<void> {
		let answer: { outcome: Outcome; result: string } = { outcome: "aborted", result: "" };
		try {
			await scheduler.acquireQueued(this.self.rootId, agent.record.id, this.limits.maxConcurrent, turn.abort.signal);
			turn.slot = true;
			turn.since = Date.now();
			const session = await this.load(agent);
			turn.abort.signal.throwIfAborted();
			const before = session.getSessionStats().assistantMessages;
			turn.started = true;
			for (const input of turn.inputs) if (input.record) input.record.state = "running";
			this.persist(agent);
			this.changed();
			let batch: Message[] = turn.inputs.map(({ text, user, sender, notice }) => ({ text, user, sender, notice }));
			while (batch.length > 0 && !turn.abort.signal.aborted) {
				for (const { text, ...rest } of batch.slice(0, -1)) await session.sendCustomMessage(customMessage(text, "steer", rest), { triggerTurn: false });
				const { text, ...rest } = batch.at(-1)!;
				await session.sendCustomMessage(customMessage(text, "steer", rest), { triggerTurn: true });
				await session.waitForIdle();
				const leftover = takeQueued(session.agent);
				for (const message of leftover) {
					if (message.details.delivery === "write") await session.sendCustomMessage(message, { triggerTurn: false });
				}
				batch = [
					...turn.pending.splice(0),
					...leftover.flatMap((message) => message.details.delivery === "write" ? [] : [messageParts(message)]),
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
		this.persist(agent);
		input.done?.resolve();
		if (!input.silent) this.notifyLater(agent, record);
	}

	private notifyLater(agent: Owned, record: InputRecord): void {
		if (this.program) return;
		// The tree stays busy until the notification is delivered.
		const release = trackTreeWork(this.self.rootId);
		queueMicrotask(() => {
			try {
				if (this.closing) return;
				const { kept, notice } = boundText(record.result ?? "", "pi-agents-notification");
				const id = shortId(agent.record.id, this.ids());
				const text = `<${RESULT_TAG} name="${agent.record.name}" id="${id}" status="${record.state}">\n${kept}\n</${RESULT_TAG}>${notice ? `\n\n${notice}` : ""}`;
				const result = { name: agent.record.name, id, status: record.state, body: kept, ...(notice && { notice }) };
				if (!hold(this.held, agent.record.id, { text, result })) this.notify(text, { results: [result] });
			} finally {
				release();
			}
		});
	}

	/** Delivers a notification to this Agent as a steer. */
	notify(text: string, notice: Notice): void {
		try {
			deliver(undefined, { id: this.self.id, name: this.self.name(), ownerId: this.self.ownerId, cwd: "", state: "running" }, "steer", text, notice);
		} catch (error) {
			console.warn(`[pi-agents] notification failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Runs `work` while an owned caller gives up its slot, and takes one again before returning.
	 * `waiting` marks the caller as waiting meanwhile.
	 */
	async whileSuspended<T>(work: () => Promise<T>, signal?: AbortSignal, waiting = false): Promise<T> {
		const suspended = this.self.ownerId !== undefined && scheduler.suspend(this.self.rootId, this.self.id);
		if (waiting) this.markWaiting(1);
		try {
			return await work();
		} finally {
			if (waiting) this.markWaiting(-1);
			if (suspended) await scheduler.resume(this.self.rootId, this.self.id, this.limits.maxConcurrent, signal);
		}
	}

	private markWaiting(delta: number): void {
		this.waiting += delta;
		treeChanged();
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
		const record: InputRecord = { id: `${agent.record.id}:${agent.record.inputs.length + 1}`, state: "queued" };
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

	/** Creates the Session of a root Agent the caller does not own; a message to it starts it. */
	disown(request: Omit<SpawnRequest, "message" | "context">): { id: string; name: string } {
		const ctx = this.requireContext();
		const name = request.name.trim();
		const env = ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "env-state").pop();
		if (env?.type === "custom" && (env.data as { environment?: string | null }).environment) throw new Error("An Agent in a pi-env environment cannot disown an Agent.");
		const { model, thinkingLevel } = this.resolveModel(request);
		const cwd = path.resolve(ctx.cwd, request.cwd ?? ".");
		// Where Pi keeps the cwd's Sessions without `--session-dir`, which the daemon searches.
		const configured = path.resolve(rootSessionDir());
		const sessionDir = configured === path.resolve(this.agentDir, "sessions") ? defaultSessionDir(cwd, this.agentDir) : configured;
		const sessionManager = SessionManager.create(cwd, sessionDir);
		sessionManager.appendSessionInfo(name);
		sessionManager.appendModelChange(model.provider, model.id);
		sessionManager.appendThinkingLevelChange(thinkingLevel);
		try {
			writePreparedSession(sessionManager);
		} finally {
			// The Session runs in a process of its own.
			releaseSession(sessionManager);
		}
		return { id: sessionManager.getSessionId(), name };
	}

	private resolveModel(request: Pick<SpawnRequest, "model" | "thinkingLevel">): Pick<Prepared, "model" | "thinkingLevel"> {
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
		return { model, thinkingLevel: request.thinkingLevel ?? this.pi.getThinkingLevel() };
	}

	private prepare(request: Omit<SpawnRequest, "message">, name: string, id?: string): Prepared {
		const ctx = this.requireContext();
		const { model, thinkingLevel } = this.resolveModel(request);
		// In a pi-env execution environment, the Agent runs in the same environment and `cwd` is a path there.
		const envEntry = ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "env-state").pop();
		const envState = envEntry?.type === "custom" ? structuredClone(envEntry.data) as { environment?: string | null } : undefined;
		const envTarget = envState?.environment?.match(/^((?:docker|ssh):[^:]+):(.+)$/);
		if (envTarget && request.cwd !== undefined) envState!.environment = `${envTarget[1]}:${path.posix.resolve(envTarget[2], request.cwd)}`;
		const cwd = envTarget ? ctx.cwd : path.resolve(ctx.cwd, request.cwd ?? ".");
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
		if (envState) sessionManager.appendCustomEntry("env-state", envState);
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
		session.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			if (agent.turn) addSpend(agent.turn.spent, event.message.usage);
			addProgramSpend(this.self.id, event.message.usage);
		});
		return session;
	}
}
