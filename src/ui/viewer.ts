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
	keyText,
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
	isViewportTUI,
	Loader,
	ScrollView,
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
	type TuiMouseEvent,
	type TuiMouseEventResult,
	type ViewportTUI,
	VStack,
} from "@earendil-works/pi-tui";
import { MESSAGE_TYPE, nodes, onTreeChange, programLabel, tasksOf, type AgentNode, type Entry, type Task } from "../agents/registry.ts";
import { latestActivity } from "../agents/search.ts";
import { PROGRAM_TOOL_NAME } from "../programs/execute.ts";
import type { Programs } from "../programs/programs.ts";
import { agentSession } from "../roots/rpc.ts";
import { execFileSync } from "node:child_process";

type Message = AgentSession["messages"][number];
type ToolResult = Parameters<ToolExecutionComponent["updateResult"]>[0];
type StatusIndicator = Parameters<CustomEditor["setWorkingStatusIndicator"]>[0];
type Conversation = NonNullable<ReturnType<AgentNode["agents"]["conversation"]>>;
type ToolCall = Extract<Extract<Message, { role: "assistant" }>["content"][number], { type: "toolCall" }>;
type Display = ReturnType<AgentViewer["display"]>;

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

/** The lines a scroll key of Pi's fullscreen mode moves the view up, negative for down, or undefined for another key. */
function scrollKey(keys: KeybindingsManager, data: string, page: number): number | undefined {
	const moves = [
		["tui.altScreen.pageUp", page], ["tui.altScreen.pageDown", -page],
		["tui.altScreen.halfPageUp", Math.ceil(page / 2)], ["tui.altScreen.halfPageDown", -Math.ceil(page / 2)],
		["tui.altScreen.lineUp", 1], ["tui.altScreen.lineDown", -1],
		["tui.altScreen.top", Infinity], ["tui.altScreen.bottom", -Infinity],
	] as const;
	return moves.find(([action]) => keys.matches(data, action))?.[1];
}

/**
 * Shows a viewer in place of Pi's chat in fullscreen mode, and returns a function that restores it. The viewer takes
 * Pi's layout, so its transcript above `dock` is browsed as Pi's transcript.
 */
function mountViewer(tui: ViewportTUI, theme: Theme, ctx: ExtensionContext, transcript: Component, dock: Component[]): () => void {
	const previous = (tui as unknown as { layoutRoot?: Component }).layoutRoot;
	const view = new ScrollView(transcript, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: agentSession(ctx.sessionManager)?.settingsManager.getFullscreenScrollbar() ?? "auto",
		scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text),
		scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text),
	});
	// As Pi's fullscreen layout: the transcript takes the room the dock leaves.
	tui.setLayoutRoot(new VStack([
		{ component: view, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: new VStack(dock.map((component) => ({ component, shrink: 1, minSize: 0 }))), basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]));
	return () => tui.setLayoutRoot(previous);
}

/** The user's view of one owned Agent: its conversation, and an editor whose text goes to it. */
class AgentViewer implements Component, Focusable {
	private readonly editor: CustomEditor;
	private readonly transcript = new Container();
	private readonly footer: FooterComponent;
	private session?: AgentSession;
	private streaming?: Message;
	/** The component of the streaming assistant message and its tool calls, which its updates change in place. */
	private live?: { component: AssistantMessageComponent; calls: Set<string> };
	/** Tool components without a result. */
	private tools = new Map<string, ToolExecutionComponent>();
	private running = new Map<string, { partial?: ToolResult }>();
	/** The conversation's messages the transcript shows, by their count and the last one. */
	private shown = 0;
	private last?: Message;
	/** Streaming messages that ended in the transcript before reaching the conversation's messages. */
	private ended = 0;
	private expanded = false;
	/** Lines scrolled up from the end, in regular mode. */
	private scroll = 0;
	private fullscreen: boolean;
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
			// As Pi does, in place.
			for (const child of this.transcript.children) (child as { setExpanded?: (expanded: boolean) => void }).setExpanded?.(this.expanded);
			this.tui.requestRender();
		});
		this.disposers.push(onTreeChange(() => this.refresh()));
		this.attach();
		this.fullscreen = isViewportTUI(tui);
		if (isViewportTUI(tui)) {
			const part = (render: (width: number) => string[]): Component => ({ render, invalidate: () => this.invalidate() });
			this.disposers.push(mountViewer(tui, theme, ctx, part((width) => this.renderTranscript(width)), [
				part((width) => [" ".repeat(width), ...this.renderQueue(width)]),
				this.editor,
				part((width) => this.renderFooter(width)),
			]));
		}
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	handleInput(data: string): void {
		const lines = this.fullscreen ? undefined : scrollKey(this.keys, data, Math.max(1, this.tui.terminal.rows - 8));
		if (lines !== undefined) this.scroll = Math.max(0, this.scroll + lines);
		else this.editor.handleInput(data);
		this.tui.requestRender();
	}

	/** In fullscreen mode, the viewer draws itself in place of Pi's chat (`mountViewer`); in regular mode, over the screen. */
	render(width: number): string[] {
		if (this.fullscreen) return [];
		const queue = this.renderQueue(width);
		const editor = this.editor.render(width);
		const footer = this.renderFooter(width);
		const budget = Math.max(1, this.tui.terminal.rows - queue.length - editor.length - footer.length - 1);
		const lines = this.renderTranscript(width);
		this.scroll = Math.min(this.scroll, Math.max(0, lines.length - budget));
		const end = lines.length - this.scroll;
		const shown = lines.slice(Math.max(0, end - budget), end);
		// Fill the screen so the Session behind the viewer does not show through.
		const blank = " ".repeat(width);
		const padding = Array.from({ length: budget - shown.length }, () => blank);
		return [...padding, ...shown, blank, ...queue, ...editor, ...footer];
	}

	private renderTranscript(width: number): string[] {
		this.prepare();
		return this.transcript.render(width);
	}

	/** Brings the transcript, the outbox and the working status up to the conversation, before any of them renders. */
	private prepare(): void {
		const conversation = this.owner.agents.conversation(this.entry.id);
		this.sync(conversation);
		this.syncStatus(conversation);
	}

	private renderQueue(width: number): string[] {
		this.prepare();
		return this.outbox.map(({ text, delivery }) =>
			truncateToWidth(this.theme.fg("dim", ` ${delivery === "steer" ? "Steering" : "Follow-up"}: ${text.replace(/\s+/g, " ")}`), width));
	}

	/** Pi's footer for the Agent, with the way back at the right of its first line when it fits, marked so it stands out. */
	private renderFooter(width: number): string[] {
		const [cwd = "", ...footer] = this.footer.render(width);
		const back = this.theme.fg("accent", `${keyText("app.clear")} back`);
		const gap = width - visibleWidth(cwd) - visibleWidth(back);
		return [gap >= 2 ? cwd + " ".repeat(gap) + back : cwd, ...footer];
	}

	invalidate(): void {
		this.transcript.invalidate();
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
			this.tui.requestRender();
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
			this.update(event);
			this.tui.requestRender();
		}));
	}

	/** Applies a streaming update to the shown components in place, as Pi does; the next render adds new messages. */
	private update(event: AgentSessionEvent): void {
		if (event.type === "message_update" && this.live && event.message.role === "assistant") {
			this.live.component.updateContent(event.message, true);
			const conversation = this.owner.agents.conversation(this.entry.id);
			for (const part of event.message.content) {
				if (part.type !== "toolCall") continue;
				if (this.live.calls.has(part.id)) this.tools.get(part.id)?.updateArgs(part.arguments);
				else if (conversation) this.addTool(part, conversation, this.display(conversation), this.live.calls);
			}
		} else if (event.type === "message_end" && this.live && event.message.role === "assistant") {
			// As Pi does, the streaming message's component ends with it, before the next message streams.
			const conversation = this.owner.agents.conversation(this.entry.id);
			if (conversation) this.end(event.message, conversation, this.display(conversation));
			this.ended++;
		} else if (event.type === "tool_execution_start") this.tools.get(event.toolCallId)?.markExecutionStarted();
		else if (event.type === "tool_execution_update") this.tools.get(event.toolCallId)?.updateResult(event.partialResult as ToolResult, true);
	}

	private refresh(): void {
		this.attach();
		this.tui.requestRender();
	}

	/**
	 * The working status in the editor's border, and its color from the Agent's thinking level, as in Pi: `Working`,
	 * spinner and text in the border's color.
	 */
	private syncStatus(conversation: Conversation | undefined): void {
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

	/** The transcript's display settings: as Pi's chat shows messages, with the settings of the Session the viewer is in. */
	private display(conversation: Conversation) {
		const current = agentSession(this.ctx.sessionManager);
		const settings = current?.settingsManager;
		const pad = settings?.getOutputPad() ?? 1;
		return {
			settings,
			markdown: settings ? { ...getMarkdownTheme(), codeBlockIndent: settings.getCodeBlockIndent() } : getMarkdownTheme(),
			transformers: current?.extensionRunner.getMarkdownTransformers(),
			pad,
			runner: (conversation.session ?? current)?.extensionRunner,
			images: { showImages: settings?.getShowImages() ?? false, imageWidthCells: settings?.getImageWidthCells(), outputPad: pad },
		};
	}

	/** Adds the conversation's new messages to the transcript, and starts over when its earlier messages changed. */
	private sync(conversation: Conversation | undefined): void {
		const messages = conversation?.messages ?? [];
		if (messages.length < this.shown || (this.shown > 0 && messages[this.shown - 1] !== this.last)) {
			this.transcript.clear();
			this.live = undefined;
			for (const tool of this.tools.values()) stopTimer(tool);
			this.tools.clear();
			this.shown = 0;
			this.ended = 0;
		}
		// An input leaves the outbox once it is in the conversation, or when the Agent ends its work without it.
		const state = this.owner.agents.counts(this.entry.id)?.state;
		const working = state !== undefined && state !== "idle";
		this.outbox = this.outbox.filter(({ text, after }) => working && !messages.slice(after).some((message) =>
			message.role === "custom" && message.content === text && (message.details as { user?: boolean } | undefined)?.user));
		if (!conversation) return;
		const streaming = this.streaming?.role === "assistant" && !this.live && !messages.includes(this.streaming) ? this.streaming : undefined;
		if (messages.length === this.shown && !streaming) return;
		const display = this.display(conversation);
		for (const message of messages.slice(this.shown)) {
			if (message.role !== "assistant") this.add(message, conversation, display);
			// An ended streaming message is shown already.
			else if (this.ended > 0) this.ended--;
			else if (this.live) this.end(message, conversation, display);
			else this.add(message, conversation, display);
		}
		this.shown = messages.length;
		this.last = messages.at(-1);
		if (streaming?.role === "assistant") {
			const component = new AssistantMessageComponent(streaming, display.settings?.getHideThinkingBlock() ?? false, display.markdown, undefined, display.pad, display.transformers);
			// As Pi does, so Markdown transformers know the message is still streaming.
			component.updateContent(streaming, true);
			this.transcript.addChild(component);
			this.live = { component, calls: new Set() };
			for (const part of streaming.content) if (part.type === "toolCall") this.addTool(part, conversation, display, this.live.calls);
		}
	}

	/** Shows the streaming message whole as it ended. */
	private end(message: Message, conversation: Conversation, display: Display): void {
		if (!this.live || message.role !== "assistant") return;
		this.live.component.updateContent(message);
		for (const part of message.content) if (part.type === "toolCall" && !this.live.calls.has(part.id)) this.addTool(part, conversation, display);
		this.live = undefined;
		this.settle(message);
	}

	private addTool(call: ToolCall, conversation: Conversation, display: Display, calls?: Set<string>): void {
		const tool = new ToolExecutionComponent(call.name, call.id, call.arguments, display.images,
			conversation.session?.getToolDefinition(call.name), this.tui, conversation.cwd);
		tool.setExpanded(this.expanded);
		this.transcript.addChild(tool);
		this.tools.set(call.id, tool);
		calls?.add(call.id);
		const running = this.running.get(call.id);
		if (running) {
			tool.markExecutionStarted();
			if (running.partial) tool.updateResult(running.partial, true);
		}
	}

	/** Ends the tool calls of an assistant message that stopped without running them. */
	private settle(message: Message): void {
		if (message.role !== "assistant" || (message.stopReason !== "aborted" && message.stopReason !== "error")) return;
		const text = message.stopReason === "aborted" ? "Operation aborted" : message.errorMessage || "Error";
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			this.tools.get(part.id)?.updateResult({ content: [{ type: "text", text }], isError: true });
			this.tools.delete(part.id);
		}
	}

	private add(message: Message, conversation: Conversation, display: Display): void {
		const { markdown, transformers, pad, runner } = display;
		if (message.role === "assistant") {
			this.transcript.addChild(new AssistantMessageComponent(message, display.settings?.getHideThinkingBlock() ?? false, markdown, undefined, pad, transformers));
			for (const part of message.content) if (part.type === "toolCall") this.addTool(part, conversation, display);
			this.settle(message);
		} else if (message.role === "toolResult") {
			this.tools.get(message.toolCallId)?.updateResult(message);
			this.tools.delete(message.toolCallId);
		} else if (message.role === "user") {
			const text = typeof message.content === "string"
				? message.content
				: message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
			if (!text) return;
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
		const lines = scrollKey(this.keys, data, Math.max(1, this.tui.terminal.rows - 4));
		if (this.keys.matches(data, "app.clear" as never)) return this.done();
		if (this.keys.matches(data, "app.interrupt" as never)) this.stop();
		else if (this.keys.matches(data, "app.tools.expand" as never)) {
			this.expanded = !this.expanded;
			this.tool.setExpanded(this.expanded);
		} else if (lines !== undefined) this.scroll = Math.max(0, this.scroll + lines);
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || !event.wheelDelta) return undefined;
		this.scroll = Math.max(0, this.scroll - event.wheelDelta);
		return { handled: true };
	}

	render(width: number): string[] {
		const running = this.programs.view(this.id)?.record.state === "running";
		const hints = [...running ? [keyHint("app.interrupt", "stop")] : [], this.theme.fg("accent", `${keyText("app.clear")} back`)].join("  ");
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
	const visit = (tasks: Task[]) => {
		for (const task of tasks) {
			if ("entry" in task) entries.push(task.entry);
			visit(task.tasks);
		}
	};
	visit(tasksOf(self));
	return entries.sort((a, b) => Number(b.state !== "idle") - Number(a.state !== "idle") || (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

const PROGRAM_ITEM = "program:";

/**
 * `/tasks`: picks an Agent in the tree, a background Program of the current Agent, or a running one of another Agent, live ones first and newest first, and opens
 * it in the viewer. `paddingX` is Pi's editor padding, so the viewer's editor lines up as Pi's does.
 */
export async function openTaskViewer(ctx: ExtensionContext, self: AgentNode, paddingX: number): Promise<void> {
	const entries = ownedEntries(self);
	const records = [self, ...entries.flatMap((entry) => nodes.get(entry.id) ?? [])]
		.flatMap((caller) => caller.programs?.list().map((record) => ({ caller, programs: caller.programs!, record })) ?? [])
		// Another Agent's ended Programs show in its conversation; its Session may not be loaded to list them.
		.filter(({ caller, record }) => caller === self || record.state === "running");
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
		...records.map(({ caller, programs, record }) => ({ live: record.state === "running", at: new Date(record.startedAt).toISOString(), item: {
			value: PROGRAM_ITEM + record.id,
			label: `Program ${programs.label(record)}${caller === self ? "" : ` ‹ ${path(byId.get(caller.id)!)}`}`,
			description: record.state,
		} })),
	];
	const items: SelectItem[] = tasks
		.sort((a, b) => Number(b.live) - Number(a.live) || b.at.localeCompare(a.at))
		.map((task) => task.item);
	// In regular mode, a viewer shows over the screen; in fullscreen mode, it takes Pi's layout (`mountViewer`).
	let overlay = true;
	const id = await ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
		overlay = !isViewportTUI(tui);
		return new ListSelector("Open task:", items, theme, keys, (value) => done(value), () => done(undefined));
	});
	const program = id?.startsWith(PROGRAM_ITEM) ? records.find(({ record }) => record.id === id.slice(PROGRAM_ITEM.length)) : undefined;
	if (program) {
		await ctx.ui.custom<void>(
			(tui, theme, keys, done) => new ProgramViewer(tui, theme, keys, ctx, program.programs, program.record.id, () => done()),
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
		overlay ? { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "bottom-center" } } : undefined,
	);
}
