/** The Agents loaded in this process, shared across trees: who sees whom, how targets resolve, and how messages are addressed. */
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Agents } from "./agents.ts";
import { TreeScheduler } from "./scheduler.ts";

export const MESSAGE_TYPE = "pi-agents";
export const TREE_ENTRY = "pi-agents-tree";

export type AgentState = "running" | "waiting" | "queued" | "idle";
export type Delivery = "followUp" | "steer" | "write";

/** An Agent loaded in this process: a root Session or an owned child Session. */
export interface AgentNode {
	id: string;
	rootId: string;
	/** The node whose tree this node sees: its root, or the Program its Agents belong to. */
	scopeId: string;
	ownerId?: string;
	/** A Program that owns Agents; no Agent sees it, but the user sees it in the task panel and the task viewer. */
	program?: boolean;
	/** Whether a Program runs in the background. */
	background?: boolean;
	/** When a Program started. */
	createdAt?: string;
	/** What the replies of a Program's Agents and the Agents under them have cost since it started. */
	spent?: Spend;
	name(): string | undefined;
	cwd(): string;
	busy(): boolean;
	sessionFile(): string | undefined;
	agents: Agents;
	/** Delivers a message to this node; used only for root Agents. */
	receive(text: string, delivery: Delivery, messageId?: string, sender?: Sender): void;
	/** A root Agent's turn was stopped: messages from other Agents become writes until the user's next input. */
	stopped?: boolean;
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
	/** Work that keeps a tree busy, by the ID of its root. */
	work?: Map<symbol, string>;
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
const work = shared.work ??= new Map();

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

/** Keeps a tree busy until the returned function is called. */
export function trackTreeWork(rootId: string): () => void {
	const token = Symbol(rootId);
	work.set(token, rootId);
	treeChanged();
	return () => {
		if (work.delete(token)) treeChanged();
	};
}

/** What replies cost: dollars, input and output tokens, and whether a reply had no price. */
export interface Spend {
	cost: number;
	tokens: number;
	unpriced: boolean;
}

export function addSpend(spend: Spend, usage: Usage): void {
	spend.cost += usage.cost.total;
	spend.tokens += usage.input + usage.output;
	if (usage.cost.total === 0 && usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0) spend.unpriced = true;
}

/** Adds a reply of an Agent owned by `ownerId` to the Programs above it. */
export function addProgramSpend(ownerId: string, usage: Usage): void {
	for (let node = shared.nodes.get(ownerId); node; node = node.ownerId === undefined ? undefined : shared.nodes.get(node.ownerId)) {
		if (node.spent) addSpend(node.spent, usage);
	}
}

/** The Programs a node runs, oldest first. */
export function programsOf(node: AgentNode): AgentNode[] {
	return [...shared.nodes.values()]
		.filter((program) => program.program && program.ownerId === node.id)
		.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

/** The node's running owned Agents and background Programs, with those under them. */
export function liveWork(node: AgentNode): number {
	let count = 0;
	for (const entry of node.agents.owned()) {
		if (entry.state !== "idle") count += 1;
		const loaded = shared.nodes.get(entry.id);
		if (loaded) count += liveWork(loaded);
	}
	for (const program of programsOf(node)) {
		if (program.background) count += 1;
		count += liveWork(program);
	}
	return count;
}

/** `Program <short ID>`, unique among its caller's running Programs. */
export function programLabel(program: AgentNode): string {
	const owner = program.ownerId === undefined ? undefined : shared.nodes.get(program.ownerId);
	return `Program ${shortId(program.id, owner ? programsOf(owner).map((other) => other.id) : [])}`;
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
	// A Program's Agent heads its own scope; it stays owned, so messages to it go through its owner.
	const owned = root.ownerId === undefined ? undefined : shared.nodes.get(root.ownerId)?.agents.owned().find((agent) => agent.id === root.id);
	const entries: Entry[] = root.program ? [] : [owned ? { ...owned, ownerId: root.ownerId } : {
		id: root.id,
		name: root.name(),
		cwd: root.cwd(),
		state: root.busy() || !treeIdle(root.rootId) ? "running" : "idle",
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
	const by = from && sender(from, ids);
	if (target.ownerId === undefined) {
		const node = shared.nodes.get(target.id);
		if (!node) throw new Error(`${label(target, ids)} is offline.`);
		node.receive(text, delivery, undefined, by);
		return { queued: false };
	}
	const owner = shared.nodes.get(target.ownerId);
	if (!owner) throw new Error(`${label(target, ids)} is offline.`);
	return owner.agents.accept(target.id, text, delivery, { fromOwner, notification: from === undefined, sender: by });
}

export const MESSAGE_TAG = "agent-message";
const REPLY_NOTE = ' note="Reply with send"';

/** The sender of a message as its element names it: its name and its short ID among the recipient's visible Agents. */
export interface Sender {
	id: string;
	name?: string;
}

export function sender(from: { id: string; name?: string }, ids: Iterable<string>): Sender {
	return { id: shortId(from.id, ids), ...(from.name === undefined ? {} : { name: from.name }) };
}

/** The element a sender's message opens with, naming the sender as `agent-result` names its Agent. */
function messageOpen({ id, name }: Sender): string {
	return `<${MESSAGE_TAG}${name === undefined ? "" : ` name="${name}"`} id="${id}"`;
}

/** A message in an element naming its sender; an input from a sender other than the owner asks for a reply. */
export function messageText(from: { id: string; name?: string }, fromOwner: boolean, delivery: Delivery, body: string, ids: Iterable<string>): string {
	const note = !fromOwner && delivery !== "write" ? REPLY_NOTE : "";
	return `${messageOpen(sender(from, ids))}${note}>\n${body}\n</${MESSAGE_TAG}>`;
}

/** The body of a message `messageText` made for `sender`, or undefined if `text` is not one. */
export function messageBody(text: string, sender: Sender): string | undefined {
	const open = messageOpen(sender);
	const close = `\n</${MESSAGE_TAG}>`;
	const header = [`${open}>\n`, `${open}${REPLY_NOTE}>\n`].find((start) => text.startsWith(start));
	return header && text.length >= header.length + close.length && text.endsWith(close) ? text.slice(header.length, -close.length) : undefined;
}

/**
 * `messageId` marks a message from a root Agent in another process, so it is added once; `user`
 * marks the user's input from the task viewer, and `sender` the Agent that sent it.
 */
export function customMessage(text: string, delivery: Delivery, { messageId, user, sender }: { messageId?: string; user?: boolean; sender?: Sender } = {}) {
	return { customType: MESSAGE_TYPE, content: text, display: true, details: { delivery, ...(messageId ? { messageId } : {}), ...(user ? { user } : {}), ...(sender ? { sender } : {}) } };
}

export function receivedMessageIds(ctx: ExtensionContext): string[] {
	return ctx.sessionManager.getEntries().flatMap((entry) =>
		entry.type === "custom_message" && entry.customType === MESSAGE_TYPE && typeof (entry.details as { messageId?: unknown })?.messageId === "string"
			? [(entry.details as { messageId: string }).messageId]
			: []);
}

/** Whether a tree has no live work: unended inputs, owned Agents that are not idle, background Programs, or undelivered notifications. */
export function treeIdle(rootId: string): boolean {
	return shared.scheduler.outstanding(rootId) === 0 &&
		![...work.values()].includes(rootId) &&
		![...shared.nodes.values()].some((node) => node.rootId === rootId && node.agents.live());
}
