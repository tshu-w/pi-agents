import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, TruncatedText } from "@earendil-works/pi-tui";
import { label, nodes, onTreeChange, programLabel, programsOf, type AgentNode } from "../agents/registry.ts";

const WIDGET_KEY = "pi-agents";

const MAX_LINES = 10;

/** Time since `since` as Pi's bash tool shows durations, in whole seconds: `45s`, `1m 32s`, `1h 5m 3s`. */
function elapsed(since: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - since) / 1000));
	const minutes = Math.floor(seconds / 60);
	if (minutes === 0) return `${seconds}s`;
	return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
}

/**
 * The task panel: the Agent's live owned Agents and running background Programs as a tree, in the
 * order they started, with their Programs' live Agents under them, and how long each has run. Empty when none.
 */
export function panelLines(self: AgentNode, now = Date.now()): string[] {
	const rows: Array<{ line: string; parent?: number; shown: boolean }> = [];
	const ids = self.agents.ids();
	let live = 0;
	// A live row is listed with its owners, so the tree stays readable.
	const show = (index: number | undefined) => {
		for (let row = index === undefined ? undefined : rows[index]; row && !row.shown; row = row.parent === undefined ? undefined : rows[row.parent]) row.shown = true;
	};
	const visit = (node: AgentNode, level: number, parent?: number) => {
		const children = [
			...node.agents.owned().map((entry) => ({ at: entry.createdAt ?? "", entry })),
			...programsOf(node).filter((program) => program.background).map((program) => ({ at: program.createdAt ?? "", program })),
		].sort((a, b) => a.at.localeCompare(b.at));
		for (const child of children) {
			const index = rows.length;
			if ("program" in child) {
				const since = Date.parse(child.program.createdAt ?? "");
				rows.push({ line: `${"  ".repeat(level)}${[programLabel(child.program), "running", ...(since ? [elapsed(since, now)] : [])].join("  ")}`, parent, shown: false });
				live += 1;
				show(index);
				visit(child.program, level + 1, index);
				continue;
			}
			const { entry } = child;
			const own = node.agents.counts(entry.id);
			const pending = own?.pending ? [`${own.pending} pending`] : [];
			const time = own?.since ? [elapsed(own.since, now)] : [];
			rows.push({ line: `${"  ".repeat(level)}Agent ${[label(entry, ids), entry.state, ...time, ...pending].join("  ")}`, parent, shown: false });
			if (entry.state !== "idle") {
				live += 1;
				show(index);
			}
			const loaded = nodes.get(entry.id);
			if (loaded) visit(loaded, level + 1, index);
		}
	};
	visit(self, 0);
	const lines = rows.filter((row) => row.shown).map((row) => row.line);
	if (lines.length === 0) return [];
	if (lines.length > MAX_LINES - 1) lines.splice(MAX_LINES - 2, Infinity, `+${lines.length - (MAX_LINES - 2)} more`);
	return [`Tasks (${live} live, /tasks to hide)`, ...lines.map((line) => `  ${line}`)];
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
