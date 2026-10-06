/**
 * Patches of Pi internals that background Programs need. They rely on private members of
 * `AgentSession` and `ExtensionRunner`, so check them when Pi is updated.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSession, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { CODEMODE_TOOL_NAME } from "./codemode.ts";
import { PROGRAM_TOOL_NAME } from "./execute.ts";

const PATCHED = Symbol.for("pi-agents:patched");
const MCP_EXTENSION_PATH = "builtin:mcp";

interface DetachedCall {
	signal?: AbortSignal;
	abort?: () => void;
	active: boolean;
}

const detached = new AsyncLocalStorage<DetachedCall>();
/** Set while the built-in MCP extension runs, including work it started. */
const inMcp = new AsyncLocalStorage<true>();

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
 * - The built-in MCP extension sees `program` as `codemode`: it activates `program` when its tools
 *   need a script tool and neither is active, counts an active `program` as reaching its tools,
 *   and makes a Program wait for the servers its code names, as it does for `codemode` scripts.
 */
export function installHostPatches(
	session: typeof AgentSession,
	runner: typeof ExtensionRunner,
	codemodeSchema: unknown,
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
		const bindCore = runnerProto.bindCore;
		runnerProto.bindCore = function (this: Patchable, ...args: unknown[]) {
			bindCore.apply(this, args);
			const mcp = (this.extensions as Patchable[]).find((extension) => extension.path === MCP_EXTENSION_PATH);
			if (mcp) aliasProgramForMcp(this, mcp, codemodeSchema);
		};
	}
}

function aliasProgramForMcp(runner: Patchable, mcp: Patchable, codemodeSchema: unknown): void {
	if (!mcp[PATCHED]) {
		mcp[PATCHED] = true;
		const asCodemodeCall = (event: Patchable) => event.toolName === PROGRAM_TOOL_NAME && event.input?.action === "run"
			? { ...event, toolName: CODEMODE_TOOL_NAME, input: { code: event.input.code } }
			: event;
		for (const [type, handlers] of mcp.handlers as Map<string, Function[]>) {
			handlers.forEach((handler, index) => {
				handlers[index] = (event: Patchable, ctx: unknown) => inMcp.run(true, () => handler(type === "tool_call" ? asCodemodeCall(event) : event, ctx));
			});
		}
		for (const command of (mcp.commands as Map<string, Patchable>).values()) {
			const handler = command.handler;
			command.handler = (args: unknown, ctx: unknown) => inMcp.run(true, () => handler(args, ctx));
		}
	}
	// `bindCore` sets these each time, so wrap the current ones.
	const runtime = runner.runtime as Patchable;
	const { getActiveTools, getAllTools, setActiveTools } = runtime;
	runtime.getActiveTools = () => {
		const active: string[] = getActiveTools();
		return inMcp.getStore() && active.includes(PROGRAM_TOOL_NAME) && !active.includes(CODEMODE_TOOL_NAME) ? [...active, CODEMODE_TOOL_NAME] : active;
	};
	runtime.getAllTools = () => {
		const tools: Patchable[] = getAllTools();
		const program = inMcp.getStore() && tools.find((tool) => tool.name === PROGRAM_TOOL_NAME);
		return program ? [...tools, { ...program, name: CODEMODE_TOOL_NAME, parameters: codemodeSchema }] : tools;
	};
	runtime.setActiveTools = (names: string[]) => {
		if (inMcp.getStore() && names.includes(CODEMODE_TOOL_NAME) && !getActiveTools().includes(CODEMODE_TOOL_NAME)) {
			names = [...new Set(names.map((name) => name === CODEMODE_TOOL_NAME ? PROGRAM_TOOL_NAME : name))];
		}
		return setActiveTools(names);
	};
}
