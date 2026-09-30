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

export function renderToolCall(name: string, args: unknown, theme: ToolCallTheme, resultReady: boolean, lastComponent?: unknown): Text {
	const component = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
	component.setText(formatToolCall(name, args, theme) + (resultReady ? "\n" : ""));
	return component;
}
