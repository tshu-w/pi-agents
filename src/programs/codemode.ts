import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getKeybindings } from "@earendil-works/pi-tui";
import { getPackageDir, type AgentToolResult, type AgentToolUpdateCallback, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";

type Codemode = typeof import("@earendil-works/pi-codemode");

export const CODEMODE_TOOL_NAME = "codemode";

let loaded: Promise<Codemode> | undefined;

/** Imports a package from Pi's own dependencies rather than the copy Pi aliases for extensions. */
function importPiDependency(name: string) {
	const dirs = createRequire(join(getPackageDir(), "package.json")).resolve.paths(name) ?? [];
	const entry = dirs.map((dir) => join(dir, name, "dist/index.js")).find(existsSync);
	if (!entry) throw new Error(`pi-agents requires Pi with ${name}`);
	return import(pathToFileURL(entry).href);
}

/** Pi ships `@earendil-works/pi-codemode` but does not alias it for extensions, so load Pi's copy. */
export function loadCodemode(): Promise<Codemode> {
	loaded ??= importPiDependency("@earendil-works/pi-codemode");
	return loaded;
}

/** Parts of Pi's `codemode` tool that its package entry does not export. */
export interface PiCodemode {
	/** Pi's `codemode` tool definition; `program` reuses its `prepareLoadout`. */
	createCodemodeToolDefinition(options: Record<string, unknown>): ToolDefinition;
	createCodemodeDescription(tools: unknown[], options?: Record<string, unknown>): string;
	/** The `codemode` parameter schema, by which the MCP extension recognizes the tool. */
	codemodeSchema: unknown;
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
		const [tool, execute, renderer, tui] = await Promise.all([
			load("extensions/codemode/tool.js"),
			load("extensions/codemode/execute.js"),
			load("extensions/codemode/renderer.js"),
			importPiDependency("@earendil-works/pi-tui"),
		]);
		return {
			createCodemodeToolDefinition: tool.createCodemodeToolDefinition,
			createCodemodeDescription: tool.createCodemodeDescription,
			codemodeSchema: tool.codemodeSchema,
			executeCodemode: execute.executeCodemode,
			// A bundled Pi keeps its keybindings in its embedded pi-tui, which `dist/` does not import;
			// share them so key hints name the configured keys.
			renderResult(...args: unknown[]) {
				tui.setKeybindings(getKeybindings());
				return renderer.codemodeRenderers.renderResult(...args);
			},
		};
	})();
	return internals;
}
