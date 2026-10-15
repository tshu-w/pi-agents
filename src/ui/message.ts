import { getMarkdownTheme, UserMessageComponent, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { messageBody, type Sender } from "../agents/registry.ts";

/**
 * Collapsed, a message from another Agent shows its sender after the label, as Pi shows a collapsed skill, and the
 * user's input from the task viewer shows as a user message. Expanded, or for any other message, Pi shows the text the
 * model received.
 */
export const renderAgentMessage: MessageRenderer = (message, { expanded, outputPad }, theme) => {
	if (expanded || typeof message.content !== "string") return undefined;
	const details = message.details as { user?: boolean; sender?: Sender } | undefined;
	if (details?.user) return new UserMessageComponent(message.content, getMarkdownTheme(), outputPad);
	const body = details?.sender && messageBody(message.content, details.sender);
	if (body === undefined) return undefined;
	const { id, name } = details!.sender!;
	const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
	const label = theme.fg("customMessageLabel", `\x1b[1m[${message.customType}]\x1b[22m`);
	const sender = name === undefined ? theme.fg("customMessageText", ` from ${id}`) : theme.fg("customMessageText", ` from ${name}`) + theme.fg("dim", ` (${id})`);
	box.addChild(new Text(label + sender, 0, 0));
	box.addChild(new Spacer(1));
	box.addChild(new Markdown(body, 0, 0, getMarkdownTheme(), { color: (text) => theme.fg("customMessageText", text) }));
	return box;
};
