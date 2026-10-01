/**
 * Runs one Program with Pi's `codemode` executor, so the script API, result format, and
 * truncation are Pi's own. Programs add globals such as `agent()`, a `timeout`, and calls
 * that outlive the `program` tool call; `withSandboxExtras` passes them to the sandbox.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { CodemodeResult, CodemodeTool } from "@earendil-works/pi-codemode";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { loadCodemode, loadPiCodemode } from "./codemode.ts";

export const PROGRAM_TOOL_NAME = "program";

/** Points codemode API text at `program`. */
export function forProgram(text: string): string {
	return text.replaceAll("codemode tool declaration:", "program tool declaration:").replaceAll("`codemode` calls", "`program` runs");
}

export type ProgramOutcome = "completed" | "failed" | "stopped";

/** Paths passed to `read`, `write`, and `edit`, which compaction lists like Pi's file operations. */
export interface ProgramFiles {
	read: string[];
	written: string[];
	edited: string[];
}

export interface ProgramRunResult {
	outcome: ProgramOutcome;
	result: AgentToolResult<unknown> & { isError?: boolean };
	files: ProgramFiles;
}

export interface ProgramRunOptions {
	/** Seconds until the Program stops; the script's `timeout_ms` option applies as well. */
	timeout?: number;
	/** Globals added to the script, such as the host side of `agent()`. */
	globals?: CodemodeTool[];
	/** Rewrites the code before it runs, such as prepending the `agent()` prelude. */
	prepare?: (code: string) => string;
	onUpdate?: AgentToolUpdateCallback<unknown>;
	/**
	 * Whether the Program runs after its tool call returns. Its calls then get their own IDs,
	 * since Pi records nested calls only until the calling tool call returns.
	 */
	background?: boolean;
	/** Stops a background Program; `ctx.abort()` of its calls' hooks and tools calls it. */
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
			// Tool descriptions reach scripts through ALL_TOOLS and the discovery globals.
			for (const tool of this.toolsByName.values()) if (typeof tool.description === "string") tool.description = forProgram(tool.description);
			const rewrite = (value: unknown): unknown => typeof value === "string"
				? forProgram(value)
				: Array.isArray(value) ? value.map((entry) => ({ ...entry, description: forProgram(String(entry.description ?? "")) })) : value;
			for (const name of ["describeTool", "searchTools"]) {
				const global = this.globalsByName.get(name);
				if (global) this.globalsByName.set(name, { ...global, execute: async (...args: unknown[]) => rewrite(await global.execute(...args)) });
			}
			for (const global of current.globals) this.globalsByName.set(global.name, global);
			const timeoutMs = Math.min(current.timeoutMs, (options.timeoutMs as number | undefined) ?? this.timeoutMs);
			return execute.call(this, current.prepare(code), { ...options, timeoutMs }).then((result: CodemodeResult) => {
				current.result = result;
				return result;
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
				if (!options.background) return ctx.executeTool(name, args, callOptions);
				addFile(name, args);
				return ctx.executeTool(name, args, { ...callOptions, detachedCallerId: `${toolCallId}:${++detachedCalls}`, detachedAbort: () => options.abort?.() } as never);
			},
		},
	}) as ExtensionToolContext;
	const extras: SandboxExtras = {
		globals: options.globals ?? [],
		prepare: options.prepare ?? ((code) => code),
		timeoutMs: options.timeout === undefined ? Number.POSITIVE_INFINITY : options.timeout * 1000,
		used: false,
	};
	const result = await withSandboxExtras(extras, () => executeCodemode(toolCallId, { code: source }, signal, options.onUpdate, programCtx, {
		models: true,
		appendEntry: options.appendEntry,
		getToolNamespace: options.getToolNamespace,
	}));
	const outcome: ProgramOutcome = extras.result?.ok
		? "completed"
		: extras.result?.error.kind === "timeout" || extras.result?.error.kind === "aborted" ? "stopped" : "failed";
	return { outcome, result, files };
}
