import { buildSessionContext, getPackageDir, hasTrustRequiringProjectResources, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MESSAGE_TYPE, modelLabel, trackTreeWork, treeMetadata } from "../agents/registry.ts";
import { sendViaDaemon } from "../daemon/client.mjs";
import { prepareDirectory, statePaths, sessionDir as resolveSessionDir } from "./paths.mjs";
import { readMailbox, updateMailbox } from "./mailbox.ts";
import { createRpc } from "./rpc.ts";
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
	model?: string;
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
 * accepts messages from other roots, and serves RPC clients.
 */
export function createRootRuntime(pi: ExtensionAPI, hooks: RootHooks) {
	const paths = statePaths();
	const sessionDir = resolveSessionDir();
	let active: ExtensionContext | undefined;
	let server: Awaited<ReturnType<typeof listen>> | undefined;
	let ready = false;
	let seen = new Set<string>();
	let redelivered: Promise<void> = Promise.resolve();
	const rpc = createRpc();

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
			model: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id, ...(ctx.model.reasoning && { thinkingLevel: pi.getThinkingLevel() }) } : undefined,
			availabilityError: availabilityError(),
		};
	}

	async function accept(message: RootMessage, { signal }: { signal: AbortSignal }) {
		if (!ready || !active) throw new Error("The recipient is not ready.");
		if (message.recipient !== active.sessionManager.getSessionId()) throw new Error("Message recipient does not match this Agent.");
		const error = availabilityError();
		if (error) throw new Error(error);
		signal.throwIfAborted();
		await redelivered;
		if (!seen.has(message.id)) {
			// Kept until it is in the Session, so that a restart delivers it; the user's message carries no ID there.
			if (!message.user) updateMailbox(message.recipient, (mailbox) => { mailbox.inbox.push(message); });
			try {
				await receive(message);
			} catch (error) {
				forget(message.recipient, message.id);
				throw error;
			}
			settle();
		}
		return { accepted: true, messageId: message.id };
	}

	async function receive(message: RootMessage) {
		seen.add(message.id);
		// The tree stays busy until the message is in the Session.
		const release = trackTreeWork(message.recipient);
		try {
			await hooks.receive(message);
		} catch (error) {
			seen.delete(message.id);
			throw error;
		} finally {
			release();
		}
	}

	/** Delivers the messages accepted before this Session's process exited that are not in the Session, in the order they arrived. */
	async function redeliver(sessionId: string) {
		// A Session that refuses messages keeps them until it starts able to take them.
		if (!ready || availabilityError()) return;
		for (const message of readMailbox(sessionId).inbox) {
			if (!ready) return;
			if (seen.has(message.id)) continue;
			try {
				await receive(message);
			} catch (error) {
				console.warn(`[pi-agents] redelivery of message ${message.id} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		settle();
	}

	function forget(sessionId: string, messageId: string) {
		updateMailbox(sessionId, (mailbox) => {
			const kept = mailbox.inbox.filter((message) => message.id !== messageId);
			if (kept.length === mailbox.inbox.length) return false;
			mailbox.inbox = kept;
		});
	}

	/** Forgets the accepted messages that are in the Session. */
	function settle() {
		if (!active) return;
		const ctx = active;
		updateMailbox(ctx.sessionManager.getSessionId(), (mailbox) => {
			// Pi writes a Session's file once it holds a conversation; until then its entries are only in memory.
			if (mailbox.inbox.length === 0 || !existsSync(ctx.sessionManager.getSessionFile()!)) return false;
			const received = new Set(hooks.receivedIds(ctx));
			const kept = mailbox.inbox.filter((message) => !received.has(message.id));
			if (kept.length === mailbox.inbox.length) return false;
			mailbox.inbox = kept;
		});
	}

	pi.on("resources_discover", () => {
		if (!active || !server || ready) return;
		ready = true;
		// Messages that arrive meanwhile follow those accepted before.
		const sessionId = active.sessionManager.getSessionId();
		redelivered = new Promise((resolve) => setTimeout(resolve)).then(() => redeliver(sessionId));
	});

	// Pi adds a message to the Session after this event's handlers. One added while the Session is idle has no event; the other places settle it.
	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role === "custom" && message.customType === MESSAGE_TYPE && (message.details as { messageId?: string } | undefined)?.messageId) setTimeout(settle);
	});
	pi.on("agent_end", () => settle());

	return {
		/** Other root Agents with their state. Only a root Agent sees them. */
		async roots(signal?: AbortSignal): Promise<RootEntry[]> {
			if (!active || !ready) return [];
			const self = current();
			const records = await rootSnapshot(paths, sessionDir, { signal, current: self });
			return records
				.filter((root: { id: string }) => root.id !== self.id)
				.map(({ id, name, cwd, state, sessionFile, model }: Omit<RootEntry, "model"> & { model?: { provider: string; modelId: string; thinkingLevel?: string } }) => ({
					id, name, cwd, state, sessionFile, ...(model && { model: modelLabel(model.provider, model.modelId, model.thinkingLevel) }),
				}));
		},

		/** Sends to another root: inputs start it in a host through the daemon, writes reach it only while it runs. */
		async send(target: { id: string; label: string }, delivery: RootDelivery, body: string, signal?: AbortSignal): Promise<void> {
			if (!active || !ready) throw new Error("Root messaging is not ready; only persistent root Sessions participate.");
			const sender = { id: active.sessionManager.getSessionId(), ...(pi.getSessionName() ? { name: pi.getSessionName() } : {}) };
			const message: RootMessage = { id: randomUUID(), sender, recipient: target.id, body, deliverAs: delivery };
			const deliver = async () => {
				if (delivery === "write") {
					let receipt: { accepted?: boolean; messageId?: string };
					try {
						receipt = await request(paths.session(target.id), { action: "deliver", message }, { signal });
					} catch (error) {
						const code = (error as NodeJS.ErrnoException).code;
						if (code === "ENOENT" || code === "ECONNREFUSED") throw new Error(`${target.label} is offline.`);
						throw error;
					}
					if (receipt?.accepted !== true || receipt.messageId !== message.id) {
						throw Object.assign(new Error(`Invalid acknowledgement from ${target.label}; it may have received the message.`), { uncertainDelivery: true });
					}
					return;
				}
				// The recipient runs with this Session's Pi, environment, and pi-agents, which Pi loads once.
				// The daemon has checked the recipient's acknowledgement.
				const extension = pi.getAllTools().find((tool) => tool.name === "agent")!.sourceInfo.path;
				const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
				const launch = { command: process.execPath, args: [piCli(), "-e", extension], env };
				await sendViaDaemon(paths, message, { sessionDir, launch, signal });
			};
			try {
				await deliver();
			} catch (error) {
				// The recipient adds each message ID to its Session once, so a message that may not have arrived is sent again once.
				if (!(error as { uncertainDelivery?: boolean }).uncertainDelivery || signal?.aborted) throw error;
				await deliver();
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
			await rpc.prepare();
			server = await listen(socket, {
				status: current,
				accept,
				stream: (input: { role: string }, channel: Parameters<typeof rpc.open>[1]) => {
					if (input.role !== "rpc" && input.role !== "print") throw new Error("Unsupported stream role.");
					if (!ready || !active) throw Object.assign(new Error("The Session is not ready for RPC clients."), { code: "NOT_READY" });
					return input.role === "rpc" ? rpc.open(active.sessionManager, channel) : rpc.print(active.sessionManager, channel);
				},
			});
		},

		/** How many RPC clients are connected. */
		rpcClients: () => rpc.clients(),

		async stop(): Promise<void> {
			settle();
			ready = false;
			rpc.close();
			await server?.close();
			server = undefined;
			active = undefined;
		},
	};
}

export type RootRuntime = ReturnType<typeof createRootRuntime>;
