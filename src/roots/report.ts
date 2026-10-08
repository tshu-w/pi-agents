import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { onTreeChange, treeMetadata } from "../agents/registry.ts";
import { ensureDaemon } from "../daemon/client.mjs";
import { statePaths, sessionDir as resolveSessionDir } from "./paths.mjs";
import { openStream } from "./transport.mjs";

const RECONNECT_MS = 1000;
const SEND_DELAY_MS = 50;
const TEXT_LIMIT = 200;

export interface ReportHooks {
	/** Whether the tree has no live work. */
	treeIdle(): boolean;
	/** The tree's running owned Agents and background Programs. */
	liveWork(): number;
	/** The host this Pi runs in, if any. */
	host?: { socket: string; attached(): boolean; onChange(listener: () => void): void };
}

function firstLine(text: string, limit = TEXT_LIMIT): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((block) => block?.type === "text").map((block) => block.text).join("\n");
}

function toolLabel(name: string, args: unknown): string {
	const detail = args && typeof args === "object" ? Object.values(args).find((value) => typeof value === "string" && value.trim()) : undefined;
	return detail ? `${name} ${firstLine(detail as string, 80)}` : name;
}

/**
 * Reports this root Session's state to the daemon while it is loaded: whether it works, its
 * running tool, its last reply and finished turn, and whether a terminal shows it. The daemon
 * forwards interrupts from the workbench.
 */
export function createReporter(pi: ExtensionAPI, hooks: ReportHooks): void {
	const paths = statePaths();
	const sessionDir = resolveSessionDir();
	let ctx: ExtensionContext | undefined;
	let stream: { send(message: object): void; close(): void } | undefined;
	let generation = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let dialogs = 0;
	let tools = new Map<string, string>();
	let turn: { at: number; failed: boolean } | undefined;
	let reply: string | undefined;
	let title: string | undefined;
	let unsubscribe: (() => void) | undefined;

	function state() {
		const current = ctx!;
		const manager = current.sessionManager;
		if (title === undefined) {
			const first = manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user");
			if (first?.type === "message") title = firstLine(textOf((first.message as { content?: unknown }).content));
		}
		return {
			id: manager.getSessionId(),
			sessionFile: manager.getSessionFile(),
			cwd: current.cwd,
			name: pi.getSessionName(),
			title,
			host: hooks.host?.socket,
			attached: hooks.host ? hooks.host.attached() : true,
			working: !current.isIdle() || current.hasPendingMessages() || !hooks.treeIdle() || dialogs > 0,
			blocked: dialogs > 0,
			tool: [...tools.values()].at(-1),
			reply,
			agents: hooks.liveWork(),
			turn,
		};
	}

	function changed(): void {
		if (timer || !ctx) return;
		timer = setTimeout(() => {
			timer = undefined;
			if (ctx && stream) stream.send({ type: "state", state: state() });
		}, SEND_DELAY_MS);
		timer.unref();
	}

	async function connect(current: number): Promise<void> {
		try {
			await ensureDaemon(paths, { sessionDir });
			const opened = await openStream(paths.daemon, { action: "stream", role: "session" }, {
				onMessage: (message: { type?: string; id?: string }) => {
					if (message?.type === "interrupt" && ctx && message.id === ctx.sessionManager.getSessionId()) ctx.abort();
				},
				onClose: () => {
					if (stream !== opened) return;
					stream = undefined;
					retry(current);
				},
			});
			opened.unref();
			if (current !== generation) return opened.close();
			stream = opened;
			changed();
		} catch {
			retry(current);
		}
	}

	// A daemon that exits, for example to update, is replaced by the next connection.
	function retry(current: number): void {
		if (current === generation) setTimeout(() => { if (current === generation) void connect(current); }, RECONNECT_MS).unref();
	}

	pi.on("session_start", (_event, current) => {
		if (!current.sessionManager.getSessionFile() || treeMetadata(current)) return;
		ctx = current;
		unsubscribe ??= onTreeChange(() => changed());
		void connect(++generation);
	});
	pi.on("session_shutdown", () => {
		if (!ctx) return;
		stream?.send({ type: "end", id: ctx.sessionManager.getSessionId() });
		stream?.close();
		stream = undefined;
		generation++;
		ctx = undefined;
		unsubscribe?.();
		unsubscribe = undefined;
		dialogs = 0;
		tools = new Map();
		turn = reply = title = undefined;
	});
	pi.on("session_info_changed", () => changed());
	pi.on("agent_start", () => changed());
	pi.on("tool_execution_start", (event) => {
		if (event.parentToolCallId) return;
		tools.set(event.toolCallId, toolLabel(event.toolName, event.args));
		changed();
	});
	pi.on("tool_execution_end", (event) => {
		if (tools.delete(event.toolCallId)) changed();
	});
	pi.on("ui_prompt_start", () => { dialogs += 1; changed(); });
	pi.on("ui_prompt_end", () => { dialogs = Math.max(0, dialogs - 1); changed(); });
	pi.on("agent_settled", (event) => {
		if (!ctx) return;
		const last = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
		const message = last?.type === "message" && last.message.role === "assistant" ? last.message : undefined;
		reply = message ? firstLine(textOf(message.content)) || firstLine(message.errorMessage ?? "") : undefined;
		turn = { at: Date.now(), failed: !event.aborted && message?.stopReason === "error" };
		tools = new Map();
		changed();
	});
	hooks.host?.onChange(() => changed());
}
