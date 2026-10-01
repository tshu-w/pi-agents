/**
 * Patches of Pi internals that background Programs need. They rely on private members of
 * `AgentSession` and `ExtensionRunner`, so check them when Pi is updated.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSession, ExtensionRunner } from "@earendil-works/pi-coding-agent";

const PATCHED = Symbol.for("pi-agents:patched");
const MCP_UNREACHABLE = /^MCP tools are only reachable from the codemode or tool_search tool/;
const MCP_SERVERS_SECTION = "mcp_servers";

interface DetachedCall {
	signal?: AbortSignal;
	abort?: () => void;
	active: boolean;
}

const detached = new AsyncLocalStorage<DetachedCall>();

/** `ctx.executeTool()` options that run a call outside the calling tool call's record. */
export interface DetachedCallOptions {
	/** Replaces the calling tool call's ID, so the call gets the ID `<callerId>/1`. */
	detachedCallerId: string;
	/** What `ctx.abort()` of hooks and tools does during the call. */
	detachedAbort: () => void;
}

type Patchable = Record<PropertyKey, any>;

/**
 * - A call with `detachedCallerId` runs under that ID: Pi numbers nested calls per caller and
 *   resets the numbers when the calling tool call returns and when the turn ends, which would
 *   repeat IDs across the calls of a background Program. While it runs, `ctx.signal` and
 *   `ctx.abort()` of hooks and tools act on the call instead of the caller's turn.
 * - While `program` is active and `codemode` is not, the MCP warning that no tool reaches its
 *   tools is dropped, and the system prompt section listing MCP servers names `program` where it
 *   names `codemode`, since Programs call their tools.
 */
export function installHostPatches(
	session: typeof AgentSession,
	runner: typeof ExtensionRunner,
	programToolName: string,
): void {
	const sessionProto = session.prototype as unknown as Patchable;
	if (!sessionProto[PATCHED]) {
		sessionProto[PATCHED] = true;
		const execute = sessionProto._executeNestedToolCall;
		sessionProto._executeNestedToolCall = async function (this: Patchable, callerId: string, name: string, args: unknown, options: Record<string, unknown> = {}) {
			const { detachedCallerId, detachedAbort, ...rest } = options;
			if (typeof detachedCallerId !== "string") return execute.call(this, callerId, name, args, options);
			const extensions = this._extensionRunner as Patchable;
			const getSignal = extensions.getSignalFn;
			if (!getSignal[PATCHED]) {
				const patched = () => {
					const call = detached.getStore();
					return call?.active ? call.signal : getSignal();
				};
				(patched as Patchable)[PATCHED] = true;
				extensions.getSignalFn = patched;
			}
			const abort = extensions.abortFn;
			if (!abort[PATCHED]) {
				const patched = () => {
					const call = detached.getStore();
					return call?.active ? call.abort?.() : abort();
				};
				(patched as Patchable)[PATCHED] = true;
				extensions.abortFn = patched;
			}
			const call: DetachedCall = { signal: rest.signal as AbortSignal | undefined, abort: detachedAbort as (() => void) | undefined, active: true };
			try {
				return await detached.run(call, () => execute.call(this, detachedCallerId, name, args, rest));
			} finally {
				// Work the call started, such as a turn it queued, keeps the store but not the signal.
				call.active = false;
			}
		};
	}
	const runnerProto = runner.prototype as unknown as Patchable;
	if (!runnerProto[PATCHED]) {
		runnerProto[PATCHED] = true;
		const setUIContext = runnerProto.setUIContext;
		runnerProto.setUIContext = function (this: Patchable, ...args: unknown[]) {
			setUIContext.apply(this, args);
			const ui = this.uiContext as Patchable;
			if (ui[PATCHED]) return;
			ui[PATCHED] = true;
			const notify = ui.notify;
			ui.notify = (message: string, ...rest: unknown[]) => {
				if (MCP_UNREACHABLE.test(message) && this.getActiveTools().includes(programToolName)) return;
				return notify.call(ui, message, ...rest);
			};
		};
		const emitBeforeAgentStart = runnerProto.emitBeforeAgentStart;
		runnerProto.emitBeforeAgentStart = async function (this: Patchable, ...args: unknown[]) {
			const result = await emitBeforeAgentStart.apply(this, args);
			const sections = result.systemPromptOptions?.sections as Record<string, string> | undefined;
			const active: string[] = this.getActiveTools();
			if (sections?.[MCP_SERVERS_SECTION] && active.includes(programToolName) && !active.includes("codemode")) {
				sections[MCP_SERVERS_SECTION] = sections[MCP_SERVERS_SECTION].replace(/\bcodemode\b/g, programToolName);
			}
			return result;
		};
	}
}
