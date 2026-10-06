import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, TruncatedText } from "@earendil-works/pi-tui";
import { label, nodes, onTreeChange, treeEntries, type AgentNode } from "../agents/registry.ts";
import type { Programs } from "../programs/programs.ts";

const WIDGET_KEY = "pi-agents";

const MAX_LINES = 10;

/** The task panel: the Agent's live owned Agents as a tree, then its running background Programs. Empty when none. */
function panelLines(self: AgentNode, programs: Programs | undefined): string[] {
	const depth = new Map<string, number>([[self.id, 0]]);
	const parent = new Map<string, string>();
	const rows = new Map<string, string>();
	const shown = new Set<string>();
	const ids = self.agents.ids();
	let live = 0;
	for (const entry of treeEntries(self.scopeId)) {
		const level = entry.ownerId === undefined ? undefined : depth.get(entry.ownerId);
		if (level === undefined) continue;
		depth.set(entry.id, level + 1);
		parent.set(entry.id, entry.ownerId!);
		const own = nodes.get(entry.ownerId!)?.agents.counts(entry.id);
		const queued = own?.queued ? [`${own.queued} queued`] : [];
		rows.set(entry.id, `${"  ".repeat(level)}Agent ${[label(entry, ids), entry.state, ...queued].join("  ")}`);
		// A live Agent is listed with its owners, so the tree stays readable.
		if (own?.busy || queued.length > 0) {
			live += 1;
			for (let id: string | undefined = entry.id; id !== undefined && id !== self.id && !shown.has(id); id = parent.get(id)) shown.add(id);
		}
	}
	const running = programs?.list().filter((record) => record.state === "running") ?? [];
	const lines = [
		...[...rows].filter(([id]) => shown.has(id)).map(([, row]) => row),
		...running.map((record) => `Program ${programs!.label(record)}  running`),
	];
	if (lines.length === 0) return [];
	if (lines.length > MAX_LINES - 1) lines.splice(MAX_LINES - 2, Infinity, `+${lines.length - (MAX_LINES - 2)} more`);
	return [`Tasks (${live + running.length} live, /tasks to hide)`, ...lines.map((line) => `  ${line}`)];
}

/** Keeps the task panel above the editor current while the Session is loaded; `toggle` hides or shows it. */
export function createPanel(getNode: () => AgentNode | undefined, getPrograms: () => Programs | undefined) {
	let ctx: ExtensionContext | undefined;
	let hidden = false;
	let scheduled = false;
	let unsubscribe: (() => void) | undefined;

	const render = () => {
		scheduled = false;
		const node = getNode();
		if (!ctx?.hasUI || !node) return;
		const lines = hidden ? [] : panelLines(node, getPrograms());
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
			unsubscribe?.();
			unsubscribe = undefined;
			if (ctx?.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
			ctx = undefined;
		},
	};
}
