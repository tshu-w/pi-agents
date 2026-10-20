import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, TruncatedText } from "@earendil-works/pi-tui";
import { label, liveWork, onTreeChange, programLabel, taskLive, tasksOf, type AgentNode, type Spend, type Task } from "../agents/registry.ts";

const WIDGET_KEY = "pi-agents";

const MAX_LINES = 10;

/** Time since `since` as Pi's bash tool shows durations, in whole seconds: `45s`, `1m 32s`, `1h 5m 3s`. */
function elapsed(since: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - since) / 1000));
	const minutes = Math.floor(seconds / 60);
	if (minutes === 0) return `${seconds}s`;
	return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
}

/** `$2.10`, or the input and output tokens as Pi's footer shows them, `7.3M tok`, when a reply had no price. */
function cost({ cost, tokens, unpriced }: Spend): string {
	if (!unpriced) return `$${cost.toFixed(2)}`;
	if (tokens < 1000) return `${tokens} tok`;
	if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k tok`;
	if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k tok`;
	return tokens < 10_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M tok` : `${Math.round(tokens / 1_000_000)}M tok`;
}

/** The cost of `spent`, once there is any. */
function spend(spent: Spend | undefined): string[] {
	return spent && (spent.cost > 0 || spent.tokens > 0) ? [cost(spent)] : [];
}

/**
 * The task panel: the Agent's live work as a tree, in the order it started, with how long each has run
 * and what it has cost. Empty when none.
 */
export function panelLines(self: AgentNode, now = Date.now()): string[] {
	const ids = self.agents.ids();
	const line = (task: Task): string => {
		if ("program" in task) {
			const since = Date.parse(task.program.createdAt ?? "");
			const time = since ? [elapsed(since, now), ...spend(task.program.spent)] : [];
			return [programLabel(task.program), "running", ...time].join("  ");
		}
		const { entry, owner } = task;
		const own = owner.agents.counts(entry.id);
		const pending = own?.pending ? [`${own.pending} pending`] : [];
		const time = own?.since ? [elapsed(own.since, now), ...spend(own.spent)] : [];
		return `Agent ${[label(entry, ids), entry.state, ...time, ...pending].join("  ")}`;
	};
	// A row is listed while it is live or has live work under it, so the tree stays readable.
	const rows = (tasks: Task[], level: number): string[] => tasks.flatMap((task) => {
		const under = rows(task.tasks, level + 1);
		return taskLive(task) || under.length > 0 ? [`${"  ".repeat(level)}${line(task)}`, ...under] : [];
	});
	const lines = rows(tasksOf(self), 0);
	if (lines.length === 0) return [];
	if (lines.length > MAX_LINES - 1) lines.splice(MAX_LINES - 2, Infinity, `+${lines.length - (MAX_LINES - 2)} more`);
	return [`Tasks (${liveWork(self)} live, /tasks to view)`, ...lines.map((line) => `  ${line}`)];
}

/**
 * Keeps the task panel above the editor current while the Session is loaded, and its times each second
 * while it shows; `toggle` hides or shows it.
 */
export function createPanel(getNode: () => AgentNode | undefined) {
	let ctx: ExtensionContext | undefined;
	let hidden = false;
	let scheduled = false;
	let unsubscribe: (() => void) | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;

	const render = () => {
		scheduled = false;
		const node = getNode();
		if (!ctx?.hasUI || !node) return;
		const lines = hidden ? [] : panelLines(node);
		if (lines.length > 0) ticker ??= setInterval(render, 1000);
		else {
			clearInterval(ticker);
			ticker = undefined;
		}
		ctx.ui.setWidget(WIDGET_KEY, lines.length === 0 ? undefined : (_tui, theme) => {
			const panel = new Container();
			lines.forEach((line, index) => panel.addChild(new TruncatedText(theme.fg(index === 0 ? "accent" : "muted", line), 0, 0)));
			return panel;
		});
	};
	const update = () => {
		if (scheduled) return;
		scheduled = true;
		setImmediate(render);
	};

	return {
		start(current: ExtensionContext) {
			ctx = current;
			unsubscribe ??= onTreeChange(update);
			update();
		},
		update,
		toggle() {
			hidden = !hidden;
			render();
		},
		stop() {
			clearInterval(ticker);
			ticker = undefined;
			unsubscribe?.();
			unsubscribe = undefined;
			if (ctx?.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
			ctx = undefined;
		},
	};
}
