import { buildSessionContext, getAgentDir, getPackageDir, hasTrustRequiringProjectResources, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { trackTreeWork, treeMetadata } from "../agents/registry.ts";
import { isBackgroundWorker } from "./background.mjs";
import { sendViaSupervisor } from "./client.mjs";
import { rootPaths } from "./paths.mjs";
import { rememberRoot } from "./registry.mjs";
import { rootSnapshot } from "./snapshot.mjs";
import { recoverSocket } from "./socket-recovery.mjs";
import { listenWorker, request } from "./transport.mjs";

export type RootDelivery = "followUp" | "steer" | "write";

export interface RootMessage {
	id: string;
	sender: { id: string; name?: string };
	recipient: string;
	body: string;
	deliverAs?: RootDelivery;
}

export interface RootEntry {
	id: string;
	name?: string;
	cwd: string;
	state: "busy" | "idle" | "offline";
	sessionFile: string;
}

export interface RootHooks {
	/** Adds a message from another root to this Session. */
	receive(message: RootMessage): void | Promise<void>;
	/** Whether this root's tree has no inputs that have not ended. */
	treeIdle(): boolean;
	/** IDs of messages from other roots already in this Session. */
	receivedIds(ctx: ExtensionContext): Iterable<string>;
}

const EXIT_DELAY_MS = 100;
const STARTUP_GRACE_MS = 10_000;

function piEntries(): { cli: string; index: string } {
	const dir = getPackageDir();
	const bundled = join(dir, "dist/bundle/cli.js");
	const bundledIndex = join(dir, "dist/bundle/index.js");
	return {
		cli: existsSync(bundled) ? bundled : join(dir, "dist/cli.js"),
		index: existsSync(bundledIndex) ? bundledIndex : join(dir, "dist/index.js"),
	};
}

/**
 * Makes this root Agent reachable from other processes: it answers status requests,
 * accepts messages from other roots, and, as a background Worker, exits once idle.
 */
export function createRootRuntime(pi: ExtensionAPI, hooks: RootHooks) {
	const paths = rootPaths();
	const sessionRoot = join(getAgentDir(), "sessions");
	let active: ExtensionContext | undefined;
	let server: Awaited<ReturnType<typeof listenWorker>> | undefined;
	let ready = false;
	let exiting = false;
	let seen = new Set<string>();
	let exitTimer: ReturnType<typeof setTimeout> | undefined;
	const acknowledgements = new Set<AbortSignal>();

	function availabilityError(): string | undefined {
		const ctx = active!;
		if (!ctx.model) return "The recipient has no available model. Open the Session interactively and select a model.";
		const saved = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).model;
		if (saved && (saved.provider !== ctx.model.provider || saved.modelId !== ctx.model.id)) {
			return `Saved model ${saved.provider}/${saved.modelId} is unavailable; refusing model fallback.`;
		}
		if (hasTrustRequiringProjectResources(ctx.cwd) && !ctx.isProjectTrusted()) {
			return `Interactive project authorization is required in ${ctx.cwd}. Open the Session interactively first.`;
		}
	}

	function idle(): boolean {
		return active !== undefined && active.isIdle() && !active.hasPendingMessages() && hooks.treeIdle();
	}

	function current() {
		const ctx = active!;
		return {
			id: ctx.sessionManager.getSessionId(),
			name: pi.getSessionName(),
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile()!,
			state: idle() ? "idle" : "busy",
			ready,
			pid: process.pid,
			background: isBackgroundWorker(ctx),
			model: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
			availabilityError: availabilityError(),
		};
	}

	// A background Worker exits once its inputs and its owned Agents' inputs have ended.
	function scheduleExit(delay = EXIT_DELAY_MS): void {
		if (!active || !isBackgroundWorker(active) || exiting) return;
		clearTimeout(exitTimer);
		exitTimer = setTimeout(() => {
			if (!ready || exiting || acknowledgements.size > 0 || !idle()) return;
			exiting = true;
			// SIGTERM runs Pi's RPC shutdown, which emits session_shutdown and disposes the Session.
			process.kill(process.pid, "SIGTERM");
		}, delay);
		exitTimer.unref();
	}

	async function accept(message: RootMessage, { signal }: { signal: AbortSignal }) {
		if (exiting) throw Object.assign(new Error("The recipient is exiting; retry the send."), { code: "WORKER_EXITING", uncertainDelivery: false });
		if (!ready || !active) throw new Error("The recipient is not ready.");
		if (message.recipient !== active.sessionManager.getSessionId()) throw new Error("Message recipient does not match this Agent.");
		const error = availabilityError();
		if (error) throw new Error(error);
		signal.throwIfAborted();
		if (!seen.has(message.id)) {
			seen.add(message.id);
			// The tree stays busy until the message is in the Session.
			const release = trackTreeWork(message.recipient);
			try {
				await hooks.receive(message);
			} finally {
				release();
			}
		}
		if (isBackgroundWorker(active)) {
			// The transport aborts this signal when the acknowledgement connection closes.
			acknowledgements.add(signal);
			signal.addEventListener("abort", () => {
				acknowledgements.delete(signal);
				scheduleExit();
			}, { once: true });
		}
		return { accepted: true, messageId: message.id };
	}

	pi.on("resources_discover", () => {
		if (!active || !server) return;
		ready = true;
		scheduleExit(STARTUP_GRACE_MS);
	});
	pi.on("agent_settled", () => scheduleExit());

	return {
		/** Other root Agents with their state. Only a root Agent sees them. */
		async roots(signal?: AbortSignal): Promise<RootEntry[]> {
			if (!active || !ready) return [];
			const self = current();
			const records = await rootSnapshot(paths, sessionRoot, { signal, current: self });
			return records
				.filter((root: { id: string }) => root.id !== self.id)
				.map(({ id, name, cwd, state, sessionFile }: RootEntry) => ({ id, name, cwd, state, sessionFile }));
		},

		/** Sends to another root: inputs wake it through the Supervisor, writes reach it only while it runs. */
		async send(target: { id: string; label: string }, delivery: RootDelivery, body: string, signal?: AbortSignal): Promise<void> {
			if (!active || !ready) throw new Error("Root messaging is not ready; only persistent root Sessions participate.");
			const sender = { id: active.sessionManager.getSessionId(), ...(pi.getSessionName() ? { name: pi.getSessionName() } : {}) };
			const message: RootMessage = { id: randomUUID(), sender, recipient: target.id, body, deliverAs: delivery };
			let receipt: { accepted?: boolean; messageId?: string };
			if (delivery === "write") {
				try {
					receipt = await request(paths.worker(target.id), { action: "deliver", message }, { signal });
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code === "ENOENT" || code === "ECONNREFUSED") throw new Error(`${target.label} is offline.`);
					throw error;
				}
			} else {
				const { cli, index } = piEntries();
				const extension = pi.getAllTools().find((tool) => tool.name === "agent")!.sourceInfo.path;
				receipt = await sendViaSupervisor(paths, message, { cli, sessionRoot, piIndex: index, extension, signal });
			}
			if (receipt?.accepted !== true || receipt.messageId !== message.id) {
				throw new Error(`Invalid acknowledgement from ${target.label}; it may have received the message.`);
			}
		},

		async start(ctx: ExtensionContext): Promise<void> {
			if (server && active?.sessionManager === ctx.sessionManager) {
				active = ctx;
				return;
			}
			if (!ctx.sessionManager.getSessionFile() || treeMetadata(ctx)) return;
			active = ctx;
			if (isBackgroundWorker(ctx) && process.env.PI_AGENTS_EXPECTED_MODEL) {
				const expected = JSON.parse(process.env.PI_AGENTS_EXPECTED_MODEL) as { provider: string; modelId: string };
				if (expected.provider !== ctx.model?.provider || expected.modelId !== ctx.model?.id) {
					throw new Error(`Saved model ${expected.provider}/${expected.modelId} is unavailable; refusing model fallback.`);
				}
			}
			seen = new Set(hooks.receivedIds(ctx));
			await rememberRoot(paths, current());
			const socket = paths.worker(ctx.sessionManager.getSessionId());
			await recoverSocket(socket);
			server = await listenWorker(socket, { status: current, accept });
		},

		async stop(): Promise<void> {
			clearTimeout(exitTimer);
			ready = false;
			await server?.close();
			server = undefined;
			active = undefined;
		},
	};
}

export type RootRuntime = ReturnType<typeof createRootRuntime>;
