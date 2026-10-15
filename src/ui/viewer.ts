import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomEditor,
	CustomMessageComponent,
	DynamicBorder,
	FooterComponent,
	getMarkdownTheme,
	getSelectListTheme,
	keyHint,
	parseSkillBlock,
	SkillInvocationMessageComponent,
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
	SelectList,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type KeybindingsManager,
	type SelectItem,
	type TUI,
} from "@earendil-works/pi-tui";
import { MESSAGE_TYPE, nodes, onTreeChange, programLabel, programsOf, type AgentNode, type Entry } from "../agents/registry.ts";
import { latestActivity } from "../agents/search.ts";
import { PROGRAM_TOOL_NAME } from "../programs/execute.ts";
import type { Programs } from "../programs/programs.ts";
import { agentSession } from "../roots/rpc.ts";
import { execFileSync } from "node:child_process";

type Message = AgentSession["messages"][number];
type ToolResult = Parameters<ToolExecutionComponent["updateResult"]>[0];
type StatusIndicator = Parameters<CustomEditor["setWorkingStatusIndicator"]>[0];

/** Stops the elapsed-time timer of a tool component the viewer drops; only a final result stops it otherwise. */
function stopTimer(tool: ToolExecutionComponent): void {
	const state = (tool as unknown as { rendererState: { interval?: ReturnType<typeof setInterval> } }).rendererState;
	clearInterval(state.interval);
	state.interval = undefined;
}

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
	private running = new Map<string, { partial?: ToolResult }>();
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
		private keys: KeybindingsManager,
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
		// The page keys of Pi's fullscreen mode.
		if (this.keys.matches(data, "tui.altScreen.pageUp")) this.scroll += page;
		else if (this.keys.matches(data, "tui.altScreen.pageDown")) this.scroll = Math.max(0, this.scroll - page);
		else this.editor.handleInput(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const conversation = this.owner.agents.conversation(this.entry.id);
		if (this.dirty) this.rebuild(conversation);
		this.syncStatus(conversation);
		const queue = this.outbox.map(({ text, delivery }) =>
			truncateToWidth(this.theme.fg("dim", ` ${delivery === "steer" ? "Steering" : "Follow-up"}: ${text.replace(/\s+/g, " ")}`), width));
		const editor = this.editor.render(width);
		const [cwd = "", ...footer] = this.footer.render(width);
		// The way back sits at the right of the footer's first line, when it fits.
		const back = keyHint("app.clear", "back");
		const gap = width - visibleWidth(cwd) - visibleWidth(back);
		footer.unshift(gap >= 2 ? cwd + " ".repeat(gap) + back : cwd);
		const budget = Math.max(1, this.tui.terminal.rows - queue.length - editor.length - footer.length - 1);
		const lines = this.transcript.render(width);
		this.scroll = Math.min(this.scroll, Math.max(0, lines.length - budget));
		const end = lines.length - this.scroll;
		const shown = lines.slice(Math.max(0, end - budget), end);
		// Fill the screen so the Session behind the viewer does not show through.
		const blank = " ".repeat(width);
		const padding = Array.from({ length: budget - shown.length }, () => blank);
		return [...padding, ...shown, blank, ...queue, ...editor, ...footer];
	}

	invalidate(): void {
		this.dirty = true;
		this.editor.invalidate();
	}

	dispose(): void {
		this.indicator?.dispose();
		this.footer.dispose();
		for (const tool of this.tools.values()) stopTimer(tool);
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
			else if (event.type === "tool_execution_start") this.running.set(event.toolCallId, {});
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
			this.live.component.updateContent(event.message, true);
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

	/**
	 * The working status in the editor's border, and its color from the Agent's thinking level, as in Pi: `Working`,
	 * spinner and text in the border's color.
	 */
	private syncStatus(conversation: ReturnType<AgentNode["agents"]["conversation"]>): void {
		this.editor.borderColor = this.theme.getThinkingBorderColor((conversation?.thinkingLevel ?? "off") as never);
		const state = this.owner.agents.counts(this.entry.id)?.state;
		const text = state === "running" || state === "waiting" ? "Working" : "";
		if (text === this.status) return;
		this.status = text;
		this.indicator?.dispose();
		const color = (part: string) => this.editor.borderColor(part);
		this.indicator = text ? new WorkingStatus(this.tui, color, color, text) : undefined;
		this.editor.setWorkingStatusIndicator(this.indicator as unknown as StatusIndicator);
	}

	private rebuild(conversation: ReturnType<AgentNode["agents"]["conversation"]>): void {
		this.dirty = false;
		this.transcript.clear();
		this.live = undefined;
		for (const tool of this.tools.values()) stopTimer(tool);
		this.tools.clear();
		if (!conversation) return;
		const messages = [...conversation.messages];
		// An input leaves the outbox once it is in the conversation, or when the Agent ends its work without it.
		const state = this.owner.agents.counts(this.entry.id)?.state;
		const working = state !== undefined && state !== "idle";
		this.outbox = this.outbox.filter(({ text, after }) => working && !messages.slice(after).some((message) =>
			message.role === "custom" && message.content === text && (message.details as { user?: boolean } | undefined)?.user));
		if (this.streaming && !messages.includes(this.streaming)) messages.push(this.streaming);
		// As Pi's chat shows them, with the display settings of the Session the viewer is in.
		const current = agentSession(this.ctx.sessionManager);
		const settings = current?.settingsManager;
		const markdown = settings ? { ...getMarkdownTheme(), codeBlockIndent: settings.getCodeBlockIndent() } : getMarkdownTheme();
		const transformers = current?.extensionRunner.getMarkdownTransformers();
		const pad = settings?.getOutputPad() ?? 1;
		const runner = (conversation.session ?? current)?.extensionRunner;
		const images = { showImages: settings?.getShowImages() ?? false, imageWidthCells: settings?.getImageWidthCells(), outputPad: pad };
		for (const message of messages) {
			if (message.role === "assistant") {
				const component = new AssistantMessageComponent(message, settings?.getHideThinkingBlock() ?? false, markdown, undefined, pad, transformers);
				if (message === this.streaming) {
					// As Pi does, so Markdown transformers know the message is still streaming.
					component.updateContent(message, true);
					const calls = message.content.flatMap((part) => part.type === "toolCall" ? [part.id] : []);
					this.live = { component, calls: calls.join("\n") };
				}
				this.transcript.addChild(component);
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					const tool = new ToolExecutionComponent(part.name, part.id, part.arguments, images,
						conversation.session?.getToolDefinition(part.name), this.tui, conversation.cwd);
					tool.setExpanded(this.expanded);
					this.transcript.addChild(tool);
					if (message.stopReason === "aborted" || message.stopReason === "error") {
						const text = message.stopReason === "aborted" ? "Operation aborted" : message.errorMessage || "Error";
						tool.updateResult({ content: [{ type: "text", text }], isError: true });
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
					: message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
				if (!text) continue;
				this.transcript.addChild(new Spacer(1));
				const skill = parseSkillBlock(text);
				if (skill) {
					const component = new SkillInvocationMessageComponent(skill, markdown, pad);
					component.setExpanded(this.expanded);
					this.transcript.addChild(component);
					if (skill.userMessage) {
						this.transcript.addChild(new Spacer(1));
						this.transcript.addChild(new UserMessageComponent(skill.userMessage, markdown, pad, transformers));
					}
				} else {
					this.transcript.addChild(new UserMessageComponent(text, markdown, pad, transformers));
				}
			} else if (message.role === "custom" && message.display) {
				const user = message.customType === MESSAGE_TYPE && (message.details as { user?: boolean } | undefined)?.user;
				if (user && typeof message.content === "string") {
					this.transcript.addChild(new Spacer(1));
					this.transcript.addChild(new UserMessageComponent(message.content, markdown, pad, transformers));
				} else {
					// The component starts with its own blank line.
					const component = new CustomMessageComponent(message, runner?.getMessageRenderer(message.customType), markdown, pad);
					component.setExpanded(this.expanded);
					this.transcript.addChild(component);
				}
			} else if (message.role === "bashExecution") {
				const component = new BashExecutionComponent(message.command, this.tui, message.excludeFromContext, pad);
				if (message.output) component.appendOutput(message.output);
				component.setComplete(message.exitCode, message.cancelled, message.truncated ? { truncated: true } as never : undefined, message.fullOutputPath);
				component.setExpanded(this.expanded);
				this.transcript.addChild(component);
			} else if (message.role === "compactionSummary" || message.role === "branchSummary") {
				this.transcript.addChild(new Spacer(1));
				const component = message.role === "compactionSummary"
					? new CompactionSummaryMessageComponent(message, markdown, pad)
					: new BranchSummaryMessageComponent(message, markdown, pad);
				component.setExpanded(this.expanded);
				this.transcript.addChild(component);
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

/** The user's view of one background Program, as its tool call shows in the foreground. */
class ProgramViewer implements Component, Focusable {
	private readonly tool: ToolExecutionComponent;
	private expanded = false;
	/** Lines scrolled up from the end. */
	private scroll = 0;
	private disposers: Array<() => void> = [];
	focused = false;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private keys: KeybindingsManager,
		private ctx: ExtensionContext,
		private programs: Programs,
		private id: string,
		private done: () => void,
	) {
		const code = programs.view(id)?.code;
		const settings = agentSession(ctx.sessionManager)?.settingsManager;
		this.tool = new ToolExecutionComponent(PROGRAM_TOOL_NAME, `program-${id}`, { action: "run", background: true, ...(code !== undefined && { code }) }, {
			showImages: settings?.getShowImages() ?? false, imageWidthCells: settings?.getImageWidthCells(), outputPad: settings?.getOutputPad(),
		}, agentSession(ctx.sessionManager)?.getToolDefinition(PROGRAM_TOOL_NAME), tui, ctx.cwd);
		this.tool.markExecutionStarted();
		this.sync();
		this.disposers.push(programs.onView(() => {
			this.sync();
			this.tui.requestRender();
		}));
	}

	handleInput(data: string): void {
		const page = Math.max(1, this.tui.terminal.rows - 4);
		if (this.keys.matches(data, "app.clear" as never)) return this.done();
		if (this.keys.matches(data, "app.interrupt" as never)) this.stop();
		else if (this.keys.matches(data, "app.tools.expand" as never)) {
			this.expanded = !this.expanded;
			this.tool.setExpanded(this.expanded);
		} else if (this.keys.matches(data, "tui.altScreen.pageUp")) this.scroll += page;
		else if (this.keys.matches(data, "tui.altScreen.pageDown")) this.scroll = Math.max(0, this.scroll - page);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const running = this.programs.view(this.id)?.record.state === "running";
		const hints = [...running ? [keyHint("app.interrupt", "stop")] : [], keyHint("app.clear", "back")].join("  ");
		const footer = truncateToWidth(" ".repeat(Math.max(0, width - visibleWidth(hints))) + hints, width);
		const border = new DynamicBorder().render(width);
		const budget = Math.max(1, this.tui.terminal.rows - border.length - 2);
		const lines = this.tool.render(width);
		this.scroll = Math.min(this.scroll, Math.max(0, lines.length - budget));
		const end = lines.length - this.scroll;
		// As tall as its content, so the Session shows above it.
		return [...border, ...lines.slice(Math.max(0, end - budget), end), " ".repeat(width), footer];
	}

	invalidate(): void {
		this.tool.invalidate();
	}

	dispose(): void {
		stopTimer(this.tool);
		for (const dispose of this.disposers.splice(0)) dispose();
	}

	private sync(): void {
		const view = this.programs.view(this.id);
		if (view?.result) this.tool.updateResult(view.result as ToolResult, view.record.state === "running");
	}

	private stop(): void {
		this.programs.stop(this.programs.target(this.id)).catch((error: unknown) =>
			this.ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"));
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

const PROGRAM_ITEM = "program:";

/**
 * `/tasks`: picks an Agent in the tree or a background Program, live ones first and newest first, and opens it in
 * the viewer. `paddingX` is Pi's editor padding, so the viewer's editor lines up as Pi's does.
 */
export async function openTaskViewer(ctx: ExtensionContext, self: AgentNode, programs: Programs | undefined, paddingX: number): Promise<void> {
	const entries = ownedEntries(self);
	const records = programs?.list() ?? [];
	if (entries.length === 0 && records.length === 0) {
		ctx.ui.notify("No tasks.", "info");
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
	const tasks = [
		...entries.map((entry) => ({ live: entry.state !== "idle", at: entry.createdAt ?? "", item: {
			value: entry.id,
			label: path(entry),
			description: [entry.state, latestActivity(entry.sessionFile) ?? ""].filter(Boolean).join("  "),
		} })),
		...records.map((record) => ({ live: record.state === "running", at: new Date(record.startedAt).toISOString(), item: {
			value: PROGRAM_ITEM + record.id,
			label: `Program ${programs!.label(record)}`,
			description: record.state,
		} })),
	];
	const items: SelectItem[] = tasks
		.sort((a, b) => Number(b.live) - Number(a.live) || b.at.localeCompare(a.at))
		.map((task) => task.item);
	const id = await ctx.ui.custom<string | undefined>((_tui, theme, keys, done) =>
		new ListSelector("Open task:", items, theme, keys, (value) => done(value), () => done(undefined)));
	if (id?.startsWith(PROGRAM_ITEM) && programs) {
		await ctx.ui.custom<void>(
			(tui, theme, keys, done) => new ProgramViewer(tui, theme, keys, ctx, programs, id.slice(PROGRAM_ITEM.length), () => done()),
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "bottom-center" } },
		);
		return;
	}
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
