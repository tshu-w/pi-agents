import { highlightCode, keyHint, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { PiCodemode } from "./codemode.ts";
import { PROGRAM_TOOL_NAME, programCallableTools } from "./program-execute.ts";
import { formatToolCall, renderTextResult, startDuration, type DurationState } from "./render-call.ts";

type Codemode = typeof import("@earendil-works/pi-codemode");
type Loadout = Parameters<NonNullable<ToolDefinition["prepareLoadout"]>>[0];
type Changes = ReturnType<NonNullable<ToolDefinition["prepareLoadout"]>>;
type Renderers = Pick<ToolDefinition, "renderCall" | "renderResult">;

const CODE_PREVIEW_LINES = 10;

/** Points the codemode API text at `program`. */
function forProgram(text: string): string {
	return text.replaceAll("codemode tool declaration:", "program tool declaration:").replaceAll("`codemode` calls", "`program` runs");
}

function readSettings(pi: ExtensionAPI): { mode: "on" | "only"; inlineBudget?: number } {
	const settings = pi.getSettings().codemode;
	const budget = settings?.inlineBudget;
	return {
		mode: settings?.mode === "only" ? "only" : "on",
		inlineBudget: typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : undefined,
	};
}

/**
 * Presents the loadout like Pi's `codemode` tool, following `codemode.mode`:
 * - `on`: declared tools that Programs can call get their declaration appended, and the `program`
 *   description lists the callable tools without `direct` exposure.
 * - `only`: the `program` description lists every callable tool, and requests leave out the
 *   declarations of active `direct` tools.
 */
export function prepareProgramLoadout(
	pi: ExtensionAPI,
	codemode: Codemode,
	piCodemode: PiCodemode,
	intro: string,
	loadout: Loadout,
): Changes {
	const { mode, inlineBudget } = readSettings(pi);
	const isDirect = (name: string) => loadout.getExposure(name) === "direct";
	const callable = programCallableTools(piCodemode, loadout.callable);
	const callableNames = new Set(callable.map((tool) => tool.name));
	const descriptions: Record<string, string> = {};
	if (mode === "on") {
		for (const tool of loadout.declared) {
			if (callableNames.has(tool.name)) descriptions[tool.name] = forProgram(codemode.renderToolSample(piCodemode.toCodemodeDeclaration(tool) as never));
		}
	}
	const listed = mode === "only" ? callable : callable.filter((tool) => !isDirect(tool.name));
	const namespaces = new Map(listed.flatMap((tool) => {
		const namespace = loadout.getNamespace(tool.name);
		return namespace ? [[tool.name, namespace] as const] : [];
	}));
	descriptions[PROGRAM_TOOL_NAME] = `${intro}\n\n${forProgram(piCodemode.createCodemodeDescription(listed, {
		models: true,
		namespaces,
		deferred: new Set(listed.filter((tool) => loadout.getExposure(tool.name) === "deferred").map((tool) => tool.name)),
		inlineBudget: inlineBudget ?? piCodemode.DEFAULT_CODEMODE_INLINE_BUDGET,
	}))}`;
	const declared = new Set(loadout.declared.map((tool) => tool.name));
	return {
		descriptions,
		hiddenDeclarations: mode === "only" ? callable.filter((tool) => isDirect(tool.name) && declared.has(tool.name)).map((tool) => tool.name) : [],
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
