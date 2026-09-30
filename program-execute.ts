/**
 * Runs one Program in the sandbox. Ported from Pi's `extensions/codemode/execute.ts`, so the
 * script API, result format, and truncation match `codemode`; Programs add globals such as
 * `agent()`, a `timeout`, and a signal that outlives the `program` tool call.
 */
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodemodeResult, CodemodeTool } from "@earendil-works/pi-codemode";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { loadCodemode, loadPiCodemode, type PiCodemode } from "./codemode.ts";

export const PROGRAM_TOOL_NAME = "program";

const ARGS_PREVIEW_CHARS = 200;
const ERROR_PREVIEW_CHARS = 500;
const MAX_CONCURRENT_MODEL_CALLS = 4;
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const MODEL_TYPES = new Set(["chat", "image", "classifier"]);
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const CHARS_PER_TOKEN = 4;

export type ProgramOutcome = "completed" | "failed" | "stopped";

export interface ProgramCall {
	id: string;
	name: string;
	args: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	error?: string;
	cost?: number;
}

export interface ProgramRunResult {
	outcome: ProgramOutcome;
	result: AgentToolResult<{ calls: ProgramCall[]; fullOutputPath?: string }> & { isError?: boolean };
}

export interface ProgramRunOptions {
	/** Seconds until the Program stops; the script's `timeout_ms` option applies as well. */
	timeout?: number;
	/** Globals added to the script, such as the host side of `agent()`. */
	globals?: CodemodeTool[];
	/** Rewrites the code before it runs, such as prepending the `agent()` prelude. */
	prepare?: (code: string) => string;
	onUpdate?: (details: { calls: ProgramCall[] }) => void;
	appendEntry(customType: string, data: unknown): void;
	getToolNamespace(name: string): { name: string } | undefined;
}

function truncateText(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

function previewArgs(args: unknown): string {
	if (args === undefined) return "";
	try {
		return truncateText(JSON.stringify(args) ?? "", ARGS_PREVIEW_CHARS);
	} catch {
		return "";
	}
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (result.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function toModelType(value: unknown): string {
	if (typeof value === "string" && MODEL_TYPES.has(value)) return value;
	throw new Error(`Unknown model type ${JSON.stringify(value)}. Use "chat", "image", or "classifier".`);
}

function toProvider(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error("provider must be a string");
	return value;
}

/** Catalog entry for scripts. `headers` is dropped because models.json headers can carry credentials. */
function toModelInfo(model: Record<string, unknown>): Record<string, unknown> {
	const info = { ...model };
	delete info.headers;
	return info;
}

function createLimiter(limit: number) {
	let active = 0;
	const waiting: Array<() => void> = [];
	return async <T>(run: () => Promise<T>): Promise<T> => {
		if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
		active++;
		try {
			return await run();
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
}

function valueText(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value) ?? String(value);
}

function formatCallSummary(calls: ProgramCall[]): string {
	if (calls.length === 0) return "No tool calls were made.";
	return `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}`;
}

function formatError(result: Extract<CodemodeResult, { ok: false }>, calls: ProgramCall[]): string {
	const { error } = result;
	const head = error.kind === "script"
		? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
		: error.kind === "timeout"
			? `Script timed out: ${error.message}`
			: error.kind === "aborted"
				? `Script aborted: ${error.message}`
				: `Script sandbox failed: ${error.message}`;
	return `${head}\n\n${formatCallSummary(calls)}`;
}

async function spillOutput(text: string): Promise<{ path: string } | { error: string }> {
	const path = join(tmpdir(), `pi-codemode-${randomBytes(8).toString("hex")}.txt`);
	try {
		await writeFile(path, text);
		return { path };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

type Item = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

async function truncateOutput(items: Item[], maxTokens: number): Promise<{ items: Item[]; fullOutputPath?: string }> {
	const texts = items.flatMap((item) => item.type === "text" ? [item.text] : []);
	const combined = texts.join("\n");
	const budget = maxTokens * CHARS_PER_TOKEN;
	if (texts.length === 0 || combined.length <= budget) return { items };
	const headChars = Math.floor(budget / 2);
	const tailChars = budget - headChars;
	const removed = combined.length - headChars - tailChars;
	const head = combined.slice(0, headChars);
	const tail = tailChars > 0 ? combined.slice(-tailChars) : "";
	let text = `Warning: truncated output (original token count: ${Math.ceil(combined.length / CHARS_PER_TOKEN)})\nTotal output lines: ${combined.split("\n").length}\n\n${head}…${Math.ceil(removed / CHARS_PER_TOKEN)} tokens truncated…${tail}`;
	const spilled = await spillOutput(combined);
	text += "path" in spilled
		? `\n\n[Full output: ${spilled.path} (read with offset/limit)]`
		: `\n\n[Could not save the full output: ${spilled.error}]`;
	return {
		items: [{ type: "text", text }, ...items.filter((item) => item.type === "image")],
		...("path" in spilled ? { fullOutputPath: spilled.path } : {}),
	};
}

function toScriptValue(tool: { name: string; outputSchema?: unknown }, outcome: { isError: boolean; result: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown } }): unknown {
	const { result } = outcome;
	if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;
	const text = textOf(result);
	if (outcome.isError) throw new Error(text || `Tool "${tool.name}" failed`);
	return text;
}

/** Tools a Program may call: the caller's tools except `program` and `codemode`. */
export function programCallableTools<T extends { name: string }>(pi: PiCodemode, tools: readonly T[]): T[] {
	return pi.getCodemodeCallableTools(tools).filter((tool) => tool.name !== PROGRAM_TOOL_NAME);
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
	const [codemode, pi] = await Promise.all([loadCodemode(), loadPiCodemode()]);
	const startedAt = performance.now();
	const { code, options: sourceOptions } = codemode.parseCodemodeSource(source);
	const calls: ProgramCall[] = [];
	let modelUsage: Usage | undefined;
	const addModelUsage = (usage: Usage) => {
		modelUsage = modelUsage ? pi.combineUsage(modelUsage, usage) : usage;
	};
	const snapshot = () => ({ calls: calls.map((call) => ({ ...call })) });
	const publish = () => options.onUpdate?.(snapshot());
	const callable = programCallableTools(pi, ctx.tools);
	const samples = new Map(callable.map((tool) => [tool.name, codemode.renderToolSample(pi.toCodemodeDeclaration(tool) as never)]));
	const sandboxTools: CodemodeTool[] = callable.map((tool) => ({
		name: tool.name,
		description: samples.get(tool.name),
		execute: async (args, { signal: callSignal }) => {
			const record: ProgramCall = { id: `${toolCallId}/?`, name: tool.name, args: previewArgs(args), status: "running" };
			calls.push(record);
			publish();
			const callStartedAt = performance.now();
			const outcome = await ctx.executeTool(tool.name, args, { signal: callSignal });
			record.id = outcome.toolCall.id;
			record.durationMs = performance.now() - callStartedAt;
			if (outcome.isError) {
				record.status = callSignal.aborted ? "cancelled" : "error";
				record.error = truncateText(textOf(outcome.result) || `Tool "${tool.name}" failed`, ERROR_PREVIEW_CHARS);
			} else {
				record.status = "ok";
			}
			publish();
			return toScriptValue(tool as { name: string; outputSchema?: unknown }, outcome as never);
		},
	}));
	const timeouts = [sourceOptions.timeoutMs, options.timeout === undefined ? undefined : options.timeout * 1000]
		.filter((value): value is number => value !== undefined);
	const sandbox = new codemode.CodemodeSandbox({
		tools: sandboxTools,
		globals: [
			...createDiscoveryGlobals(pi, codemode.toCodemodeIdentifier, callable, samples, options.getToolNamespace),
			...createModelGlobals(ctx.modelRegistry, toolCallId, calls, publish, addModelUsage),
			...(options.globals ?? []),
		],
		timeoutMs: timeouts.length > 0 ? Math.min(...timeouts) : Number.POSITIVE_INFINITY,
		memoryLimitBytes: MEMORY_LIMIT_BYTES,
		wasm: codemode.loadQuickJSWasm(pi.getQuickJSWasmPath()),
		workerUrl: pi.getCodemodeWorkerUrl(),
	});
	let result: CodemodeResult;
	try {
		const store = pi.readCodemodeStore(ctx.sessionManager.getBranch()) as never;
		result = await sandbox.execute(options.prepare ? options.prepare(code) : code, { signal, store });
	} finally {
		await sandbox.close();
	}
	for (const call of calls) {
		if (call.status === "running") call.status = "cancelled";
	}
	const items: Item[] = result.output.map((item) => item.type === "text" ? { type: "text", text: item.text } : item as Item);
	let outcome: ProgramOutcome;
	if (result.ok) {
		outcome = "completed";
		const { set, delete: deleted } = result.storeWrites;
		if (Object.keys(set).length > 0 || deleted.length > 0) options.appendEntry(pi.CODEMODE_STORE_ENTRY_TYPE, { set, delete: deleted });
		if (result.value !== undefined) items.push({ type: "text", text: valueText(result.value) });
	} else {
		outcome = result.error.kind === "timeout" || result.error.kind === "aborted" ? "stopped" : "failed";
		items.push({ type: "text", text: `Script error:\n${formatError(result, calls)}` });
	}
	const truncated = await truncateOutput(items, sourceOptions.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
	const wallTime = ((performance.now() - startedAt) / 1000).toFixed(1);
	const header = `${result.ok ? "Script completed" : "Script failed"}\nWall time ${wallTime} seconds\nOutput:\n`;
	const details: { calls: ProgramCall[]; fullOutputPath?: string } = snapshot();
	if (truncated.fullOutputPath) details.fullOutputPath = truncated.fullOutputPath;
	return {
		outcome,
		result: {
			content: [{ type: "text", text: header }, ...truncated.items],
			details,
			...(modelUsage ? { usage: modelUsage } : {}),
			...(result.ok ? {} : { isError: true }),
		},
	};
}

function createDiscoveryGlobals(
	pi: PiCodemode,
	toIdentifier: (name: string) => string,
	tools: readonly { name: string }[],
	samples: Map<string, string>,
	getToolNamespace: (name: string) => { name: string } | undefined,
): CodemodeTool[] {
	const ranker = new pi.Bm25Ranker();
	const entry = (name: string) => ({ name: toIdentifier(name), description: samples.get(name) ?? "" });
	return [
		{
			name: "searchTools",
			spread: true,
			execute: (args) => {
				const [query, searchOptions] = args as [unknown, { limit?: unknown; namespace?: unknown } | undefined];
				if (typeof query !== "string") throw new Error("searchTools() expects a query string");
				const limit = searchOptions?.limit ?? pi.DEFAULT_TOOL_SEARCH_LIMIT;
				if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) throw new Error("searchTools() limit must be a positive integer");
				const namespace = searchOptions?.namespace;
				if (namespace !== undefined && namespace !== null && typeof namespace !== "string") throw new Error("searchTools() namespace must be a string");
				const documents = tools.flatMap((tool) => {
					const toolNamespace = getToolNamespace(tool.name);
					if (namespace && toolNamespace?.name !== namespace) return [];
					return [pi.createToolSearchDocument(tool, toolNamespace)];
				});
				return ranker.rank(query, documents, limit).map((match) => entry(match.name));
			},
		},
		{
			name: "describeTool",
			spread: true,
			execute: (args) => {
				const [name] = args as [unknown];
				if (typeof name !== "string") throw new Error("describeTool() expects a tool name");
				const tool = tools.find((candidate) => candidate.name === name || toIdentifier(candidate.name) === name);
				return tool ? samples.get(tool.name) : undefined;
			},
		},
	];
}

function createModelGlobals(
	models: any,
	toolCallId: string,
	calls: ProgramCall[],
	publish: () => void,
	addUsage: (usage: Usage) => void,
): CodemodeTool[] {
	const limit = createLimiter(MAX_CONCURRENT_MODEL_CALLS);
	let classifyCount = 0;
	return [
		{
			name: "models.getModelsOfType",
			spread: true,
			execute: (args) => {
				const [type, provider] = args as [unknown, unknown];
				return models.getModelsOfType(toModelType(type), toProvider(provider)).map(toModelInfo);
			},
		},
		{
			name: "models.getAvailableOfType",
			spread: true,
			execute: async (args, { signal }) => {
				const [type, provider] = args as [unknown, unknown];
				return (await models.getAvailableOfType(toModelType(type), toProvider(provider), { signal })).map(toModelInfo);
			},
		},
		{
			name: "models.getModelOfType",
			spread: true,
			execute: (args) => {
				const [type, provider, id] = args as [unknown, unknown, unknown];
				if (typeof provider !== "string" || typeof id !== "string") throw new Error("models.getModelOfType() expects a type, a provider, and an id");
				const model = models.getModelOfType(toModelType(type), provider, id);
				return model === undefined ? undefined : toModelInfo(model);
			},
		},
		{
			name: "models.classify",
			spread: true,
			execute: async (args, { signal }) => {
				const [ref, context] = args as [{ provider?: unknown; id?: unknown } | null, unknown];
				if (typeof ref !== "object" || ref === null || typeof ref.provider !== "string" || typeof ref.id !== "string") {
					throw new Error("models.classify() expects a model from models.getModelOfType() or models.getAvailableOfType()");
				}
				// Only provider and id count. A script-supplied baseUrl or headers must never receive the credentials.
				const resolved = models.getModelOfType("classifier", ref.provider, ref.id);
				if (!resolved) throw new Error(`Unknown classifier model "${ref.provider}/${ref.id}"`);
				const record: ProgramCall = { id: `${toolCallId}/models.classify/${++classifyCount}`, name: "models.classify", args: `${resolved.provider}/${resolved.id}`, status: "running" };
				calls.push(record);
				publish();
				const startedAt = performance.now();
				const result: any = await limit(() => models.classify(resolved, context, { signal }));
				record.durationMs = performance.now() - startedAt;
				record.status = result.stopReason === "stop" ? "ok" : result.stopReason === "aborted" ? "cancelled" : "error";
				if (result.errorMessage) record.error = truncateText(result.errorMessage, ERROR_PREVIEW_CHARS);
				if (result.usage) {
					record.cost = result.usage.cost.total;
					addUsage(result.usage);
				}
				publish();
				return result;
			},
		},
	];
}
