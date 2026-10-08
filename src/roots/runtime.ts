import { buildSessionContext, getPackageDir, hasTrustRequiringProjectResources, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { trackTreeWork, treeMetadata } from "../agents/registry.ts";
import { sendViaDaemon } from "../daemon/client.mjs";
import { prepareDirectory, statePaths, sessionDir as resolveSessionDir } from "./paths.mjs";
import { rootSnapshot } from "./snapshot.mjs";
import { recoverSocket } from "./socket-recovery.mjs";
import { listen, request } from "./transport.mjs";

export type RootDelivery = "followUp" | "steer" | "write";

export interface RootMessage {
	id: string;
	/** Absent on a message from the user, which `user` marks. */
	sender?: { id: string; name?: string };
	user?: true;
	recipient: string;
	body: string;
	deliverAs?: RootDelivery;
}

export interface RootEntry {
	id: string;
	name?: string;
	cwd: string;
	state: "running" | "idle";
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

function piCli(): string {
	const dir = getPackageDir();
	const bundled = join(dir, "dist/bundle/cli.js");
	return existsSync(bundled) ? bundled : join(dir, "dist/cli.js");
}

/**
 * Makes this root Agent reachable from other processes: it answers status requests,
 * and accepts messages from other roots.
 */
export function createRootRuntime(pi: ExtensionAPI, hooks: RootHooks) {
	const paths = statePaths();
	const sessionDir = resolveSessionDir();
	let active: ExtensionContext | undefined;
	let server: Awaited<ReturnType<typeof listen>> | undefined;
	let ready = false;
	let seen = new Set<string>();

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
			state: idle() ? "idle" : "running",
			ready,
			pid: process.pid,
			model: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
			availabilityError: availabilityError(),
		};
	}

	async function accept(message: RootMessage, { signal }: { signal: AbortSignal }) {
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
		return { accepted: true, messageId: message.id };
	}

	pi.on("resources_discover", () => {
		if (!active || !server) return;
		ready = true;
	});

	return {
		/** Other root Agents with their state. Only a root Agent sees them. */
		async roots(signal?: AbortSignal): Promise<RootEntry[]> {
			if (!active || !ready) return [];
			const self = current();
			const records = await rootSnapshot(paths, sessionDir, { signal, current: self });
			return records
				.filter((root: { id: string }) => root.id !== self.id)
				.map(({ id, name, cwd, state, sessionFile }: RootEntry) => ({ id, name, cwd, state, sessionFile }));
		},

		/** Sends to another root: inputs start it in a host through the daemon, writes reach it only while it runs. */
		async send(target: { id: string; label: string }, delivery: RootDelivery, body: string, signal?: AbortSignal): Promise<void> {
			if (!active || !ready) throw new Error("Root messaging is not ready; only persistent root Sessions participate.");
			const sender = { id: active.sessionManager.getSessionId(), ...(pi.getSessionName() ? { name: pi.getSessionName() } : {}) };
			const message: RootMessage = { id: randomUUID(), sender, recipient: target.id, body, deliverAs: delivery };
			let receipt: { accepted?: boolean; messageId?: string };
			if (delivery === "write") {
				try {
					receipt = await request(paths.session(target.id), { action: "deliver", message }, { signal });
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code === "ENOENT" || code === "ECONNREFUSED") throw new Error(`${target.label} is offline.`);
					throw error;
				}
			} else {
				// The recipient runs with this Session's Pi, environment, and pi-agents, which Pi loads once.
				const extension = pi.getAllTools().find((tool) => tool.name === "agent")!.sourceInfo.path;
				const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
				const launch = { command: process.execPath, args: [piCli(), "-e", extension], env };
				receipt = await sendViaDaemon(paths, message, { sessionDir, launch, signal });
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
			seen = new Set(hooks.receivedIds(ctx));
			await prepareDirectory(paths.runtime);
			const socket = paths.session(ctx.sessionManager.getSessionId());
			await recoverSocket(socket);
			server = await listen(socket, { status: current, accept });
		},

		async stop(): Promise<void> {
			ready = false;
			await server?.close();
			server = undefined;
			active = undefined;
		},
	};
}

export type RootRuntime = ReturnType<typeof createRootRuntime>;
