import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir, type AgentToolResult, type AgentToolUpdateCallback, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";

type Codemode = typeof import("@earendil-works/pi-codemode");

let loaded: Promise<Codemode> | undefined;

/** Pi ships `@earendil-works/pi-codemode` but does not alias it for extensions, so load Pi's copy. */
export function loadCodemode(): Promise<Codemode> {
	loaded ??= (async () => {
		const dirs = createRequire(join(getPackageDir(), "package.json")).resolve.paths("@earendil-works/pi-codemode") ?? [];
		const entry = dirs.map((dir) => join(dir, "@earendil-works/pi-codemode/dist/index.js")).find(existsSync);
		if (!entry) throw new Error("pi-agents requires Pi with @earendil-works/pi-codemode");
		return import(pathToFileURL(entry).href);
	})();
	return loaded;
}

/** Parts of Pi's `codemode` tool that its package entry does not export. */
export interface PiCodemode {
	/** Pi's `codemode` tool definition; `program` reuses its `prepareLoadout`. */
	createCodemodeToolDefinition(options: Record<string, unknown>): ToolDefinition;
	createCodemodeDescription(tools: unknown[], options?: Record<string, unknown>): string;
	executeCodemode(
		toolCallId: string,
		input: { code: string },
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<unknown> | undefined,
		ctx: ExtensionToolContext,
		options: Record<string, unknown>,
	): Promise<AgentToolResult<unknown> & { isError?: boolean }>;
	/** Renders a script result: its nested calls, then its output without the header. */
	renderResult(result: unknown, options: unknown, theme: unknown, context: unknown): unknown;
}

let internals: Promise<PiCodemode> | undefined;

/** Loads those parts from Pi's `dist/` by path, so Programs match Pi's script API. */
export function loadPiCodemode(): Promise<PiCodemode> {
	internals ??= (async () => {
		const dist = join(getPackageDir(), "dist");
		const load = (file: string) => import(pathToFileURL(join(dist, file)).href);
		const [tool, execute, renderer] = await Promise.all([
			load("extensions/codemode/tool.js"),
			load("extensions/codemode/execute.js"),
			load("extensions/codemode/renderer.js"),
		]);
		return {
			createCodemodeToolDefinition: tool.createCodemodeToolDefinition,
			createCodemodeDescription: tool.createCodemodeDescription,
			executeCodemode: execute.executeCodemode,
			renderResult: renderer.codemodeRenderers.renderResult,
		};
	})();
	return internals;
}
