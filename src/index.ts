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
import { Agents, type Limits } from "./agents/agents.ts";
import {
	customMessage,
	liveWork,
	messageText,
	rememberRoots,
	visibleIds,
	nodes,
	receivedMessageIds,
	treeIdle,
	treeMetadata,
	type AgentNode,
} from "./agents/registry.ts";
import { registerAgentTool } from "./agents/tool.ts";
import { hostExtension } from "./host/extension.ts";
import { CODEMODE_TOOL_NAME, loadPiCodemode } from "./programs/codemode.ts";
import { PROGRAM_TOOL_NAME } from "./programs/execute.ts";
import { installHostPatches } from "./programs/host-patches.ts";
import { applyProgramOnlyFlag, PROGRAM_ONLY_FLAG } from "./programs/loadout.ts";
import { addProgramFiles, Programs } from "./programs/programs.ts";
import { registerProgramTools } from "./programs/tool.ts";
import { installGuard } from "./roots/guard.mjs";
import lockExtension from "./roots/lock-extension.mjs";
import { statePaths } from "./roots/paths.mjs";
import { createReporter } from "./roots/report.ts";
import { createRootRuntime } from "./roots/runtime.ts";
import { createPanel } from "./ui/panel.ts";
import { openAgentViewer } from "./ui/viewer.ts";

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

const MIN_PI_VERSION = "1.0.0";
/** How long a root process may take to clean up on exit before it is killed. */
const EXIT_GRACE_MS = 30_000;

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
	const panel = createPanel(() => node);

	installGuard({ SessionManager, AgentSession, AgentSessionRuntime, parseSessionEntries, stateDir: statePaths().locks });
	installHostPatches(AgentSession, ExtensionRunner, piCodemode.codemodeSchema);
	const roots = createRootRuntime(pi, {
		receive: async (message) => {
			const delivery = message.deliverAs ?? "followUp";
			// The user's message from the workbench arrives as if typed in Pi's editor.
			if (message.user) return pi.sendUserMessage(message.body, { deliverAs: delivery === "steer" ? "steer" : "followUp" });
			// The header names the sender by a short ID unique among the roots this root sees.
			rememberRoots((await roots.roots()).map((root) => root.id));
			if (node) node.receive(messageText(message.sender!, false, delivery, message.body, visibleIds(node.scopeId, true)), delivery, message.id);
		},
		treeIdle: () => node === undefined || treeIdle(node.rootId),
		receivedIds: receivedMessageIds,
	});
	lockExtension(pi, { start: (current: ExtensionContext) => roots.start(current), stop: () => roots.stop(), runner: ExtensionRunner });
	const idle = () => node === undefined || treeIdle(node.rootId);
	const host = hostExtension(pi, { treeIdle: idle });
	createReporter(pi, { treeIdle: idle, liveWork: () => node ? liveWork(node) : 0, host });
	// Event bus handlers run synchronously, so an extension that emits a query object reads the answer right after emit.
	pi.events.on("busy:query", (query) => {
		if (node && !treeIdle(node.rootId)) (query as { busy: boolean }).busy = true;
	});

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
		};
		nodes.set(id, node);
		programs = new Programs(rootId, {
			appendEntry: (customType, data) => pi.appendEntry(customType, data),
			notify: (text) => agents.notify(text),
			changed: () => panel.update(),
		});
		programs.restore(current);
		panel.start(current);
	});

	pi.on("before_agent_start", (_event, current) => {
		const active = pi.getActiveTools();
		if (warnedBothScriptTools || !active.includes(PROGRAM_TOOL_NAME) || !active.includes(CODEMODE_TOOL_NAME)) return;
		warnedBothScriptTools = true;
		current.ui.notify("Both `program` and `codemode` are active and do a similar job; disable `codemode` to avoid declaring the script API twice.", "warning");
	});

	pi.on("session_before_compact", (event) => {
		addProgramFiles(event.branchEntries as never, event.preparation.firstKeptEntryId, event.preparation.fileOps);
	});

	pi.on("session_shutdown", async (event) => {
		const closing = node;
		if (!closing) return;
		if (event.reason === "quit" && closing.ownerId === undefined) {
			setTimeout(() => {
				console.error(`[pi-agents] Cleanup did not finish within ${EXIT_GRACE_MS / 1000}s; killing the process.`);
				process.kill(process.pid, "SIGKILL");
			}, EXIT_GRACE_MS).unref();
		}
		panel.stop();
		node = undefined;
		const stopping = programs;
		programs = undefined;
		try {
			const results = await Promise.allSettled([stopping?.shutdown(), closing.agents.shutdown()]);
			const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
			if (errors.length > 0) throw new Error(errors.map((error) => error instanceof Error ? error.message : String(error)).join("\n"));
		} finally {
			if (nodes.get(closing.id) === closing) nodes.delete(closing.id);
		}
	});

	registerAgentTool(pi, { limits: settings, roots, requireNode });
	registerProgramTools(pi, { agentDir, settings, piCodemode, requireNode, programs: () => programs });

	pi.registerCommand("tasks", {
		description: "Hide or show the task panel",
		handler: async () => panel.toggle(),
	});

	pi.registerCommand("agents", {
		description: "Open an owned Agent to watch and talk to it",
		handler: async (_args, current) => {
			if (node) await openAgentViewer(current, requireNode(current), pi.getSettings().editorPaddingX ?? 0);
		},
	});
}
