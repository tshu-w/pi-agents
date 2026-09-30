import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

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
	CODEMODE_STORE_ENTRY_TYPE: string;
	MODEL_GLOBAL_DECLARATIONS: Array<{ name: string; description: string; signature: string }>;
	createCodemodeDescription(tools: unknown[], options?: Record<string, unknown>): string;
	getCodemodeCallableTools<T extends { name: string }>(tools: readonly T[]): T[];
	toCodemodeDeclaration(tool: unknown): { name: string; description: string; inputSchema: unknown; outputSchema: unknown };
	readCodemodeStore(branch: unknown[]): Record<string, unknown>;
	getCodemodeWorkerUrl(): URL | undefined;
	getQuickJSWasmPath(): string;
	Bm25Ranker: new () => { rank(query: string, documents: unknown[], limit: number): Array<{ name: string }> };
	createToolSearchDocument(tool: unknown, namespace: unknown): unknown;
	DEFAULT_TOOL_SEARCH_LIMIT: number;
	combineUsage<T>(first: T, second: T): T;
}

let internals: Promise<PiCodemode> | undefined;

/** Loads those parts from Pi's `dist/` by path, so Programs match Pi's script API. */
export function loadPiCodemode(): Promise<PiCodemode> {
	internals ??= (async () => {
		const dist = join(getPackageDir(), "dist");
		const load = (file: string) => import(pathToFileURL(join(dist, file)).href);
		const [tool, execute, config, search, usage] = await Promise.all([
			load("extensions/codemode/tool.js"),
			load("extensions/codemode/execute.js"),
			load("config.js"),
			load("extensions/tool-search/tool.js"),
			load("core/usage-totals.js"),
		]);
		return {
			CODEMODE_STORE_ENTRY_TYPE: tool.CODEMODE_STORE_ENTRY_TYPE,
			MODEL_GLOBAL_DECLARATIONS: tool.MODEL_GLOBAL_DECLARATIONS,
			createCodemodeDescription: tool.createCodemodeDescription,
			getCodemodeCallableTools: tool.getCodemodeCallableTools,
			toCodemodeDeclaration: tool.toCodemodeDeclaration,
			readCodemodeStore: execute.readCodemodeStore,
			getCodemodeWorkerUrl: config.getCodemodeWorkerUrl,
			getQuickJSWasmPath: config.getQuickJSWasmPath,
			Bm25Ranker: search.Bm25Ranker,
			createToolSearchDocument: search.createToolSearchDocument,
			DEFAULT_TOOL_SEARCH_LIMIT: search.DEFAULT_TOOL_SEARCH_LIMIT,
			combineUsage: usage.combineUsage,
		};
	})();
	return internals;
}
