import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import net from "node:net";
import { treeMetadata } from "../agents/registry.ts";
import { FRAME, frame, json, readFrames } from "./frames.mjs";

const IDLE_EXIT_MS = 5 * 60_000;

// Only the host's own child runs in it; children of Pi inherit the variables but have another parent.
// They stay in the environment so a Pi that replaces itself with execve finds its host again.
const hostSocket = process.env.PI_AGENTS_HOST && process.env.PI_AGENTS_HOST_PID === String(process.ppid) ? process.env.PI_AGENTS_HOST : undefined;

export interface Host {
	socket: string;
	attached(): boolean;
	onChange(listener: () => void): void;
}

/**
 * Connects Pi to the host it runs in: reports the current Session, detaches on request,
 * disables suspend, and exits after the tree has been idle and detached for a while.
 * Returns the host, if Pi runs in one.
 */
export function hostExtension(pi: ExtensionAPI, { treeIdle }: { treeIdle: () => boolean }): Host | undefined {
	if (!hostSocket) return;
	const listeners: Array<() => void> = [];

	let ctx: ExtensionContext | undefined;
	let attached = true;
	let idleSince: number | undefined;
	let socket: net.Socket | undefined;
	const connect = (path: string): net.Socket => {
		const connection = net.connect(path);
		connection.on("error", () => {});
		connection.unref();
		readFrames(connection, (type: number, body: Buffer) => {
			if (type !== FRAME.control || json(body).type !== "attached" || json(body).attached === attached) return;
			attached = json(body).attached;
			for (const listener of listeners) listener();
		});
		return connection;
	};
	const send = (message: object): void => { socket?.write(frame(FRAME.control, message as never)); };
	const report = () => {
		if (!ctx) return;
		const file = ctx.sessionManager.getSessionFile();
		send({ type: "session", session: { id: ctx.sessionManager.getSessionId(), name: pi.getSessionName(), file } });
	};

	// Pi suspends by stopping its process group; a host has no shell to resume it, so resume at once.
	process.on("SIGTSTP", () => process.kill(process.pid, "SIGCONT"));

	const timer = setInterval(() => {
		if (!ctx || attached || !ctx.isIdle() || ctx.hasPendingMessages() || !treeIdle()) {
			idleSince = undefined;
			return;
		}
		idleSince ??= Date.now();
		if (Date.now() - idleSince >= IDLE_EXIT_MS) ctx.shutdown();
	}, 1000);
	timer.unref();

	pi.on("session_start", (_event, current) => {
		// Owned Agents run in the same process; only the root speaks for the host.
		if (treeMetadata(current)) return;
		ctx = current;
		socket ??= connect(hostSocket);
		report();
	});
	pi.on("session_info_changed", () => report());
	pi.on("session_shutdown", () => { ctx = undefined; });

	pi.registerCommand("detach", { description: "Detach this terminal; Pi keeps running", handler: async () => send({ type: "detach" }) });
	return { socket: hostSocket, attached: () => attached, onChange: (listener) => { listeners.push(listener); } };
}
