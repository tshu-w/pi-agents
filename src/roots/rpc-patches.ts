/**
 * Patches of Pi internals that RPC clients of a root Session need: each Session's `AgentSession`, prompts admitted
 * one at a time, and the terminal's UI shared with the clients. Relies on private members of `AgentSession` and
 * `ExtensionRunner`; check them when Pi is updated.
 */
import { ExtensionEditorComponent, type AgentSession, type ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import type { RpcChannel } from "./rpc.ts";

type Patchable = Record<PropertyKey, any>;

/** The host Pi runs in, as dialogs see it. */
export interface DialogHost {
	attached(): boolean;
	onChange(listener: () => void): () => void;
}

/** A `-p` or `--mode json` client's prompts, which run back to back once the Session is idle. */
export interface Job {
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
export interface Lane {
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

export function lane(session: object): Lane {
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

/** Makes dialogs follow `host`, which the root Session reports to. */
export function setDialogHost(host: DialogHost): void {
	shared.host = host;
}

/** Keeps each Session's `AgentSession`, and shares the terminal's UI with RPC clients. */
export function installRpcPatches(Session: typeof AgentSession, Runner: typeof ExtensionRunner): void {
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
	// A run that need not wait starts at once: Pi marks the Session busy only when the run starts.
	const heldByOtherJob = (self: Patchable): boolean => {
		const current = lane(self);
		const store = admitting.getStore();
		return current.holder !== undefined && (store?.session !== self || store.job !== current.holder);
	};
	const waitForJob = async (self: Patchable): Promise<void> => {
		const current = lane(self);
		current.deferred++;
		try {
			while (current.holder) await current.holder.ended;
		} finally {
			current.deferred--;
		}
	};
	const startRun = session._startRun;
	session._startRun = async function (this: Patchable, trigger: Patchable, onStarted?: () => void) {
		if (!heldByOtherJob(this)) return startRun.call(this, trigger, onStarted);
		// Another job may take the Session before this continues.
		do await waitForJob(this); while (heldByOtherJob(this));
		if (this._isEmittingAgentSettled) return void this._deferredSettledActions.push(() => this._startRun(trigger, onStarted));
		if (this.isStreaming) {
			// Queued as Pi queues input while it streams, without preparing another run.
			if (trigger.messageType === "custom") this.agent.followUp(trigger.message);
			else void this._queueFollowUp(trigger.prompt, trigger.images);
			return void onStarted?.();
		}
		return startRun.call(this, trigger, onStarted);
	};
	const runner = Runner.prototype as Patchable;
	const setUIContext = runner.setUIContext;
	runner.setUIContext = function (this: Patchable, ui: Patchable | undefined, mode: string) {
		return setUIContext.call(this, ui && mode === "tui" ? sharedUI(ui, this.sessionManager) : ui, mode);
	};
}

/** Admits a prompt of `job`'s; prompts made while it runs, as by extensions, are part of the job. */
export function admit(session: AgentSession, job: Job, text: string, options: Patchable): Promise<void> {
	return shared.admit!(session, job, text, options);
}

/** Sends the UI records of the Session `manager` holds to `forward`, or to no one without it. */
export function forwardUI(manager: object, forward?: (record: object) => void): void {
	if (forward) shared.forwards.set(manager, forward);
	else shared.forwards.delete(manager);
}
