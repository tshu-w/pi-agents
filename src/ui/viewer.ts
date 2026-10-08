import {
	AssistantMessageComponent,
	CompactionSummaryMessageComponent,
	CustomEditor,
	CustomMessageComponent,
	DynamicBorder,
	FooterComponent,
	getMarkdownTheme,
	getSelectListTheme,
	keyText,
	ToolExecutionComponent,
	UserMessageComponent,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	Loader,
	matchesKey,
	SelectList,
	Spacer,
	Text,
	truncateToWidth,
	type Component,
	type Focusable,
	type KeybindingsManager,
	type SelectItem,
	type TUI,
} from "@earendil-works/pi-tui";
import { MESSAGE_TYPE, nodes, onTreeChange, programLabel, programsOf, type AgentNode, type Entry } from "../agents/registry.ts";
import { firstInput } from "../agents/search.ts";
import { execFileSync } from "node:child_process";

type Message = AgentSession["messages"][number];
type ToolResult = Parameters<ToolExecutionComponent["updateResult"]>[0];
type StatusIndicator = Parameters<CustomEditor["setWorkingStatusIndicator"]>[0];

/** A spinner and message for the editor's top border, like Pi's working status. */
class WorkingStatus extends Loader {
	renderInBorder(width: number): string {
		const line = super.render(width + 2)[1] ?? "";
		return truncateToWidth(line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(), width, "");
	}

	renderSpinnerInBorder(width: number): string {
		return truncateToWidth(this.getRenderedIndicator(), width, "");
	}

	dispose(): void {
		this.stop();
	}
}

/** What Pi's footer needs beyond the Session: the Agent's git branch, and no extension statuses. */
function footerData(cwd: string, ctx: ExtensionContext): ReadonlyFooterDataProvider {
	let branch: string | null;
	try {
		branch = execFileSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
	} catch {
		branch = null;
	}
	const providers = new Set(ctx.modelRegistry.getAvailable().map((model) => model.provider)).size;
	return {
		getGitBranch: () => branch,
		getExtensionStatuses: () => new Map(),
		getAvailableProviderCount: () => providers,
		onBranchChange: () => () => {},
	};
}

/** The user's view of one owned Agent: its conversation, and an editor whose text goes to it. */
class AgentViewer implements Component, Focusable {
	private readonly editor: CustomEditor;
	private readonly transcript = new Container();
	private readonly footer: FooterComponent;
	private session?: AgentSession;
	private streaming?: Message;
	/** The streaming message's component and tool calls from the last rebuild, which its updates change in place. */
	private live?: { component: AssistantMessageComponent; calls: string };
	/** Tool components without a result from the last rebuild. */
	private tools = new Map<string, ToolExecutionComponent>();
	private running = new Map<string, { name: string; partial?: ToolResult }>();
	private expanded = false;
	/** Lines scrolled up from the end. */
	private scroll = 0;
	private dirty = true;
	private status = "";
	private indicator?: WorkingStatus;
	/** Inputs sent from the viewer that the Agent has not received yet, as Pi shows queued messages. */
	private outbox: Array<{ text: string; delivery: "followUp" | "steer"; after: number }> = [];
	private disposers: Array<() => void> = [];
	private _focused = false;

	constructor(
		private tui: TUI,
		private theme: Theme,
		keys: KeybindingsManager,
		private ctx: ExtensionContext,
		private owner: AgentNode,
		private entry: Entry,
		session: AgentSession,
		paddingX: number,
		private done: () => void,
	) {
		this.footer = new FooterComponent(session, footerData(entry.cwd, ctx));
		this.editor = new CustomEditor(tui, { borderColor: (text) => theme.fg("border", text), selectList: getSelectListTheme() }, keys as never, {
			paddingX,
			embedWorkingStatus: true,
		});
		this.editor.onSubmit = (text) => this.send(text, "steer");
		this.editor.onEscape = () => void this.owner.agents.abortAgent(this.entry.id).catch((error: unknown) =>
			this.ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"));
		this.editor.onAction("app.clear", () => {
			if (this.editor.getText()) this.editor.setText("");
			else this.done();
		});
		this.editor.onAction("app.message.followUp", () => this.send(this.editor.getText(), "followUp"));
		this.editor.onAction("app.tools.expand", () => {
			this.expanded = !this.expanded;
			this.dirty = true;
			this.tui.requestRender();
		});
		this.disposers.push(onTreeChange(() => this.refresh()));
		this.attach();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	handleInput(data: string): void {
		const page = Math.max(1, this.tui.terminal.rows - 8);
		if (matchesKey(data, "pageUp")) this.scroll += page;
		else if (matchesKey(data, "pageDown")) this.scroll = Math.max(0, this.scroll - page);
		else this.editor.handleInput(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const conversation = this.owner.agents.conversation(this.entry.id);
		if (this.dirty) this.rebuild(conversation);
		this.syncStatus(conversation);
		const queue = this.outbox.map(({ text, delivery }) =>
			truncateToWidth(this.theme.fg("dim", ` ${delivery === "steer" ? "Steering" : "Follow-up"}: ${text.replace(/\s+/g, " ")}`), width));
		const title = truncateToWidth(this.theme.fg("dim", `Agent ${this.entry.name ?? this.entry.id} · ${keyText("app.clear")} to go back`), width);
		const editor = this.editor.render(width);
		const footer = this.footer.render(width);
		const budget = Math.max(1, this.tui.terminal.rows - queue.length - editor.length - footer.length - 2);
		const lines = this.transcript.render(width);
		this.scroll = Math.min(this.scroll, Math.max(0, lines.length - budget));
		const end = lines.length - this.scroll;
		const shown = lines.slice(Math.max(0, end - budget), end);
		// Fill the screen so the Session behind the viewer does not show through.
		const blank = " ".repeat(width);
		const padding = Array.from({ length: budget - shown.length }, () => blank);
		return [...padding, ...shown, blank, ...queue, title, ...editor, ...footer];
	}

	invalidate(): void {
		this.dirty = true;
		this.editor.invalidate();
	}

	dispose(): void {
		this.indicator?.dispose();
		this.footer.dispose();
		for (const dispose of this.disposers.splice(0)) dispose();
	}

	private send(text: string, delivery: "followUp" | "steer"): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		try {
			const after = this.owner.agents.conversation(this.entry.id)?.messages.length ?? 0;
			this.owner.agents.prompt(this.entry.id, trimmed, delivery);
			this.outbox.push({ text: trimmed, delivery, after });
			this.editor.addToHistory(trimmed);
			this.editor.setText("");
			this.scroll = 0;
			this.dirty = true;
		} catch (error) {
			this.ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}

	/** Follows the Agent's Session once it is loaded. */
	private attach(): void {
		const session = this.owner.agents.conversation(this.entry.id)?.session;
		if (!session || session === this.session) return;
		this.session = session;
		this.disposers.push(session.subscribe((event) => {
			if (event.type === "message_start" || event.type === "message_update") this.streaming = event.message;
			else if (event.type === "message_end") this.streaming = undefined;
			else if (event.type === "tool_execution_start") this.running.set(event.toolCallId, { name: event.toolName });
			else if (event.type === "tool_execution_update") {
				const tool = this.running.get(event.toolCallId);
				if (tool) tool.partial = event.partialResult as ToolResult;
			} else if (event.type === "tool_execution_end") this.running.delete(event.toolCallId);
			if (!this.update(event)) this.dirty = true;
			this.tui.requestRender();
		}));
	}

	/** Applies a streaming update to the shown components, as Pi does; false when the transcript needs a rebuild. */
	private update(event: AgentSessionEvent): boolean {
		if (this.dirty) return false;
		if (event.type === "message_update") {
			if (!this.live || event.message.role !== "assistant") return false;
			const calls = event.message.content.flatMap((part) => part.type === "toolCall" ? [part] : []);
			if (calls.map((call) => call.id).join("\n") !== this.live.calls) return false;
			this.live.component.updateContent(event.message);
			for (const call of calls) this.tools.get(call.id)?.updateArgs(call.arguments);
			return true;
		}
		if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
			const tool = this.tools.get(event.toolCallId);
			if (!tool) return false;
			if (event.type === "tool_execution_start") tool.markExecutionStarted();
			else tool.updateResult(event.partialResult as ToolResult, true);
			return true;
		}
		return false;
	}

	private refresh(): void {
		this.attach();
		this.dirty = true;
		this.tui.requestRender();
	}

	/** The working status in the editor's border, and its color from the Agent's thinking level, as in Pi. */
	private syncStatus(conversation: ReturnType<AgentNode["agents"]["conversation"]>): void {
		this.editor.borderColor = this.theme.getThinkingBorderColor((conversation?.thinkingLevel ?? "off") as never);
		const state = this.owner.agents.counts(this.entry.id)?.state;
		const busy = state === "running" || state === "waiting";
		const tool = [...this.running.values()].at(-1);
		const abort = `${keyText("app.interrupt")} to abort`;
		const text = !busy ? "" : tool ? `Running ${tool.name}... (${abort})` : `Working... (${abort})`;
		if (text === this.status) return;
		this.status = text;
		this.indicator?.dispose();
		this.indicator = text
			? new WorkingStatus(this.tui, (part) => this.editor.borderColor(part), (part) => this.theme.fg("muted", part), text)
			: undefined;
		this.editor.setWorkingStatusIndicator(this.indicator as unknown as StatusIndicator);
	}

	private rebuild(conversation: ReturnType<AgentNode["agents"]["conversation"]>): void {
		this.dirty = false;
		this.transcript.clear();
		this.live = undefined;
		this.tools.clear();
		if (!conversation) return;
		const messages = [...conversation.messages];
		// An input leaves the outbox once it is in the conversation, or when the Agent ends its work without it.
		const state = this.owner.agents.counts(this.entry.id)?.state;
		const working = state !== undefined && state !== "idle";
		this.outbox = this.outbox.filter(({ text, after }) => working && !messages.slice(after).some((message) =>
			message.role === "custom" && message.content === text && (message.details as { user?: boolean } | undefined)?.user));
		if (this.streaming && !messages.includes(this.streaming)) messages.push(this.streaming);
		const markdown = getMarkdownTheme();
		for (const message of messages) {
			if (message.role === "assistant") {
				const component = new AssistantMessageComponent(message, false, markdown);
				if (message === this.streaming) {
					const calls = message.content.flatMap((part) => part.type === "toolCall" ? [part.id] : []);
					this.live = { component, calls: calls.join("\n") };
				}
				this.transcript.addChild(component);
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					const tool = new ToolExecutionComponent(part.name, part.id, part.arguments, { showImages: false },
						conversation.session?.getToolDefinition(part.name), this.tui, conversation.cwd);
					tool.setExpanded(this.expanded);
					this.transcript.addChild(tool);
					if (message.stopReason === "aborted" || message.stopReason === "error") {
						tool.updateResult({ content: [{ type: "text", text: message.errorMessage || "Operation aborted" }], isError: true });
					} else {
						this.tools.set(part.id, tool);
					}
				}
			} else if (message.role === "toolResult") {
				this.tools.get(message.toolCallId)?.updateResult(message);
				this.tools.delete(message.toolCallId);
			} else if (message.role === "user") {
				const text = typeof message.content === "string"
					? message.content
					: message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
				if (!text) continue;
				this.transcript.addChild(new Spacer(1));
				this.transcript.addChild(new UserMessageComponent(text, markdown));
			} else if (message.role === "custom" && message.display) {
				const user = message.customType === MESSAGE_TYPE && (message.details as { user?: boolean } | undefined)?.user;
				this.transcript.addChild(new Spacer(1));
				if (user && typeof message.content === "string") {
					this.transcript.addChild(new UserMessageComponent(message.content, markdown));
				} else {
					const component = new CustomMessageComponent(message, undefined, markdown);
					component.setExpanded(this.expanded);
					this.transcript.addChild(component);
				}
			} else if (message.role === "compactionSummary") {
				this.transcript.addChild(new Spacer(1));
				this.transcript.addChild(new CompactionSummaryMessageComponent(message, markdown));
			}
		}
		for (const [id, tool] of this.tools) {
			const running = this.running.get(id);
			if (!running) continue;
			tool.markExecutionStarted();
			if (running.partial) tool.updateResult(running.partial, true);
		}
	}
}

/** A filterable list in place of the editor, like Pi Durable's conversation switcher. */
class ListSelector extends Container implements Focusable {
	private readonly input = new Input();
	private readonly listContainer = new Container();
	private list: SelectList;
	private _focused = false;

	constructor(
		title: string,
		private items: SelectItem[],
		private theme: Theme,
		private keys: KeybindingsManager,
		private onSelect: (value: string) => void,
		private onCancel: () => void,
	) {
		super();
		this.list = this.build(items);
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new DynamicBorder());
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		const forwarded = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const;
		if (forwarded.some((action) => this.keys.matches(data, action))) {
			this.list.handleInput(data);
			return;
		}
		this.input.handleInput(data);
		const query = this.input.getValue();
		this.list = this.build(query.length === 0 ? this.items : fuzzyFilter(this.items, query, (item) => `${item.label} ${item.value}`));
	}

	private build(items: SelectItem[]): SelectList {
		const list = new SelectList(items, 10, {
			...getSelectListTheme(),
			selectedPrefix: (text) => this.theme.fg("accent", text),
			selectedText: (text) => this.theme.fg("accent", text),
			description: (text) => this.theme.fg("muted", text),
		});
		list.onSelect = (item) => this.onSelect(item.value);
		list.onCancel = this.onCancel;
		this.listContainer.clear();
		this.listContainer.addChild(list);
		return list;
	}
}

/** The Agents in the current Agent's tree, including Programs' Agents, those not idle first and newest first within each group. */
export function ownedEntries(self: AgentNode): Entry[] {
	const entries: Entry[] = [];
	const visit = (node: AgentNode) => {
		for (const agent of node.agents.owned()) {
			entries.push({ ...agent, ownerId: node.id });
			const loaded = nodes.get(agent.id);
			if (loaded) visit(loaded);
		}
		for (const program of programsOf(node)) visit(program);
	};
	visit(self);
	return entries.sort((a, b) => Number(b.state !== "idle") - Number(a.state !== "idle") || (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/** `/agents`: picks an owned Agent and opens it in the viewer. */
/** `paddingX` is Pi's editor padding, so the viewer's editor lines up as Pi's does. */
export async function openAgentViewer(ctx: ExtensionContext, self: AgentNode, paddingX: number): Promise<void> {
	const entries = ownedEntries(self);
	if (entries.length === 0) {
		ctx.ui.notify("No owned Agents.", "info");
		return;
	}
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	// An Agent under another owned Agent or a Program is named with its owners up to the current Agent.
	const owners = (ownerId: string | undefined): string => {
		const owner = ownerId === undefined ? undefined : byId.get(ownerId);
		if (owner) return ` ‹ ${path(owner)}`;
		const program = ownerId === undefined ? undefined : nodes.get(ownerId);
		return program?.program ? ` ‹ ${programLabel(program)}${owners(program.ownerId)}` : "";
	};
	const path = (entry: Entry): string => `${entry.name ?? entry.id}${owners(entry.ownerId)}`;
	const items: SelectItem[] = entries.map((entry) => ({
		value: entry.id,
		label: path(entry),
		description: [entry.state, firstInput(entry.sessionFile) ?? ""].filter(Boolean).join("  "),
	}));
	const id = await ctx.ui.custom<string | undefined>((_tui, theme, keys, done) =>
		new ListSelector("Open Agent:", items, theme, keys, (value) => done(value), () => done(undefined)));
	const entry = id === undefined ? undefined : byId.get(id);
	const owner = entry?.ownerId === undefined ? undefined : nodes.get(entry.ownerId);
	if (!entry || !owner) return;
	let session: AgentSession;
	try {
		session = await owner.agents.open(entry.id);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}
	await ctx.ui.custom<void>(
		(tui, theme, keys, done) => new AgentViewer(tui, theme, keys, ctx, owner, entry, session, paddingX, () => done()),
		{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "bottom-center" } },
	);
}
