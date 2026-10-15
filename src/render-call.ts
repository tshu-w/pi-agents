import { keyHint, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	getCapabilities,
	getImageDimensions,
	imageFallback,
	Spacer,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";

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

/** Durations as Pi shows them: `4.2s` below a minute, then `1m 30s` and `2h 3m 4s`. */
export function formatDuration(ms: number): string {
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
	bold(text: string): string;
}

// As in Pi's `codemode` output.
const BLOCK_PREVIEW_LINES = 5;

// Pi's `stripAnsi` pattern, derived from ansi-regex (MIT), which Pi does not export: OSC sequences ended by ST, and CSI sequences.
const ANSI = /\x1b\][\s\S]*?(?:\x07|\x1b\\|\x9c)|[\x1b\x9b][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

/**
 * `text` as Pi shows tool output: without ANSI sequences, carriage returns, or the control characters Pi's
 * `sanitizeBinaryOutput` removes, which it does not export; and with tabs as 3 spaces.
 */
function displayText(text: string): string {
	return text.replace(ANSI, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "").replace(/\r/g, "").replace(/\t/g, "   ");
}

/** Placeholders for a result's images where Pi shows them as text: when the terminal cannot show images or they are hidden. */
function imageText(content: Array<{ type: string; data?: string; mimeType?: string }>, showImages: boolean | undefined): string {
	if (getCapabilities().images && showImages) return "";
	return content.flatMap((part) => part.type !== "image" ? [] : [imageFallback(
		part.mimeType ?? "image/unknown",
		part.data && part.mimeType ? getImageDimensions(part.data, part.mimeType) ?? undefined : undefined,
	)]).join("\n");
}

/** Styled non-blank lines of `text`. */
function outputText(text: string, theme: ResultTheme): string {
	return displayText(text).split("\n").filter((line) => line.trim()).map((line) => theme.fg("toolOutput", line)).join("\n");
}

/**
 * The collapsed view of `wait` results: each result as its line in bold, then the first visual lines of its body without
 * blank lines, indented, and the number of lines after them; then the lines of the notes, without blank lines.
 * Like Pi's `codemode` output preview, it counts wrapped lines and caches its lines per width.
 */
export function renderResultList(results: { line: string; body: string }[], notes: string[], theme: ResultTheme): Component {
	let cached: { width: number; lines: string[] } | undefined;
	return {
		render(width) {
			if (cached?.width !== width) {
				const lines: string[] = [];
				for (const { line, body } of results) {
					lines.push(...new Text(theme.fg("toolOutput", theme.bold(displayText(line))), 0, 0).render(width));
					const preview = truncateToVisualLines(outputText(body, theme), BLOCK_PREVIEW_LINES, width - 2, 0, "start");
					lines.push(...preview.visualLines.map((visual) => `  ${visual}`));
					if (preview.skippedCount > 0) lines.push(truncateToWidth(`  ${moreLines(preview.skippedCount, theme)}`, width, "..."));
				}
				lines.push(...new Text(outputText(notes.join("\n"), theme), 0, 0).render(width));
				cached = { width, lines };
			}
			return cached.lines;
		},
		invalidate() {
			cached = undefined;
		},
	};
}

/**
 * The text output like Pi's default result, with the duration of a timed call below it.
 * Like Pi's `bash` result, a blank line precedes the output and the duration. When collapsed, `tidy` may show its view
 * instead, followed by the placeholders of the result's images.
 */
export function renderTextResult(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> },
	options: { expanded: boolean; isPartial: boolean },
	theme: ResultTheme,
	context: { state: unknown; invalidate: () => void; lastComponent?: unknown; durationMs?: number; showImages?: boolean },
	tidy?: () => Component | undefined,
): Component {
	const images = imageText(result.content, context.showImages);
	// As Pi's text output of a result: its text items, then its image placeholders.
	const text = result.content.flatMap((part) => part.type === "text" && part.text ? [displayText(part.text)] : []).join("\n");
	const output = [text, images].filter(Boolean).join("\n").trim();
	const lines = output ? output.split("\n") : [];
	const shown = options.expanded ? lines : lines.slice(0, RESULT_PREVIEW_LINES);
	const tidied = options.expanded ? undefined : tidy?.();
	const sections: Component[] = [];
	if (tidied) {
		const section = new Container();
		section.addChild(tidied);
		if (images) section.addChild(new Text(theme.fg("toolOutput", images), 0, 0));
		sections.push(section);
	} else if (shown.length > 0) {
		let text = shown.map((line) => theme.fg("toolOutput", line)).join("\n");
		if (shown.length < lines.length) text += `\n${moreLines(lines.length - shown.length, theme)}`;
		sections.push(new Text(text, 0, 0));
	}
	const duration = updateDuration(context.state as DurationState, options.isPartial, context.durationMs, context.invalidate);
	if (duration) sections.push(new Text(theme.fg("muted", duration), 0, 0));
	const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
	component.clear();
	for (const section of sections) {
		component.addChild(new Spacer(1));
		component.addChild(section);
	}
	return component;
}
