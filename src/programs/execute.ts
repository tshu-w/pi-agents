/**
 * Runs one Program with Pi's `codemode` executor, so the script API, result format, and
 * truncation are Pi's own. Programs add globals such as `agent()`, a `timeout`, and calls
 * that outlive the `program` tool call; `withSandboxExtras` passes them to the sandbox.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { CodemodeResult, CodemodeTool } from "@earendil-works/pi-codemode";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { loadCodemode, loadPiCodemode } from "./codemode.ts";
import type { DetachedCallOptions } from "./host-patches.ts";

export const PROGRAM_TOOL_NAME = "program";

export type ProgramOutcome = "completed" | "failed" | "stopped";

/** Paths passed to `read`, `write`, and `edit`, which compaction lists like Pi's file operations. */
export interface ProgramFiles {
	read: string[];
	written: string[];
	edited: string[];
}

/** A call in codemode's `details.calls`. */
interface CallRecord {
	id: string;
	name: string;
	args: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	error?: string;
}

/**
 * Records calls that a Program's own globals make, which codemode does not see, beside its tool calls.
 * `start` returns the function that ends the call; a call still running when the script ends is cancelled.
 */
export type CallTracker = (name: string, args: string) => (status: "ok" | "error" | "cancelled", error?: string) => void;

const ARGS_PREVIEW_CHARS = 200;
const ERROR_PREVIEW_CHARS = 500;
const NOTE_NAMES = 10;
const NOTE_NAME_CHARS = 60;

const preview = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 3)}...` : text;

/** Names of calls for a note: at most `NOTE_NAMES` of them, each cut to `NOTE_NAME_CHARS`, since scripts name Agents. */
function callNames(calls: CallRecord[], status: boolean): string {
	const shown = calls.slice(0, NOTE_NAMES).map((call) => {
		const name = preview(call.name, NOTE_NAME_CHARS);
		return status ? `${name} (${call.status})` : name;
	});
	return calls.length > NOTE_NAMES ? `${shown.join(", ")}, and ${calls.length - NOTE_NAMES} more` : shown.join(", ");
}

/** Adds a note after a blank line to the last text item, or as a new item after images. */
function appendNote(content: AgentToolResult<unknown>["content"], note: string): void {
	const last = content.at(-1);
	if (last?.type === "text") last.text += `\n\n${note}`;
	else content.push({ type: "text", text: note });
}

export interface ProgramRunResult {
	outcome: ProgramOutcome;
	result: AgentToolResult<unknown> & { isError?: boolean };
	files: ProgramFiles;
	/** Whether some of the Program's work did not stop during cleanup. */
	abandoned?: boolean;
}

export interface ProgramRunOptions {
	/** Seconds until the Program stops; the script's `timeout_ms` option applies as well. */
	timeout?: number;
	/** Globals added to the script, such as the host side of `agent()`; `track` records their calls. */
	globals?: (track: CallTracker) => CodemodeTool[];
	/** Rewrites the code before it runs, such as prepending the `agent()` prelude. */
	prepare?: (code: string) => string;
	onUpdate?: AgentToolUpdateCallback<unknown>;
	/**
	 * Whether the Program runs outside a tool call: after its tool call returns, or from `/program`.
	 * Its calls then get their own IDs, since Pi records nested calls only until the calling tool
	 * call returns.
	 */
	detached?: boolean;
	/** Stops a detached Program; `ctx.abort()` of its calls' hooks and tools calls it. */
	abort?: () => void;
	appendEntry(customType: string, data: unknown): void;
	getToolNamespace(name: string): { name: string } | undefined;
}

interface SandboxExtras {
	globals: CodemodeTool[];
	prepare: (code: string) => string;
	timeoutMs: number;
	result?: CodemodeResult;
	used: boolean;
	/** Called when the script ends, before the sandbox closes. */
	ended(): void;
}

const sandboxExtras = new AsyncLocalStorage<SandboxExtras>();
let sandboxPatched = false;

/**
 * Pi's executor creates and runs one sandbox per script. Its first execution in `extras`' async
 * context gets the extras; later sandboxes there, such as those of Agents the Program created,
 * do not.
 */
async function withSandboxExtras<T>(extras: SandboxExtras, run: () => Promise<T>): Promise<T> {
	if (!sandboxPatched) {
		sandboxPatched = true;
		const proto = (await loadCodemode()).CodemodeSandbox.prototype as unknown as Record<string, any>;
		const execute = proto.execute;
		proto.execute = function (this: Record<string, any>, code: string, options: Record<string, unknown> = {}) {
			const current = sandboxExtras.getStore();
			if (!current || current.used) return execute.call(this, code, options);
			current.used = true;
			for (const global of current.globals) this.globalsByName.set(global.name, global);
			const timeoutMs = Math.min(current.timeoutMs, (options.timeoutMs as number | undefined) ?? this.timeoutMs);
			return execute.call(this, current.prepare(code), { ...options, timeoutMs }).then((result: CodemodeResult) => {
				current.result = result;
				current.ended();
				return result;
			}, (error: unknown) => {
				current.ended();
				throw error;
			});
		};
	}
	return sandboxExtras.run(extras, run);
}

/**
 * Runs one Program. The signal stops it; `ctx` must stay usable until the Program ends,
 * which holds after the `program` tool call returns while the Session is loaded.
 */
export async function executeProgram(
	toolCallId: string,
	source: string,
	signal: AbortSignal,
	ctx: ExtensionToolContext,
	options: ProgramRunOptions,
): Promise<ProgramRunResult> {
	const { executeCodemode } = await loadPiCodemode();
	const files: ProgramFiles = { read: [], written: [], edited: [] };
	const addFile = (name: string, args: unknown) => {
		const path = (args as { path?: unknown } | undefined)?.path;
		const list = name === "read" ? files.read : name === "write" ? files.written : name === "edit" ? files.edited : undefined;
		if (typeof path === "string" && list && !list.includes(path)) list.push(path);
	};
	let detachedCalls = 0;
	const programCtx = Object.create(ctx, {
		tools: { get: () => ctx.tools.filter((tool) => tool.name !== PROGRAM_TOOL_NAME) },
		executeTool: {
			value: (name: string, args: unknown, callOptions: { signal?: AbortSignal } = {}) => {
				if (!options.detached) return ctx.executeTool(name, args, callOptions);
				addFile(name, args);
				const detachedOptions = { ...callOptions, detachedCallerId: `${toolCallId}:${++detachedCalls}`, detachedAbort: () => options.abort?.() } satisfies DetachedCallOptions;
				return ctx.executeTool(name, args, detachedOptions as never);
			},
		},
	}) as ExtensionToolContext;
	// The globals' calls, each placed after the codemode calls seen when it started.
	const own: Array<{ record: CallRecord; after: number; startedAt: number }> = [];
	let seen: CallRecord[] = [];
	let last: Parameters<AgentToolUpdateCallback<unknown>>[0] = { content: [], details: undefined };
	let scriptEnded = false;
	const merged = (): CallRecord[] => {
		const calls: CallRecord[] = [];
		let next = 0;
		for (const { record, after } of own) {
			while (next < after && next < seen.length) calls.push({ ...seen[next++]! });
			calls.push({ ...record });
		}
		while (next < seen.length) calls.push({ ...seen[next++]! });
		return calls;
	};
	const publish = () => options.onUpdate?.({ ...last, details: { ...(last.details as object | undefined), calls: merged() } });
	const onUpdate: AgentToolUpdateCallback<unknown> = (update) => {
		last = update;
		seen = (update.details as { calls?: CallRecord[] } | undefined)?.calls ?? seen;
		publish();
	};
	const finish = (entry: (typeof own)[number], status: "ok" | "error" | "cancelled", error?: string) => {
		if (entry.record.status !== "running") return;
		entry.record.status = status;
		entry.record.durationMs = performance.now() - entry.startedAt;
		if (error !== undefined) entry.record.error = preview(error, ERROR_PREVIEW_CHARS);
		publish();
	};
	const track: CallTracker = (name, args) => {
		const entry = { record: { id: `${toolCallId}/${name}-${own.length + 1}`, name, args: preview(args, ARGS_PREVIEW_CHARS), status: "running" as const }, after: seen.length, startedAt: performance.now() };
		own.push(entry);
		if (scriptEnded) finish(entry, "cancelled");
		else publish();
		return (status, error) => finish(entry, status, error);
	};
	// Calls still running when the script ends are cut off by it.
	let cutOff: CallRecord[] = [];
	const extras: SandboxExtras = {
		globals: options.globals?.(track) ?? [],
		prepare: options.prepare ?? ((code) => code),
		timeoutMs: options.timeout === undefined ? Number.POSITIVE_INFINITY : options.timeout * 1000,
		used: false,
		ended: () => {
			scriptEnded = true;
			const running = own.filter((entry) => entry.record.status === "running");
			for (const entry of running) finish(entry, "cancelled");
			cutOff = running.map((entry) => entry.record);
		},
	};
	let result: Awaited<ReturnType<typeof executeCodemode>>;
	try {
		result = await withSandboxExtras(extras, () => executeCodemode(toolCallId, { code: source }, signal, onUpdate, programCtx, {
			models: true,
			appendEntry: options.appendEntry,
			getToolNamespace: options.getToolNamespace,
		}));
	} finally {
		if (!scriptEnded) extras.ended();
	}
	const outcome: ProgramOutcome = extras.result?.ok
		? "completed"
		: extras.result?.error.kind === "timeout" || extras.result?.error.kind === "aborted" ? "stopped" : "failed";
	// codemode marks calls cut off by the script ending only in its result, after the last update.
	seen = (result.details as { calls?: CallRecord[] } | undefined)?.calls ?? seen;
	if (own.length > 0) result.details = { ...(result.details as object | undefined), calls: merged() };
	// codemode lists the tool calls made before a failure; the globals' calls get a line of their own.
	if (outcome !== "completed" && own.length > 0) {
		appendNote(result.content, `Agent calls made before the failure (they are not undone): ${callNames(own.map((entry) => entry.record), true)}`);
	} else if (outcome === "completed") {
		const stopped = [...seen.filter((call) => call.status === "cancelled"), ...cutOff];
		if (stopped.length > 0) appendNote(result.content, `Calls still running when the script returned were cancelled; their effects are not undone: ${callNames(stopped, false)}`);
	}
	return { outcome, result, files };
}
