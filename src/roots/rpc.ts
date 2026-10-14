/**
 * `pd --mode rpc`, `-p`, and `--mode json` clients of a root Session: Pi's RPC commands on the
 * Session's own runtime, which an attached terminal uses too. Relies on private members of
 * `AgentSession` and `ExtensionRunner`; check them when Pi is updated.
 */
import { ExtensionEditorComponent, getPackageDir, SessionManager, type AgentSession, type ExtensionRunner, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Patchable = Record<PropertyKey, any>;

export interface RpcChannel {
	signal: AbortSignal;
	send(value: object): void;
	onMessage(listener: (value: any) => void): void;
}

/** The host Pi runs in, as dialogs see it. */
export interface DialogHost {
	attached(): boolean;
	onChange(listener: () => void): () => void;
}

/** A `-p` or `--mode json` client's prompts, which run back to back once the Session is idle. */
interface Job {
	channel: RpcChannel;
	prompts: { message: string; images?: unknown[] }[];
	stopped: boolean;
	/** The job's prompts being admitted. */
	admitting: number;
	/** Resolves once the job's turns end. */
	ended: Promise<void>;
	end(): void;
}

/** How one Session admits prompts. */
interface Lane {
	/** Prompts being admitted, until each starts, queues, or fails. */
	admitting: number;
	changed: Set<() => void>;
	/** The job whose turns are running; until they end, no other prompt starts a turn. */
	holder?: Job;
	/** Runs that wait for the holder to end. */
	deferred: number;
	waiting: Job[];
	draining: boolean;
}

// Shared across extension reloads: the prototypes are patched once.
const shared: {
	patched: boolean;
	sessions: WeakMap<object, AgentSession>;
	forwards: WeakMap<object, (record: object) => void>;
	lanes: WeakMap<object, Lane>;
	host?: DialogHost;
	/** Admits a prompt of `job`'s; prompts made while it runs, as by extensions, are part of the job. */
	admit?: (session: AgentSession, job: Job, text: string, options: Patchable) => Promise<void>;
} = (globalThis as Patchable)[Symbol.for("pi-agents.rpc")] ??= { patched: false, sessions: new WeakMap(), forwards: new WeakMap(), lanes: new WeakMap() };

function lane(session: object): Lane {
	let current = shared.lanes.get(session);
	if (!current) shared.lanes.set(session, current = { admitting: 0, changed: new Set(), deferred: 0, waiting: [], draining: false });
	return current;
}

/**
 * Dialogs wait for an attached terminal: without one they are cancelled at once, and an open one is
 * cancelled when its terminal detaches. Status, widgets, titles, notifications, and editor text also
 * reach the RPC clients.
 */
function sharedUI(ui: Patchable, manager: object): Patchable {
	const forward = (record: object) => shared.forwards.get(manager)?.(record);
	const dialog = <T>(cancelled: T, show: (signal: AbortSignal) => Promise<T>): Promise<T> => {
		const host = shared.host;
		if (!host) return show(new AbortController().signal);
		if (!host.attached()) return Promise.resolve(cancelled);
		const controller = new AbortController();
		const stop = host.onChange(() => { if (!host.attached()) controller.abort(); });
		return show(controller.signal).finally(stop);
	};
	const either = (signal: AbortSignal, other?: AbortSignal) => other ? AbortSignal.any([signal, other]) : signal;
	return {
		...ui,
		select: (title: string, options: string[], opts?: Patchable) =>
			dialog(undefined, (signal) => ui.select(title, options, { ...opts, signal: either(signal, opts?.signal) })),
		confirm: (title: string, message: string, opts?: Patchable) =>
			dialog(false, (signal) => ui.confirm(title, message, { ...opts, signal: either(signal, opts?.signal) })),
		input: (title: string, placeholder?: string, opts?: Patchable) =>
			dialog(undefined, (signal) => ui.input(title, placeholder, { ...opts, signal: either(signal, opts?.signal) })),
		// Pi's editor dialog, shown as a custom one so that it can be closed.
		editor: (title: string, prefill?: string) => dialog(undefined, (signal) =>
			ui.custom((tui: any, _theme: unknown, keybindings: any, done: (result: string | undefined) => void) => {
				signal.addEventListener("abort", () => done(undefined), { once: true });
				const command = shared.sessions.get(manager)?.settingsManager.getExternalEditorCommand();
				return new ExtensionEditorComponent(tui, keybindings, title, prefill, done, () => done(undefined), undefined, command);
			})),
		custom: (factory: (...args: any[]) => unknown, options?: unknown) => dialog(undefined, (signal) =>
			ui.custom((tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => {
				let cancelled = false;
				signal.addEventListener("abort", () => { cancelled = true; done(undefined); }, { once: true });
				// Pi drops a component that arrives after its dialog closed; it is disposed here instead.
				return Promise.resolve(factory(tui, theme, keybindings, done)).then((component: any) => {
					if (cancelled) component?.dispose?.();
					return component;
				});
			}, options)),
		notify(message: string, type?: string) {
			ui.notify(message, type);
			forward({ method: "notify", message, notifyType: type });
		},
		setStatus(key: string, text: string | undefined) {
			ui.setStatus(key, text);
			forward({ method: "setStatus", statusKey: key, statusText: text });
		},
		setWidget(key: string, content: unknown, options?: Patchable) {
			ui.setWidget(key, content, options);
			if (content === undefined || Array.isArray(content)) forward({ method: "setWidget", widgetKey: key, widgetLines: content, widgetPlacement: options?.placement });
		},
		setTitle(title: string) {
			ui.setTitle(title);
			forward({ method: "setTitle", title });
		},
		pasteToEditor(text: string) {
			ui.pasteToEditor(text);
			forward({ method: "set_editor_text", text });
		},
		setEditorText(text: string) {
			ui.setEditorText(text);
			forward({ method: "set_editor_text", text });
		},
	};
}

/** The `AgentSession` of the Session `manager` holds. */
export function agentSession(manager: object): AgentSession | undefined {
	return shared.sessions.get(manager);
}

/** Keeps each Session's `AgentSession`, and shares the terminal's UI with RPC clients. */
export function installRpcPatches(Session: typeof AgentSession, Runner: typeof ExtensionRunner, host: DialogHost | undefined): void {
	shared.host = host;
	if (shared.patched) return;
	shared.patched = true;
	const session = Session.prototype as Patchable;
	const bind = session.bindExtensions;
	session.bindExtensions = function (this: Patchable, ...args: unknown[]) {
		shared.sessions.set(this.sessionManager, this as AgentSession);
		// Pi runs what it defers until a run settles one at a time, in that run's context; each keeps the context it
		// was deferred in. One that is not part of the job holding the Session waits for it apart, so that the job's
		// own run next does not wait for the job to end.
		const deferred: Patchable = this._deferredSettledActions;
		deferred.push = (...actions: (() => Promise<unknown>)[]) => Array.prototype.push.apply(deferred, actions.map((action) => {
			const store = admitting.getStore();
			const bound = AsyncResource.bind(action);
			return () => {
				const holder = lane(this).holder;
				if (!holder || (store?.session === this && store.job === holder)) return bound();
				bound().catch((e: unknown) => this.extensionRunner.emitError({ extensionPath: "<runtime>", event: "agent_settled", error: e instanceof Error ? e.message : String(e) }));
			};
		}));
		return bind.apply(this, args);
	};
	// Prompts from the terminal and RPC clients are admitted one at a time, until each starts, queues, or
	// fails: two that both find the Session idle would both start. A prompt made while one is being
	// admitted, as by its extension command, is part of it.
	const prompt = session.prompt;
	const admissions = new WeakMap<object, Promise<void>>();
	const admitting = new AsyncLocalStorage<{ session: object; active: boolean; job?: Job }>();
	const admit = (self: AgentSession, store: { session: object; active: boolean; job?: Job }, text: string, options?: Patchable) => {
		const current = lane(self);
		current.admitting++;
		if (store.job) store.job.admitting++;
		const admitted = () => {
			if (!store.active) return;
			store.active = false;
			current.admitting--;
			if (store.job) store.job.admitting--;
			for (const listener of current.changed) listener();
		};
		return admitting.run(store, () => prompt.call(self, text, {
			...options,
			preflightResult: (disposition: string) => {
				admitted();
				options?.preflightResult?.(disposition);
			},
		})).finally(admitted);
	};
	shared.admit = (self, job, text, options) => admit(self, { session: self, active: true, job }, text, options);
	session.prompt = async function (this: AgentSession, text: string, options?: Patchable) {
		const store = admitting.getStore();
		if (store?.session === this && store.active) return admit(this, { session: this, active: true, job: store.job }, text, options);
		const current = lane(this);
		if (store?.session === this && store.job && store.job === current.holder) return shared.admit!(this, store.job, text, options ?? {});
		// Between a job's turns, a prompt that would start a turn waits until they end, letting later prompts in.
		const blocked = () => current.holder && !this.isStreaming;
		for (;;) {
			while (blocked()) await current.holder!.ended;
			let admitted!: () => void;
			const turn = new Promise<void>((resolve) => { admitted = resolve; });
			const previous = admissions.get(this) ?? Promise.resolve();
			admissions.set(this, previous.then(() => turn));
			await previous;
			if (blocked()) {
				admitted();
				continue;
			}
			try {
				return await admit(this, { session: this, active: true }, text, {
					...options,
					preflightResult: (disposition: string) => {
						admitted();
						options?.preflightResult?.(disposition);
					},
				});
			} finally {
				admitted();
			}
		}
	};
	// While a job holds the Session, a run that is not part of it, as one an input hook delayed past the job's turn
	// or an Agent's message started, waits until the job ends; a run started by then takes its messages as follow-ups.
	// Pi 1.2 starts runs with `_startRun(trigger, onStarted)`, which prepares the messages itself; Pi 1.1 with
	// `_runAgentPrompt(messages)`.
	const waitForJob = async (self: Patchable): Promise<boolean> => {
		const current = lane(self);
		const store = admitting.getStore();
		if (!current.holder || (store?.session === self && store.job === current.holder)) return false;
		current.deferred++;
		try {
			while (current.holder) await current.holder.ended;
		} finally {
			current.deferred--;
		}
		return true;
	};
	const followUp = (self: Patchable, messages: unknown) => [messages].flat().forEach((message) => self.agent.followUp(message));
	if (typeof session._startRun === "function") {
		const startRun = session._startRun;
		session._startRun = async function (this: Patchable, trigger: unknown, onStarted?: () => void) {
			if (await waitForJob(this)) {
				if (this._isEmittingAgentSettled) return void this._deferredSettledActions.push(() => this._startRun(trigger, onStarted));
				if (this.isStreaming) {
					const messages = await this._prepareRun(trigger);
					onStarted?.();
					return void followUp(this, messages);
				}
			}
			return startRun.call(this, trigger, onStarted);
		};
	} else {
		const runAgentPrompt = session._runAgentPrompt;
		session._runAgentPrompt = async function (this: Patchable, messages: unknown) {
			if (await waitForJob(this)) {
				if (this._isEmittingAgentSettled) return void this._deferredSettledActions.push(() => this._runAgentPrompt(messages));
				if (this.isStreaming) return void followUp(this, messages);
			}
			return runAgentPrompt.call(this, messages);
		};
	}
	const runner = Runner.prototype as Patchable;
	const setUIContext = runner.setUIContext;
	runner.setUIContext = function (this: Patchable, ui: Patchable | undefined, mode: string) {
		return setUIContext.call(this, ui && mode === "tui" ? sharedUI(ui, this.sessionManager) : ui, mode);
	};
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return (content as Patchable[]).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
}

/**
 * Writes a new Session beside `manager`'s, as Pi's new Session, fork, and clone do, without moving this
 * Session's runtime to it: the branch up to `leafId`, or an empty Session without one.
 */
function branch(manager: SessionManager, leafId: string | null, parentSession: string | undefined): string {
	const copy = SessionManager.inMemory(manager.getCwd(), undefined, leafId ? [manager.getHeader()!, ...manager.getEntries()] : undefined);
	if (leafId) copy.createBranchedSession(leafId);
	const header = { ...copy.getHeader()!, parentSession };
	const file = join(manager.getSessionDir(), `${header.timestamp.replace(/[:.]/g, "-")}_${header.id}.jsonl`);
	writeFileSync(file, [header, ...copy.getEntries()].map((entry) => `${JSON.stringify(entry)}\n`).join(""), { flag: "wx" });
	return file;
}

let toJsonEvent: ((event: unknown) => object) | undefined;

/**
 * Resolves once `session` has no turn or compaction, and no prompt of `job`'s being admitted. Without `job`, no
 * prompt may be admitted, nor a run wait for the previous job to end; `claim` runs at that moment.
 */
function whenSettled(session: Patchable, job: Job | undefined, claim?: () => void): Promise<void> {
	const current = lane(session);
	const settled = () => session.isIdle && !session._isEmittingAgentSettled && (job ? job.admitting === 0 : current.admitting === 0 && current.deferred === 0);
	return new Promise((resolve) => {
		let done = false;
		// The Session's state changes after its events and admissions, so it is checked once they finish.
		const check = () => setImmediate(() => {
			if (done || !settled()) return;
			done = true;
			unsubscribe();
			current.changed.delete(check);
			clearInterval(timer);
			claim?.();
			resolve();
		});
		const unsubscribe = session.subscribe(check);
		current.changed.add(check);
		const timer = setInterval(check, 100);
		check();
	});
}

/** Runs the waiting jobs of `session` one at a time, each once the Session is settled. */
async function drain(session: Patchable, current: Lane): Promise<void> {
	if (current.draining) return;
	current.draining = true;
	try {
		while (current.waiting.length > 0) {
			let job: Job | undefined;
			await whenSettled(session, undefined, () => { job = current.holder = current.waiting.shift(); });
			if (job) await run(session, job);
		}
	} finally {
		current.draining = false;
	}
}

/** Stops the run or compaction in progress; each run of a stopped job is aborted once it starts. */
function stopTurn(session: Patchable): void {
	if (session.isStreaming ? !session._agentRunAbortRequested : session.isCompacting) void session.abort().catch(() => undefined);
}

/** Runs `job`'s prompts back to back, sending it the Session's events until they end. */
async function run(session: Patchable, job: Job): Promise<void> {
	let error: string | undefined;
	const unsubscribe = session.subscribe((event: unknown) => {
		job.channel.send({ event: toJsonEvent!(event) });
		if (job.stopped) stopTurn(session);
	});
	try {
		job.channel.send({ start: true });
		for (const { message, images } of job.prompts) {
			if (job.stopped || job.channel.signal.aborted) break;
			for (;;) {
				try {
					// A turn started meanwhile, as by an Agent's message, takes the prompt as a follow-up.
					await new Promise<void>((resolve, reject) => {
						shared.admit!(session as AgentSession, job, message, { images, source: "rpc", streamingBehavior: "followUp", preflightResult: () => resolve() }).then(resolve, reject);
					});
					break;
				} catch (e) {
					// Another client may have started a compaction before the prompt reached Pi.
					if (!session.isCompacting || job.stopped) throw e;
					await whenSettled(session, job);
				}
			}
			await whenSettled(session, job);
		}
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	} finally {
		unsubscribe();
		lane(session).holder = undefined;
		job.end();
		job.channel.send(error === undefined ? { end: true } : { end: true, error });
	}
}

/** The RPC clients of one root Session. */
export function createRpc() {
	const clients = new Set<RpcChannel>();
	const printers = new Set<RpcChannel>();
	let session: Patchable | undefined;
	let unsubscribe: (() => void) | undefined;

	const success = (id: unknown, command: string, data?: unknown) =>
		data === undefined ? { id, type: "response", command, success: true } : { id, type: "response", command, success: true, data };
	const error = (id: unknown, command: string, message: string) => ({ id, type: "response", command, success: false, error: message });
	const broadcast = (value: object) => { for (const client of clients) client.send(value); };

	// Pi's RPC mode, with `switch_session` left to the client, which moves to the other Session, and
	// `new_session`, `fork`, and `clone` creating the Session for the client to move to.
	async function run(command: Patchable, reply: (value: object) => void): Promise<object | undefined> {
		const current = session!;
		const id = command.id;
		switch (command.type) {
			case "prompt": {
				let preflightSucceeded = false;
				void current.prompt(command.message, {
					images: command.images,
					streamingBehavior: command.streamingBehavior,
					source: "rpc",
					preflightResult: (disposition: string) => {
						preflightSucceeded = true;
						reply(success(id, "prompt", { disposition }));
					},
				}).catch((e: Error) => { if (!preflightSucceeded) reply(error(id, "prompt", e.message)); });
				return undefined;
			}
			case "steer":
				return success(id, "steer", { disposition: await current.steer(command.message, command.images, { source: "rpc" }) });
			case "follow_up":
				return success(id, "follow_up", { disposition: await current.followUp(command.message, command.images, { source: "rpc" }) });
			case "abort":
				await current.abort();
				return success(id, "abort");
			case "clear_queue":
				return success(id, "clear_queue", current.clearQueue());
			case "get_state":
				return success(id, "get_state", {
					model: current.model,
					thinkingLevel: current.thinkingLevel,
					isStreaming: current.isStreaming,
					isCompacting: current.isCompacting,
					steeringMode: current.steeringMode,
					followUpMode: current.followUpMode,
					sessionFile: current.sessionFile,
					sessionId: current.sessionId,
					sessionName: current.sessionName,
					autoCompactionEnabled: current.autoCompactionEnabled,
					messageCount: current.messages.length,
					pendingMessageCount: current.pendingMessageCount,
				});
			case "set_model": {
				const model = current.modelRuntime.getAvailableSnapshot().find((m: Patchable) => m.provider === command.provider && m.id === command.modelId);
				if (!model) return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				await current.setModel(model);
				return success(id, "set_model", model);
			}
			case "cycle_model":
				return success(id, "cycle_model", (await current.cycleModel()) ?? null);
			case "get_available_models":
				return success(id, "get_available_models", { models: current.modelRuntime.getAvailableSnapshot() });
			case "set_thinking_level":
				current.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			case "cycle_thinking_level": {
				const level = current.cycleThinkingLevel();
				return success(id, "cycle_thinking_level", level ? { level } : null);
			}
			case "get_available_thinking_levels":
				return success(id, "get_available_thinking_levels", { levels: current.getAvailableThinkingLevels() });
			case "set_steering_mode":
				current.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			case "set_follow_up_mode":
				current.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			case "compact":
				return success(id, "compact", await current.compact(command.customInstructions));
			case "set_auto_compaction":
				current.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			case "set_auto_retry":
				current.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			case "abort_retry":
				current.abortRetry();
				return success(id, "abort_retry");
			case "bash": {
				const eventResult = await current.extensionRunner.emitUserBash({
					type: "user_bash",
					command: command.command,
					excludeFromContext: command.excludeFromContext ?? false,
					cwd: current.sessionManager.getCwd(),
				});
				if (eventResult?.result) {
					current.recordBashResult(command.command, eventResult.result, { excludeFromContext: command.excludeFromContext });
					return success(id, "bash", eventResult.result);
				}
				return success(id, "bash", await current.executeBash(command.command, undefined, {
					excludeFromContext: command.excludeFromContext, id, operations: eventResult?.operations,
				}));
			}
			case "abort_bash":
				current.abortBash();
				return success(id, "abort_bash");
			case "get_session_stats":
				return success(id, "get_session_stats", current.getSessionStats());
			case "export_html":
				return success(id, "export_html", { path: await current.exportToHtml(command.outputPath) });
			case "new_session":
				return success(id, "new_session", { cancelled: false, sessionFile: branch(current.sessionManager, null, command.parentSession) });
			case "fork": {
				const entry = current.sessionManager.getEntry(command.entryId);
				if (entry?.type !== "message" || entry.message.role !== "user") throw new Error("Invalid entry ID for forking");
				return success(id, "fork", { text: textOf(entry.message.content), cancelled: false, sessionFile: branch(current.sessionManager, entry.parentId, current.sessionFile) });
			}
			case "clone": {
				const leafId = current.sessionManager.getLeafId();
				if (!leafId) return error(id, "clone", "Cannot clone session: no current entry selected");
				return success(id, "clone", { cancelled: false, sessionFile: branch(current.sessionManager, leafId, current.sessionFile) });
			}
			case "get_fork_messages":
				return success(id, "get_fork_messages", { messages: current.getUserMessagesForForking() });
			case "get_entries": {
				let entries = current.sessionManager.getEntries();
				if (command.since !== undefined) {
					const sinceIndex = entries.findIndex((e: Patchable) => e.id === command.since);
					if (sinceIndex === -1) return error(id, "get_entries", `Entry not found: ${command.since}`);
					entries = entries.slice(sinceIndex + 1);
				}
				return success(id, "get_entries", { entries, leafId: current.sessionManager.getLeafId() });
			}
			case "get_tree":
				return success(id, "get_tree", { tree: current.sessionManager.getTree(), leafId: current.sessionManager.getLeafId() });
			case "get_last_assistant_text":
				return success(id, "get_last_assistant_text", { text: current.getLastAssistantText() });
			case "set_session_name": {
				const name = command.name.trim();
				if (!name) return error(id, "set_session_name", "Session name cannot be empty");
				current.setSessionName(name);
				return success(id, "set_session_name");
			}
			case "get_messages":
				return success(id, "get_messages", { messages: current.messages });
			case "get_commands": {
				const commands = [
					...current.extensionRunner.getRegisteredCommands().map((c: Patchable) => ({ name: c.invocationName, description: c.description, source: "extension", sourceInfo: c.sourceInfo })),
					...current.promptTemplates.map((t: Patchable) => ({ name: t.name, description: t.description, source: "prompt", sourceInfo: t.sourceInfo })),
					...current.resourceLoader.getSkills().skills.map((s: Patchable) => ({ name: `skill:${s.name}`, description: s.description, source: "skill", sourceInfo: s.sourceInfo })),
				];
				return success(id, "get_commands", { commands });
			}
			default:
				return error(id, command.type, `Unknown command: ${command.type}`);
		}
	}

	async function handle(channel: RpcChannel, command: Patchable): Promise<void> {
		// Dialogs are not sent to RPC clients, so there is nothing to answer.
		if (command?.type === "extension_ui_response") return;
		const reply = (value: object) => channel.send(value);
		try {
			const response = await run(command, reply);
			if (response) reply(response);
		} catch (e) {
			reply(error(command?.id, command?.type, e instanceof Error ? e.message : String(e)));
		}
	}

	return {
		/** Loads the Pi module that turns events into RPC records. */
		async prepare(): Promise<void> {
			toJsonEvent ??= (await import(pathToFileURL(join(getPackageDir(), "dist/modes/json-event.js")).href)).toJsonEvent;
		},

		/** Connects a client to the Session `manager` holds; resolves to the Session's header. */
		open(manager: ExtensionContext["sessionManager"], channel: RpcChannel): { header: unknown } {
			const current = shared.sessions.get(manager);
			if (!current || !toJsonEvent) throw new Error("The Session is not ready.");
			if (session !== current) {
				unsubscribe?.();
				session = current;
				unsubscribe = current.subscribe((event) => broadcast(toJsonEvent!(event)));
				shared.forwards.set(manager, (record) => broadcast({ type: "extension_ui_request", id: randomUUID(), ...record }));
			}
			clients.add(channel);
			channel.signal.addEventListener("abort", () => clients.delete(channel), { once: true });
			channel.onMessage((command) => void handle(channel, command));
			return { header: manager.getHeader() };
		},

		/**
		 * Connects a `-p` or `--mode json` client to the Session `manager` holds; resolves to the Session's header.
		 * Its `run` command queues its prompts, and `stop` withdraws them or stops their turn.
		 */
		print(manager: ExtensionContext["sessionManager"], channel: RpcChannel): { header: unknown } {
			const current = shared.sessions.get(manager) as Patchable | undefined;
			if (!current || !toJsonEvent) throw new Error("The Session is not ready.");
			const queue = lane(current);
			let job: Job | undefined;
			const withdraw = () => {
				const at = job ? queue.waiting.indexOf(job) : -1;
				if (at < 0) return false;
				queue.waiting.splice(at, 1);
				return true;
			};
			printers.add(channel);
			// A client that is gone withdraws its prompts that have not started; its running turn goes on.
			channel.signal.addEventListener("abort", () => {
				printers.delete(channel);
				withdraw();
			}, { once: true });
			channel.onMessage((command) => {
				if (command?.type === "run" && !job) {
					let end!: () => void;
					const ended = new Promise<void>((resolve) => { end = resolve; });
					job = { channel, prompts: command.prompts, stopped: false, admitting: 0, ended, end };
					queue.waiting.push(job);
					void drain(current, queue);
				} else if (command?.type === "stop" && job && !job.stopped) {
					job.stopped = true;
					if (withdraw()) channel.send({ end: true });
					else if (queue.holder === job) stopTurn(current);
				}
			});
			return { header: manager.getHeader() };
		},

		clients: () => clients.size + printers.size,

		close(): void {
			unsubscribe?.();
			unsubscribe = undefined;
			if (session) shared.forwards.delete(session.sessionManager);
			session = undefined;
			clients.clear();
		},
	};
}
