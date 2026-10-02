import {
	AgentSession,
	AgentSessionRuntime,
	ExtensionRunner,
	getAgentDir,
	parseSessionEntries,
	SessionManager,
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
	Agents,
	customMessage,
	messageText,
	nodes,
	receivedMessageIds,
	restoredUsage,
	setTreeUsage,
	treeIdle,
	treeMetadata,
	treeUsage,
	usageEntry,
	type AgentNode,
	type Limits,
	type Usage,
} from "./agents/agents.ts";
import { registerAgentTool } from "./agents/tool.ts";
import { loadPiCodemode } from "./programs/codemode.ts";
import { PROGRAM_TOOL_NAME } from "./programs/execute.ts";
import { installHostPatches } from "./programs/host-patches.ts";
import { applyProgramOnlyFlag, PROGRAM_ONLY_FLAG } from "./programs/loadout.ts";
import { addProgramFiles, Programs } from "./programs/programs.ts";
import { registerProgramTools } from "./programs/tool.ts";
import { installGuard } from "./roots/guard.mjs";
import ownershipExtension from "./roots/ownership-extension.mjs";
import { rootPaths } from "./roots/paths.mjs";
import { createRootRuntime } from "./roots/runtime.ts";
import { waitForBackground } from "./roots/wait-ui.ts";

const DEFAULT_LIMITS: Limits = { maxConcurrent: 3, maxOutstanding: 8 };

interface Settings extends Limits {
	extensions: string[];
}

/** Reads the "pi-agents" section of the global settings.json. */
export function readSettings(agentDir: string): Settings {
	let section: Record<string, unknown> = {};
	try {
		const document = JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		const value = document["pi-agents"];
		if (value && typeof value === "object") section = value as Record<string, unknown>;
	} catch { /* missing settings use the defaults */ }
	const settings: Settings = { ...DEFAULT_LIMITS, extensions: [] };
	const { maxConcurrent = DEFAULT_LIMITS.maxConcurrent, maxOutstanding = DEFAULT_LIMITS.maxOutstanding, extensions = [] } = section;
	const positive = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;
	if (positive(maxConcurrent) && positive(maxOutstanding) && maxConcurrent <= maxOutstanding) {
		settings.maxConcurrent = maxConcurrent;
		settings.maxOutstanding = maxOutstanding;
	} else {
		console.warn(`[pi-agents] invalid maxConcurrent/maxOutstanding ${JSON.stringify({ maxConcurrent, maxOutstanding })}; using ${DEFAULT_LIMITS.maxConcurrent}/${DEFAULT_LIMITS.maxOutstanding}`);
	}
	if (Array.isArray(extensions) && extensions.every((entry) => typeof entry === "string")) {
		settings.extensions = [...new Set(extensions.map((entry) => path.resolve(agentDir, entry)))];
	} else {
		console.warn("[pi-agents] invalid extensions; expected an array of paths");
	}
	return settings;
}

function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1000000) return `${Math.round(value / 1000)}k`;
	return `${(value / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: Usage): string {
	return `${usage.turns} turns ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} R${formatTokens(usage.cacheRead)} W${formatTokens(usage.cacheWrite)} $${usage.cost.toFixed(4)}`;
}

const MIN_PI_VERSION = "1.0.0";

function olderThan(version: string, minimum: string): boolean {
	const a = version.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
	const b = minimum.split(".").map(Number);
	for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return (a[i] ?? 0) < b[i];
	return false;
}

export default async function (pi: ExtensionAPI): Promise<void> {
	if (olderThan(VERSION, MIN_PI_VERSION)) throw new Error(`pi-agents requires Pi ${MIN_PI_VERSION} or later, found ${VERSION}`);
	const agentDir = getAgentDir();
	const settings = readSettings(agentDir);
	const piCodemode = await loadPiCodemode();
	let node: AgentNode | undefined;
	let programs: Programs | undefined;
	let ctx: ExtensionContext | undefined;

	installGuard({ SessionManager, AgentSession, AgentSessionRuntime, parseSessionEntries, stateDir: rootPaths().ownership });
	installHostPatches(AgentSession, ExtensionRunner, PROGRAM_TOOL_NAME, piCodemode.codemodeSchema);
	const roots = createRootRuntime(pi, {
		receive: (message) => {
			const delivery = message.deliverAs ?? "followUp";
			node?.receive(messageText(message.sender, false, delivery, message.body), delivery, message.id);
		},
		treeIdle: () => node === undefined || treeIdle(node.rootId),
		receivedIds: receivedMessageIds,
	});
	ownershipExtension(pi, { start: (current: ExtensionContext) => roots.start(current), stop: () => roots.stop(), waitForBackground });

	const requireNode = (current: ExtensionContext): AgentNode => {
		if (!node) throw new Error("pi-agents is not initialized");
		ctx = current;
		node.agents.setContext(current);
		return node;
	};

	pi.registerFlag(PROGRAM_ONLY_FLAG, { type: "boolean", description: "Present tools as with codemode.mode \"only\": scripts reach them through program" });

	let warnedBothScriptTools = false;
	pi.on("session_start", (_event, current) => {
		applyProgramOnlyFlag(pi);
		warnedBothScriptTools = false;
		ctx = current;
		const id = current.sessionManager.getSessionId();
		const metadata = treeMetadata(current);
		const rootId = metadata?.rootId ?? id;
		const self = { id, rootId, scopeId: metadata?.scopeId ?? rootId, ownerId: metadata?.ownerId, name: () => pi.getSessionName() };
		const agents = new Agents(pi, self, agentDir, settings, settings.extensions);
		agents.setContext(current);
		agents.restore(current);
		node = {
			...self,
			agents,
			cwd: () => ctx?.cwd ?? current.cwd,
			busy: () => !(ctx?.isIdle() ?? true),
			sessionFile: () => ctx?.sessionManager.getSessionFile(),
			receive: (text, delivery, messageId) => {
				pi.sendMessage(customMessage(text, delivery, messageId), delivery === "write"
					? { deliverAs: "steer" }
					: { deliverAs: delivery, triggerTurn: true });
			},
			persistUsage: (usage) => {
				if (!metadata) pi.appendEntry(...usageEntry(usage));
			},
		};
		nodes.set(id, node);
		if (!metadata) setTreeUsage(id, restoredUsage(current));
		programs = new Programs({
			appendEntry: (customType, data) => pi.appendEntry(customType, data),
			notify: (text) => agents.notify(text),
		});
		programs.restore(current);
	});

	pi.on("before_agent_start", (_event, current) => {
		const active = pi.getActiveTools();
		if (warnedBothScriptTools || !active.includes(PROGRAM_TOOL_NAME) || !active.includes("codemode")) return;
		warnedBothScriptTools = true;
		current.ui.notify("Both `program` and `codemode` are active and do a similar job; disable `codemode` to avoid declaring the script API twice.", "warning");
	});

	pi.on("session_before_compact", (event) => {
		addProgramFiles(event.branchEntries as never, event.preparation.firstKeptEntryId, event.preparation.fileOps);
	});

	pi.on("session_shutdown", async () => {
		const closing = node;
		if (!closing) return;
		node = undefined;
		const stopping = programs;
		programs = undefined;
		try {
			await stopping?.shutdown();
			await closing.agents.shutdown();
		} finally {
			if (nodes.get(closing.id) === closing) nodes.delete(closing.id);
			if (closing.ownerId === undefined) setTreeUsage(closing.id, undefined);
		}
	});

	registerAgentTool(pi, { limits: settings, roots, requireNode });
	registerProgramTools(pi, { agentDir, settings, piCodemode, requireNode, programs: () => programs });

	pi.registerCommand("tasks", {
		description: "Show a summary of this Agent's owned Agents",
		handler: async (_args, current) => {
			const self = node;
			const { busy, queued, unread } = self?.agents.summary() ?? { busy: 0, queued: 0, unread: 0 };
			const counts = ([[busy, "busy"], [queued, "queued inputs"], [unread, "unread results"]] as const)
				.filter(([count]) => count > 0)
				.map(([count, text]) => `${count} ${text}`)
				.join(" · ") || "0";
			const { running, unreturned } = programs?.summary() ?? { running: 0, unreturned: 0 };
			const programCounts = ([[running, "running"], [unreturned, "unreturned results"]] as const)
				.filter(([count]) => count > 0)
				.map(([count, text]) => `${count} ${text}`)
				.join(" · ");
			const lines = [`Agents: ${counts}`, ...(programCounts ? [`Programs: ${programCounts}`] : []), `Usage: ${formatUsage(treeUsage(self?.rootId ?? ""))}`];
			current.ui.notify(lines.join("\n"), "info");
		},
	});
}
