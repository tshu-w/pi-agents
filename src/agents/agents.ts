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
	addProgramSpend,
	addSpend,
	label,
	messageText,
	MESSAGE_TYPE,
	nodes,
	OFFLINE_RESULT,
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
import { deferred, hold, settlesBy, waitFor, type Deferred, type Held, type WaitEnd } from "./wait.ts";
import { releaseSession } from "../roots/guard.mjs";
import { defaultSessionDir, sessionDir as rootSessionDir } from "../roots/paths.mjs";
import { readMailbox, updateMailbox } from "../roots/mailbox.ts";

const AGENT_ENTRY = "pi-agents-agent";
const INPUT_ENTRY = "pi-agents-input";
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
	/** Ended because its owner went offline. */
	offline?: boolean;
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

export const RESULT_TAG = "agent-result";

function ended(input: InputRecord): boolean {
	return input.state === "completed" || input.state === "failed" || input.state === "aborted";
}

interface Input {
	text: string;
	/** The user's input from the task viewer. */
	user?: boolean;
	/** How the user sent it, which the viewer shows while it is queued. */
	delivery?: "followUp" | "steer";
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
	/** The user's input sent while a turn stopped; it waits for the next turn without starting one. */
	held?: boolean;
}

type Message = Pick<Input, "text" | "user" | "sender" | "notice">;

interface Turn {
	inputs: Input[];
	/** Notifications of queued inputs an abort ended while the turn ran; they are sent with the turn's. */
	withheld: InputRecord[];
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
	/** Each input as last written to the owner's Session; set once the Agent's metadata is written. */
	persisted?: Map<string, string>;
}

export interface SpawnRequest {
	name: string;
	message: string;
	cwd?: string;
	context?: "fresh" | "fork";
	model?: string;
	thinkingLevel?: ThinkingLevel;
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

	constructor(
		private pi: ExtensionAPI,
		private self: { id: string; rootId: string; scopeId: string; ownerId?: string; name(): string | undefined },
		private ctx: ExtensionContext,
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
		if (manager && !agent.prepared) releaseSession(manager);
		return { messages: context?.messages ?? [], cwd: record.cwd, model: context?.model ?? undefined, thinkingLevel: context?.thinkingLevel };
	}

	/**
	 * Sends the user's input to an owned Agent, as from Pi's editor: it has no sender header and no
	 * result. `steer` joins the current turn, or starts one when the Agent is idle.
	 */
	prompt(id: string, text: string, delivery: "followUp" | "steer"): void {
		this.add(this.agent(id), { text, user: true, delivery, permit: this.reserve() }, delivery);
	}

	/**
	 * The user's inputs an owned Agent has not received, steers first, as Pi lists its queued messages. `withdraw` takes
	 * them out, as Pi's abort takes its queued messages back to the editor; `abortAgent` follows it.
	 */
	userQueue(id: string, withdraw = false): Array<{ text: string; delivery: "followUp" | "steer" }> {
		const agent = this.agents.get(id);
		if (!agent) return [];
		const turn = agent.turn;
		const queued = [...turn && !turn.started ? turn.inputs : [], ...agent.queue].filter((input) => input.user);
		const pending = turn?.pending.filter((message) => message.user) ?? [];
		const session = turn?.started ? agent.session?.agent : undefined;
		const queue = session && (session as unknown as { steeringQueue: { messages: QueuedMessage[] } }).steeringQueue.messages.slice();
		const user = (message: QueuedMessage) => message.role === "custom" && message.customType === MESSAGE_TYPE
			&& Boolean((message as { details?: { user?: boolean } }).details?.user);
		const steering = queue?.filter(user) ?? [];
		const joined = [...pending.map(({ text }) => text), ...steering.map((message) => messageParts(message as Parameters<typeof messageParts>[0]).text)];
		if (withdraw && queued.length + joined.length > 0) {
			// A steer that joined the turn ends with its input; the user's inputs differ only in their text.
			const ending = [...queued];
			for (const text of joined) {
				const input = turn!.inputs.find((input) => input.user && input.text === text && !ending.includes(input));
				if (input) ending.push(input);
			}
			if (turn) turn.inputs = turn.inputs.filter((input) => !ending.includes(input));
			agent.queue = agent.queue.filter((input) => !input.user);
			if (turn) turn.pending = turn.pending.filter((message) => !message.user);
			if (session && steering.length > 0) {
				session.clearSteeringQueue();
				for (const message of queue!) if (!user(message)) session.steer(message);
			}
			this.end(agent, ending, "aborted", "");
			this.changed();
		}
		// A user's input joins a started turn only as a steer.
		const inputs = [
			...queued.map(({ text, delivery }) => ({ text, delivery: delivery! })),
			...joined.map((text) => ({ text, delivery: "steer" as const })),
		];
		return [...inputs.filter(({ delivery }) => delivery === "steer"), ...inputs.filter(({ delivery }) => delivery === "followUp")];
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
		const suspended = this.self.ownerId !== undefined && scheduler.suspend(this.self.rootId, this.self.id);
		this.markWaiting(1);
		try {
			return await waitFor(
				{ waits: this.held, change: () => this.change.promise, closing: () => this.closing, notify: (text, notice) => this.notify(text, notice) },
				unique.map((agent) => agent.record.id),
				() => unique.filter((agent) => this.pending(agent)).map((agent) => agent.record),
				timeoutSeconds,
				signal,
				steered,
			);
		} finally {
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
		if (silent) {
			const inputs = [...agent.queue, ...(turn?.inputs ?? [])];
			for (const input of inputs) input.silent = true;
			// The owner is not told of them, even if its process exits before the turn stops.
			this.settle(inputs.flatMap((input) => input.record ? [input.record] : []));
		}
		this.end(agent, agent.queue.splice(0), "aborted", "", { withhold: turn?.withheld });
		this.changed();
		if (turn) await this.stop(agent, turn, deadline);
		return true;
	}

	/** Ends one input as aborted: withdraws it if queued, or else stops its turn, as `abort` does. */
	private async cancel(agent: Owned, input: Input): Promise<void> {
		const index = agent.queue.indexOf(input);
		if (index !== -1) {
			agent.queue.splice(index, 1);
			this.end(agent, [input], "aborted", "");
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
		// An Agent's metadata, then one entry per input change; older Sessions hold full records with their inputs.
		const records = new Map<string, AgentRecord>();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === AGENT_ENTRY) {
				const data = entry.data as Omit<AgentRecord, "inputs"> & { inputs?: InputRecord[] };
				records.set(data.id, { ...data, inputs: data.inputs ?? records.get(data.id)?.inputs ?? [] });
			} else if (entry.customType === INPUT_ENTRY) {
				const { agentId, ...input } = entry.data as InputRecord & { agentId: string };
				const inputs = records.get(agentId)?.inputs;
				if (!inputs) continue;
				const index = inputs.findIndex((candidate) => candidate.id === input.id);
				if (index === -1) inputs.push(input);
				else inputs[index] = input;
			}
		}
		for (const record of records.values()) {
			const agent: Owned = { record, queue: [], persisted: new Map(record.inputs.map((input) => [input.id, JSON.stringify(input)])) };
			this.agents.set(record.id, agent);
			if (!record.inputs.some((input) => !ended(input))) continue;
			for (const input of record.inputs) {
				if (ended(input)) continue;
				input.state = "aborted";
				input.result = "The process exited before this input ended.";
				input.offline = true;
			}
			this.persist(agent);
		}
	}

	/** Reports the inputs that ended because this Agent went offline in one notification, as a write. */
	reportOffline(): void {
		if (this.program) return;
		const inputs = readMailbox(this.self.id).outbox;
		if (inputs.length === 0) return;
		const ids = this.ids();
		const notices = inputs.map(({ id, agentId, name }) => {
			const short = shortId(agentId, ids);
			// An input that ended before, whose notification a wait held, keeps its result.
			const input = this.agents.get(agentId)?.record.inputs.find((candidate) => candidate.id === id);
			if (!input || input.offline) {
				return { text: `<${RESULT_TAG} name="${name}" id="${short}" status="aborted">\n${OFFLINE_RESULT}\n</${RESULT_TAG}>`, result: { name, id: short, status: "aborted", body: OFFLINE_RESULT } };
			}
			const { kept, notice, details } = boundText(input.result ?? "", "pi-agents-notification");
			return {
				text: `<${RESULT_TAG} name="${name}" id="${short}" status="${input.state}">\n${kept}\n</${RESULT_TAG}>${notice ? `\n\n${notice}` : ""}`,
				result: { name, id: short, status: input.state, body: kept, ...(notice && { notice }), ...details },
			};
		});
		this.pi.sendMessage(customMessage(notices.map(({ text }) => text).join("\n\n"), "write", { notice: { results: notices.map(({ result }) => result) } }), { deliverAs: "steer" });
		updateMailbox(this.self.id, (mailbox) => { mailbox.outbox = []; });
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
				// A Session that loads after the timeout is closed once it does, and its locks are released if it fails.
				void loading.then((late) => close(agent, late).catch(() => {}), () => {
					if (agent.prepared) releaseSession(agent.prepared.sessionManager);
				});
				throw new Error(`Agent ${label(agent.record, this.ids())} did not shut down within the timeout and may still be running.`);
			}
			const session = agent.session ?? await loading?.catch(() => undefined);
			if (session) await close(agent, session);
			else if (agent.prepared) releaseSession(agent.prepared.sessionManager);
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
		// As in Pi, the user's input while a turn stops stays queued for the next turn, and the turn stays stopped.
		if (input.user && agent.turn?.abort.signal.aborted) {
			input.held = true;
			agent.queue.push(input);
			this.changed();
			return false;
		}
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
		const head = agent.queue.find((input) => !input.held);
		if (!head) return;
		// Held steers go with the next turn, after its first input, as Pi delivers queued steers with its next run.
		const steers = agent.queue.filter((input) => input.held && input.delivery === "steer");
		agent.queue = agent.queue.filter((input) => input !== head && !steers.includes(input));
		for (const input of agent.queue) input.held = false;
		const turn: Turn = { inputs: [head, ...steers], withheld: [], pending: [], abort: new AbortController(), started: false, slot: false, spent: { cost: 0, tokens: 0, unpriced: false }, finished: false, done: deferred() };
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
		agent.turn = undefined;
		this.end(agent, turn.inputs, answer.outcome, answer.result, { withheld: turn.withheld });
		turn.done.resolve();
		this.changed();
		this.pump(agent);
	}

	/**
	 * Ends inputs together; those that end with the same state and result share one notification. `withhold` collects
	 * their notifications instead, and `withheld` adds notifications collected before.
	 */
	private end(agent: Owned, inputs: Input[], outcome: Outcome, result: string, { withhold, withheld = [] }: { withhold?: InputRecord[]; withheld?: InputRecord[] } = {}): void {
		const notices: InputRecord[] = [];
		const silenced: InputRecord[] = [];
		let changed = false;
		for (const input of inputs) {
			if (input.permit) scheduler.releaseOutstanding(this.self.rootId, input.permit);
			input.permit = undefined;
			const record = input.record;
			if (!record || ended(record)) continue;
			changed = true;
			record.state = outcome;
			record.result = result;
			if (this.closing) record.offline = true;
			if (input.schema !== undefined && outcome !== "aborted") {
				if (input.submitted) {
					record.state = "completed";
					record.value = input.submitted.value;
				} else if (outcome === "completed") {
					record.state = "failed";
					record.result = `The turn ended without calling ${SUBMIT_RESULT_TOOL_NAME}.`;
				}
			}
			input.done?.resolve();
			(input.silent ? silenced : notices).push(record);
		}
		if (changed) this.persist(agent);
		this.settle(silenced);
		if (withhold) {
			withhold.push(...notices);
			return;
		}
		const answers = new Map<string, InputRecord[]>();
		for (const record of [...notices, ...withheld]) {
			const key = JSON.stringify([record.state, record.result]);
			answers.set(key, [...answers.get(key) ?? [], record]);
		}
		for (const records of answers.values()) this.notifyLater(agent, records);
	}

	/** Notifies the owner of inputs that ended with the same state and result. */
	private notifyLater(agent: Owned, records: InputRecord[]): void {
		if (this.program) return;
		const record = records[0]!;
		// The tree stays busy until the notification is delivered.
		const release = trackTreeWork(this.self.rootId);
		queueMicrotask(() => {
			try {
				if (this.closing) return;
				const { kept, notice, details } = boundText(record.result ?? "", "pi-agents-notification");
				const id = shortId(agent.record.id, this.ids());
				const text = `<${RESULT_TAG} name="${agent.record.name}" id="${id}" status="${record.state}">\n${kept}\n</${RESULT_TAG}>${notice ? `\n\n${notice}` : ""}`;
				const result = { name: agent.record.name, id, status: record.state, body: kept, ...(notice && { notice }), ...details };
				// A held notification leaves the outbox once a wait delivers it.
				const settle = () => this.settle(records);
				if (!hold(this.held, agent.record.id, { text, result, settle }) && this.notify(text, { results: [result] })) settle();
			} finally {
				release();
			}
		});
	}

	/** Delivers a notification to this Agent as a steer; returns whether it was delivered. */
	notify(text: string, notice: Notice): boolean {
		try {
			deliver(undefined, { id: this.self.id, name: this.self.name(), ownerId: this.self.ownerId, cwd: "", state: "running" }, "steer", text, notice);
			return true;
		} catch (error) {
			console.warn(`[pi-agents] notification failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
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
		// Kept until its notification is delivered, so that an owner that went offline learns of it when loaded again.
		if (!this.program) updateMailbox(this.self.id, (mailbox) => { mailbox.outbox.push({ id: record.id, agentId: agent.record.id, name: agent.record.name }); });
		return record;
	}

	/** Forgets inputs that need no notification on the owner's next load. */
	private settle(records: InputRecord[]): void {
		if (this.program || records.length === 0) return;
		updateMailbox(this.self.id, (mailbox) => {
			const kept = mailbox.outbox.filter((input) => !records.some((record) => record.id === input.id));
			if (kept.length === mailbox.outbox.length) return false;
			mailbox.outbox = kept;
		});
	}

	private reserve(): symbol {
		const permit = scheduler.reserveOutstanding(this.self.rootId, this.limits.maxOutstanding);
		if (!permit) throw new Error(`Input rejected: ${this.limits.maxOutstanding} inputs have not ended. Wait for results or abort an Agent.`);
		return permit;
	}

	private persist(agent: Owned): void {
		if (this.program) return;
		if (this.closing && !agent.record.inputs.some((input) => !ended(input))) return;
		if (!agent.persisted) {
			const { inputs: _, ...metadata } = agent.record;
			this.pi.appendEntry(AGENT_ENTRY, metadata);
			agent.persisted = new Map();
		}
		for (const input of agent.record.inputs) {
			const json = JSON.stringify(input);
			if (agent.persisted.get(input.id) === json) continue;
			this.pi.appendEntry(INPUT_ENTRY, { agentId: agent.record.id, ...input });
			agent.persisted.set(input.id, json);
		}
	}

	private changed(): void {
		const previous = this.change;
		this.change = deferred();
		previous.resolve();
		treeChanged();
	}

	/** Creates the Session of a root Agent the caller does not own; a message to it starts it. */
	disown(request: Omit<SpawnRequest, "message" | "context">): { id: string; name: string } {
		const ctx = this.ctx;
		const name = request.name.trim();
		const env = ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "env-state").pop();
		if (env?.type === "custom" && (env.data as { environment?: string | null }).environment) throw new Error("An Agent in a pi-exec environment cannot disown an Agent.");
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
		const ctx = this.ctx;
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
		const ctx = this.ctx;
		const { model, thinkingLevel } = this.resolveModel(request);
		// In a pi-exec execution environment, the Agent runs in the same environment and `cwd` is a path there.
		const envEntry = ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "env-state").pop();
		const envState = envEntry?.type === "custom" ? structuredClone(envEntry.data) as { environment?: string | null } : undefined;
		const envTarget = envState?.environment?.match(/^((?:docker|ssh):[^:]+):(.+)$/);
		if (envTarget && request.cwd !== undefined) envState!.environment = `${envTarget[1]}:${path.posix.resolve(envTarget[2], request.cwd)}`;
		const cwd = envTarget ? ctx.cwd : path.resolve(ctx.cwd, request.cwd ?? ".");
		const sessionManager = SessionManager.create(cwd, childSessionDirectory(cwd, ctx.cwd, ctx.sessionManager.getSessionDir(), this.agentDir), {
			id: id ?? randomUUID(),
			parentSession: ctx.sessionManager.getSessionFile(),
		});
		try {
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
		} finally {
			// The reopened manager holds the locks while the Agent is online.
			releaseSession(sessionManager);
		}
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
		const ctx = this.ctx;
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
