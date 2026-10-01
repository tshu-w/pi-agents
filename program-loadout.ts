import { highlightCode, keyHint, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { PiCodemode } from "./codemode.ts";
import { forProgram, PROGRAM_TOOL_NAME } from "./program-execute.ts";
import { formatToolCall, renderTextResult, startDuration, type DurationState } from "./render-call.ts";

const CODEMODE_TOOL_NAME = "codemode";

type Loadout = Parameters<NonNullable<ToolDefinition["prepareLoadout"]>>[0];
type Changes = ReturnType<NonNullable<ToolDefinition["prepareLoadout"]>>;
type Renderers = Pick<ToolDefinition, "renderCall" | "renderResult">;

const CODE_PREVIEW_LINES = 10;

function readSettings(pi: ExtensionAPI): { mode: "on" | "only"; inlineBudget?: number } {
	const settings = pi.getSettings().codemode;
	const budget = settings?.inlineBudget;
	return {
		mode: settings?.mode === "only" ? "only" : "on",
		inlineBudget: typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : undefined,
	};
}

/**
 * Presents the loadout with Pi's `codemode` `prepareLoadout`, following `codemode.mode`, and
 * moves its `codemode` description to `program`.
 */
export function programLoadout(pi: ExtensionAPI, piCodemode: PiCodemode, intro: string): (loadout: Loadout) => Changes {
	const { prepareLoadout } = piCodemode.createCodemodeToolDefinition({
		models: true,
		getMode: () => readSettings(pi).mode,
		getInlineBudget: () => readSettings(pi).inlineBudget,
	});
	return (loadout) => {
		const changes = prepareLoadout!(loadout) ?? {};
		const descriptions: Record<string, string> = {};
		for (const [name, description] of Object.entries(changes.descriptions ?? {})) {
			if (name === CODEMODE_TOOL_NAME) descriptions[PROGRAM_TOOL_NAME] = `${intro}\n\n${forProgram(description)}`;
			else descriptions[name] = forProgram(description);
		}
		return { descriptions, hiddenDeclarations: changes.hiddenDeclarations };
	};
}

/** The program description before the loadout is prepared. */
export function programDescription(piCodemode: PiCodemode, intro: string): string {
	return `${intro}\n\n${forProgram(piCodemode.createCodemodeDescription([], { models: true }))}`;
}

/** Calls render in function-call form, with the `run` script below it. Results render like `codemode`. */
export function programRenderers(piCodemode: PiCodemode): Renderers {
	return {
		renderCall(args, theme, context) {
			const { code, ...rest } = (args ?? {}) as Record<string, unknown>;
			startDuration(context.state as DurationState, rest.action === "wait", context.executionStarted);
			let text = formatToolCall(PROGRAM_TOOL_NAME, rest, theme);
			if (typeof code === "string" && code) {
				const lines = highlightCode(code.replace(/\r/g, "").replace(/\t/g, "   ").trimEnd(), "javascript");
				const shown = context.expanded ? lines : lines.slice(0, CODE_PREVIEW_LINES);
				text += `\n${shown.join("\n")}`;
				if (shown.length < lines.length) {
					text += `\n${theme.fg("muted", `... (${lines.length - shown.length} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
				}
			}
			if (!context.isPartial) text += "\n";
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			component.setText(text);
			return component;
		},
		// `wait` shows how long it has waited; the other results render like `codemode`.
		renderResult: (result, options, theme, context) => (context.args as { action?: string }).action === "wait"
			? renderTextResult(result, options, theme, context, () => keyHint("app.tools.expand", "to expand"))
			: piCodemode.renderResult(result, options, theme, context) as Text,
	};
}
