import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type ToolCallTheme = {
	bold(text: string): string;
	fg(color: "toolTitle" | "text", text: string): string;
};

/** A call in function-call form, like `agent(action="wait", target="w1")`, as in pi-control. */
export function formatToolCall(name: string, args: unknown, theme: ToolCallTheme): string {
	const entries = Object.entries((args ?? {}) as Record<string, unknown>).filter(([, value]) => value !== undefined);
	const fields = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(", ");
	return `${theme.fg("toolTitle", theme.bold(name))}${theme.fg("text", `(${fields})`)}`;
}

export function renderToolCall(name: string, args: unknown, theme: ToolCallTheme, lastComponent?: unknown): Text {
	const component = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
	component.setText(formatToolCall(name, args, theme));
	return component;
}

const RESULT_PREVIEW_LINES = 10;

/** The notice below a collapsed preview: the number of hidden lines and the key that expands it. */
export function moreLines(hidden: number, theme: { fg(color: "muted", text: string): string }): string {
	return `${theme.fg("muted", `... (${hidden} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

/** Per-row state of a timed call: when it started executing and when its result arrived. */
export interface DurationState {
	startedAt?: number;
	endedAt?: number;
	interval?: ReturnType<typeof setInterval>;
}

export function startDuration(state: DurationState, enabled: boolean, executionStarted: boolean): void {
	if (enabled && executionStarted && state.startedAt === undefined) state.startedAt = Date.now();
}

function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${totalSeconds % 60}s`;
}

/** "Elapsed …" while the call runs, refreshed every second, then "Took …" from Pi's recorded `durationMs` when present. */
function updateDuration(state: DurationState, isPartial: boolean, durationMs: number | undefined, invalidate: () => void): string | undefined {
	if (state.startedAt === undefined) return undefined;
	if (isPartial && !state.interval) state.interval = setInterval(invalidate, 1000);
	if (!isPartial) {
		state.endedAt ??= Date.now();
		clearInterval(state.interval);
		state.interval = undefined;
	}
	const ms = !isPartial && durationMs !== undefined ? durationMs : (state.endedAt ?? Date.now()) - state.startedAt;
	return `${isPartial ? "Elapsed" : "Took"} ${formatDuration(ms)}`;
}

interface ResultTheme {
	fg(color: "toolOutput" | "muted", text: string): string;
}

/**
 * The text output like Pi's default result, with the duration of a timed call below it.
 * Like Pi's `bash` result, a blank line precedes the output and the duration.
 */
export function renderTextResult(
	result: { content: Array<{ type: string; text?: string }> },
	options: { expanded: boolean; isPartial: boolean },
	theme: ResultTheme,
	context: { state: unknown; invalidate: () => void; lastComponent?: unknown; durationMs?: number },
): Text {
	const output = result.content.flatMap((part) => part.type === "text" && part.text ? [part.text] : []).join("\n").trim();
	const lines = output ? output.split("\n") : [];
	const shown = options.expanded ? lines : lines.slice(0, RESULT_PREVIEW_LINES);
	const sections: string[] = [];
	if (shown.length > 0) {
		let text = shown.map((line) => theme.fg("toolOutput", line)).join("\n");
		if (shown.length < lines.length) text += `\n${moreLines(lines.length - shown.length, theme)}`;
		sections.push(text);
	}
	const duration = updateDuration(context.state as DurationState, options.isPartial, context.durationMs, context.invalidate);
	if (duration) sections.push(theme.fg("muted", duration));
	const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	component.setText(sections.map((section) => `\n${section}`).join("\n"));
	return component;
}
