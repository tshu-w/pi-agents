import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { label, nodes, onTreeChange, treeEntries, treeUsage, type AgentNode, type Usage } from "../agents/agents.ts";
import { programListLine, type Programs } from "../programs/programs.ts";

const WIDGET_KEY = "pi-agents";

export function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1000000) return `${Math.round(value / 1000)}k`;
	return `${(value / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: Usage): string {
	return `${usage.turns} turns ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} R${formatTokens(usage.cacheRead)} W${formatTokens(usage.cacheWrite)} $${usage.cost.toFixed(4)}`;
}

function counts(pairs: ReadonlyArray<readonly [number, string]>): string[] {
	return pairs.filter(([count]) => count > 0).map(([count, text]) => `${count} ${text}`);
}

/** The task panel: the Agent's owned Agents as a tree, then its background Programs. Empty when there is nothing to list. */
export function panelLines(self: AgentNode, programs: Programs | undefined): string[] {
	const lines: string[] = [];
	const depth = new Map<string, number>([[self.id, 0]]);
	const parent = new Map<string, string>();
	const rows = new Map<string, string>();
	const shown = new Set<string>();
	for (const entry of treeEntries(self.scopeId)) {
		const level = entry.ownerId === undefined ? undefined : depth.get(entry.ownerId);
		if (level === undefined) continue;
		depth.set(entry.id, level + 1);
		parent.set(entry.id, entry.ownerId!);
		const own = nodes.get(entry.ownerId!)?.agents.counts(entry.id);
		const extra = counts([[own?.queued ?? 0, "queued"], [own?.unread ?? 0, "unread"]]);
		rows.set(entry.id, `${"  ".repeat(level + 1)}${[label(entry), entry.state, ...extra].join("  ")}`);
		// An Agent with work or results is listed with its owners, so the tree stays readable.
		if (own?.busy || extra.length > 0) {
			for (let id: string | undefined = entry.id; id !== undefined && id !== self.id && !shown.has(id); id = parent.get(id)) shown.add(id);
		}
	}
	if (shown.size > 0) {
		const { busy, queued, unread } = self.agents.summary();
		const summary = counts([[busy, "busy"], [queued, "queued inputs"], [unread, "unread results"]]);
		lines.push(`Agents: ${[...summary, formatUsage(treeUsage(self.rootId))].join(" · ")}`, ...[...rows].filter(([id]) => shown.has(id)).map(([, row]) => row));
	}
	const { running, unreturned } = programs?.summary() ?? { running: 0, unreturned: 0 };
	if (running > 0 || unreturned > 0) {
		const shown = programs!.list().filter((record) => record.state === "running" || !record.returned);
		lines.push(`Programs: ${counts([[running, "running"], [unreturned, "unreturned results"]]).join(" · ")}`, ...shown.map((record) => `  ${programListLine(record)}`));
	}
	if (lines.length > 0) lines[0] += " · /tasks to hide";
	return lines;
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
		const theme = ctx.ui.theme;
		ctx.ui.setWidget(WIDGET_KEY, lines.length === 0
			? undefined
			: lines.map((line, index) => index === 0 || !line.startsWith(" ") ? theme.fg("accent", line) : theme.fg("muted", line)));
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
