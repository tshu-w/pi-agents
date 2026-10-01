import { randomBytes } from "node:crypto";
import type { CodemodeTool } from "@earendil-works/pi-codemode";

export interface AgentOptions {
	name?: string;
	cwd?: string;
	context?: "fresh" | "fork";
	model?: string;
	thinkingLevel?: string;
}

export interface SendOptions {
	deliverAs?: "followUp" | "steer" | "write";
	schema?: unknown;
}

/** What `agent()` and its handles do on the host. */
export interface ProgramAgentHost {
	create(id: string, name: string, options: AgentOptions, signal: AbortSignal): Promise<void>;
	send(id: string, message: string, options: SendOptions, signal: AbortSignal): Promise<unknown>;
	abort(id: string): Promise<void>;
}

// One line, so line numbers in errors match the script as written. The ID is
// a UUIDv7 made in the script because `agent()` returns its handle before the
// host has created the Agent. QuickJS seeds Math.random from the clock, so
// the random bits come from the host, and a counter keeps them apart within
// the Program.
function agentPrefix(): string {
	const bytes = randomBytes(10);
	const randA = (bytes.readUInt16BE(0) & 0x0fff).toString(16).padStart(3, "0");
	const randB = (0x8000 | (bytes.readUInt16BE(2) & 0x3fff)).toString(16);
	const tail = bytes.readUIntBE(4, 6);
	return [
		"const agent = ((create, send, abort) => {",
		"const names = new Set(); let count = 0; let serial = 0;",
		"const hex = (value, length) => Math.floor(value).toString(16).padStart(length, '0');",
		`const newId = () => { const time = Date.now(); const tail = (${tail} + ++serial) % 2 ** 48; return \`\${hex(time / 2 ** 16, 8)}-\${hex(time % 2 ** 16, 4)}-7${randA}-${randB}-\${hex(tail, 12)}\`; };`,
		"return (options = {}) => {",
		"let name = options.name;",
		"if (name === undefined) { do name = `agent-${++count}`; while (names.has(name)); }",
		"names.add(name);",
		"const id = newId();",
		"create(id, name, options).catch(() => {});",
		"return Object.freeze({ id, name, send: (message, sendOptions) => send(id, message, sendOptions), abort: () => abort(id) });",
		"};",
		"})(__agent.create, __agent.send, __agent.abort);",
	].join(" ");
}

export function withAgentPrefix(code: string): string {
	return `${agentPrefix()}${code}`;
}

/** Globals behind `agent()`. A handle's calls wait for its Agent to be created. */
export function agentGlobals(host: ProgramAgentHost): CodemodeTool[] {
	const created = new Map<string, Promise<void>>();
	const ready = (id: string) => created.get(id) ?? Promise.reject(new Error(`Unknown Agent ${id}`));
	return [
		{
			name: "__agent.create",
			spread: true,
			execute: (args, { signal }) => {
				const [id, name, options] = args as [string, string, AgentOptions];
				const creation = host.create(id, name, options ?? {}, signal);
				created.set(id, creation);
				return creation;
			},
		},
		{
			name: "__agent.send",
			spread: true,
			execute: async (args, { signal }) => {
				const [id, message, options] = args as [string, string, SendOptions | undefined];
				await ready(id);
				return host.send(id, message, options ?? {}, signal);
			},
		},
		{
			name: "__agent.abort",
			spread: true,
			execute: async (args) => {
				const [id] = args as [string];
				await ready(id);
				await host.abort(id);
			},
		},
	];
}
