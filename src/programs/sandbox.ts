import { randomBytes } from "node:crypto";
import type { CodemodeTool } from "@earendil-works/pi-codemode";
import type { CallTracker } from "./execute.ts";

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
	timeout?: number;
}

/** What `agent()` and its handles do on the host. */
export interface ProgramAgentHost {
	create(id: string, name: string, options: AgentOptions): Promise<void>;
	send(id: string, message: string, options: SendOptions): Promise<unknown>;
	abort(id: string): Promise<void>;
}

// One line, so line numbers in errors match the script as written. The ID is
// a UUIDv4 made in the script because `agent()` returns its handle before the
// host has created the Agent. QuickJS seeds Math.random from the clock, so
// the random bits come from the host; a counter, spread by an odd multiplier,
// gives each Agent of the Program a distinct first group.
function agentPrefix(): string {
	const bytes = randomBytes(16);
	bytes[6] = 0x40 | (bytes[6]! & 0x0f);
	bytes[8] = 0x80 | (bytes[8]! & 0x3f);
	const hex = bytes.toString("hex");
	const head = bytes.readUInt32BE(0);
	const rest = `${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	return [
		"const agent = ((create, send, abort) => {",
		"const names = new Set(); let count = 0; let serial = 0;",
		`const newId = () => \`\${((${head} + ++serial * 2654435761) % 2 ** 32).toString(16).padStart(8, '0')}-${rest}\`;`,
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

/** Globals behind `agent()`. A handle's calls wait for its Agent to be created; `track` records each `send()`. */
export function agentGlobals(host: ProgramAgentHost, track: CallTracker): CodemodeTool[] {
	const created = new Map<string, Promise<void>>();
	const names = new Map<string, string>();
	const ready = (id: string) => created.get(id) ?? Promise.reject(new Error(`Unknown Agent ${id}`));
	return [
		{
			name: "__agent.create",
			spread: true,
			execute: (args) => {
				const [id, name, options] = args as [string, string, AgentOptions];
				names.set(id, name);
				const creation = host.create(id, name, options ?? {});
				created.set(id, creation);
				return creation;
			},
		},
		{
			name: "__agent.send",
			spread: true,
			execute: async (args) => {
				const [id, message, options] = args as [string, string, SendOptions | undefined];
				// Recorded from the start, so a send whose Agent fails to be created shows too.
				const end = track(`agent ${names.get(id) ?? id}`, JSON.stringify(message) ?? "");
				try {
					await ready(id);
					const value = await host.send(id, message, options ?? {});
					end("ok");
					return value;
				} catch (error) {
					end((error as { cancelled?: boolean }).cancelled ? "cancelled" : "error", error instanceof Error ? error.message : String(error));
					throw error;
				}
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
