/** The Agents loaded in this process, shared across trees: who sees whom, how targets resolve, and how messages are addressed. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Agents } from "./agents.ts";
import { TreeScheduler } from "./scheduler.ts";

export const MESSAGE_TYPE = "pi-agents";
export const TREE_ENTRY = "pi-agents-tree";

export type AgentState = "busy" | "idle" | "offline";
export type Delivery = "followUp" | "steer" | "write";

/** An Agent loaded in this process: a root Session or an owned child Session. */
export interface AgentNode {
	id: string;
	rootId: string;
	/** The node whose tree this node sees: its root, or the Program its Agents belong to. */
	scopeId: string;
	ownerId?: string;
	/** A Program that owns Agents; it is not an Agent and no Agent sees it. */
	program?: boolean;
	name(): string | undefined;
	cwd(): string;
	busy(): boolean;
	sessionFile(): string | undefined;
	agents: Agents;
	/** Delivers a message to this node; used only for root Agents. */
	receive(text: string, delivery: Delivery, messageId?: string): void;
}

export interface Entry {
	id: string;
	name?: string;
	ownerId?: string;
	cwd: string;
	state: AgentState;
	sessionFile?: string;
	/** When an owned Agent was spawned. */
	createdAt?: string;
	/** A root Agent loaded in another process. */
	remote?: boolean;
}

interface Shared {
	scheduler: TreeScheduler;
	nodes: Map<string, AgentNode>;
	listeners?: Set<() => void>;
	/** The other root Agents last listed, for short IDs shown to a root Agent. */
	rootIds?: string[];
}

const shared = ((globalThis as Record<symbol, unknown>)[Symbol.for("pi-agents:runtime")] ??= {
	scheduler: new TreeScheduler(),
	nodes: new Map(),
}) as Shared;
// Child Sessions load their own copy of this module; keep shared state but adopt current methods.
Object.setPrototypeOf(shared.scheduler, TreeScheduler.prototype);
const listeners = shared.listeners ??= new Set();

export const nodes = shared.nodes;
export const scheduler = shared.scheduler;

/** Calls `listener` when an Agent's state or inputs change in any tree of this process. */
export function onTreeChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function treeChanged(): void {
	for (const listener of listeners) listener();
}

/** The shortest prefix of `id`, at least 8 characters, that none of the other `ids` starts with. */
export function shortId(id: string, ids: Iterable<string>): string {
	let length = Math.min(8, id.length);
	for (const other of ids) {
		while (other !== id && length < id.length && other.startsWith(id.slice(0, length))) length++;
	}
	return id.slice(0, length);
}

/** An Agent's name and short ID among `ids`, the IDs of the Agents visible to the reader. */
export function label(agent: { id: string; name?: string }, ids: Iterable<string>): string {
	const id = shortId(agent.id, ids);
	return agent.name ? `${agent.name} (${id})` : id;
}

export function entryLine(entry: Entry, ids: Iterable<string>): string {
	return `${label(entry, ids)}  ${entry.state}  ${entry.cwd}`;
}

export function rememberRoots(ids: string[]): void {
	shared.rootIds = ids;
}

/** IDs of the Agents visible to an Agent with the given scope; a root Agent also sees the other roots. */
export function visibleIds(scopeId: string, root: boolean): string[] {
	const ids = treeEntries(scopeId).map((entry) => entry.id);
	return root ? [...ids, ...(shared.rootIds ?? [])] : ids;
}

/** IDs of the Agents visible to `target`. */
function recipientIds(target: Entry): string[] {
	if (target.ownerId === undefined) return visibleIds(target.id, true);
	const owner = shared.nodes.get(target.ownerId);
	return visibleIds(owner?.program ? target.id : owner?.scopeId ?? target.id, false);
}

export interface TreeMetadata {
	rootId: string;
	ownerId: string;
	scopeId?: string;
}

/** Owner, root, and scope recorded in an owned Agent's Session. */
export function treeMetadata(ctx: ExtensionContext): TreeMetadata | undefined {
	let metadata: TreeMetadata | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === TREE_ENTRY) metadata = entry.data as typeof metadata;
	}
	return metadata;
}

/** Visible Agents of a scope, its root first, then owned Agents depth-first. */
export function treeEntries(scopeId: string): Entry[] {
	const root = shared.nodes.get(scopeId);
	if (!root) return [];
	const entries: Entry[] = root.program ? [] : [{
		id: root.id,
		name: root.name(),
		cwd: root.cwd(),
		state: root.busy() ? "busy" : "idle",
		sessionFile: root.sessionFile(),
	}];
	const visit = (node: AgentNode) => {
		for (const agent of node.agents.owned()) {
			entries.push({ ...agent, ownerId: node.id });
			const loaded = shared.nodes.get(agent.id);
			if (loaded) visit(loaded);
		}
	};
	visit(root);
	return entries;
}

export function resolveTarget(scopeId: string, target: string): Entry {
	return resolveIn(treeEntries(scopeId), target);
}

/** Resolves an ID, a name, or a unique ID prefix among the given visible Agents. */
export function resolveIn(entries: Entry[], target: string): Entry {
	const byId = entries.find((entry) => entry.id === target);
	if (byId) return byId;
	let matches = entries.filter((entry) => entry.name === target);
	if (matches.length === 0) matches = entries.filter((entry) => entry.id.startsWith(target));
	if (matches.length === 0) throw new Error(`No visible Agent matches "${target}". Use list to find Agents.`);
	if (matches.length > 1) {
		const ids = entries.map((entry) => entry.id);
		throw new Error(`"${target}" matches several Agents:\n${matches.map((entry) => entryLine(entry, ids)).join("\n")}\n\nRetry with a longer ID prefix.`);
	}
	return matches[0]!;
}

/** Sends a message from one Agent to another visible Agent. */
export function deliver(
	from: { id: string; name?: string } | undefined,
	target: Entry,
	delivery: Delivery,
	body: string,
): { queued: boolean } {
	const fromOwner = from !== undefined && target.ownerId === from.id;
	const ids = recipientIds(target);
	const text = from === undefined ? body : messageText(from, fromOwner, delivery, body, ids);
	if (target.ownerId === undefined) {
		const node = shared.nodes.get(target.id);
		if (!node) throw new Error(`${label(target, ids)} is offline.`);
		node.receive(text, delivery);
		return { queued: false };
	}
	const owner = shared.nodes.get(target.ownerId);
	if (!owner) throw new Error(`${label(target, ids)} is offline.`);
	return owner.agents.accept(target.id, text, delivery, { fromOwner, notification: from === undefined });
}

export const MESSAGE_TAG = "agent-message";

/** A message in an element naming its sender; an input from a sender other than the owner asks for a reply. */
export function messageText(from: { id: string; name?: string }, fromOwner: boolean, delivery: Delivery, body: string, ids: Iterable<string>): string {
	const note = !fromOwner && delivery !== "write" ? ' note="Reply with send"' : "";
	return `<${MESSAGE_TAG} from="${from.name ?? shortId(from.id, ids)}" id="${shortId(from.id, ids)}"${note}>\n${body}\n</${MESSAGE_TAG}>`;
}

/**
 * `messageId` marks a message from a root Agent in another process, so it is added once; `user`
 * marks the user's input from the Agent viewer.
 */
export function customMessage(text: string, delivery: Delivery, messageId?: string, user?: boolean) {
	return { customType: MESSAGE_TYPE, content: text, display: true, details: { delivery, ...(messageId ? { messageId } : {}), ...(user ? { user } : {}) } };
}

export function receivedMessageIds(ctx: ExtensionContext): string[] {
	return ctx.sessionManager.getEntries().flatMap((entry) =>
		entry.type === "custom_message" && entry.customType === MESSAGE_TYPE && typeof (entry.details as { messageId?: unknown })?.messageId === "string"
			? [(entry.details as { messageId: string }).messageId]
			: []);
}

/** Whether a tree has no inputs that have not ended. */
export function treeIdle(rootId: string): boolean {
	return shared.scheduler.outstanding(rootId) === 0;
}
