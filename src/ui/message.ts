import { getMarkdownTheme, UserMessageComponent, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { RESULT_TAG } from "../agents/agents.ts";
import { messageBody, type Sender } from "../agents/registry.ts";
import { renderResultList } from "../render-call.ts";

const NOTIFICATION = new RegExp(`^<${RESULT_TAG} name="([^"]*)" id="([^"]*)" status="([^"]*)">\\n([\\s\\S]*)\\n</${RESULT_TAG}>(?:\\n+([\\s\\S]*))?$`);

/**
 * Collapsed, a message from another Agent shows its sender after the label, as Pi shows a collapsed skill, and the
 * user's input from the task viewer shows as a user message. Expanded, or for any other message, Pi shows the text the
 * model received.
 */
export const renderAgentMessage: MessageRenderer = (message, { expanded, outputPad }, theme) => {
	if (expanded || typeof message.content !== "string") return undefined;
	const details = message.details as { user?: boolean; sender?: Sender } | undefined;
	if (details?.user) return new UserMessageComponent(message.content, getMarkdownTheme(), outputPad);
	const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
	const label = theme.fg("customMessageLabel", `\x1b[1m[${message.customType}]\x1b[22m`);
	// A notification shows its result as `wait` does.
	const result = !details?.sender && NOTIFICATION.exec(message.content);
	if (result) {
		const [, name, id, state, body, notice] = result;
		box.addChild(new Text(label, 0, 0));
		box.addChild(new Spacer(1));
		box.addChild(renderResultList([{ line: `${name} (${id})  ${state}`, body: body! }], notice ? [notice] : [], {}, theme));
		return box;
	}
	const body = details?.sender && messageBody(message.content, details.sender);
	if (body === undefined) return undefined;
	const { id, name } = details!.sender!;
	const sender = name === undefined ? theme.fg("customMessageText", ` from ${id}`) : theme.fg("customMessageText", ` from ${name}`) + theme.fg("dim", ` (${id})`);
	box.addChild(new Text(label + sender, 0, 0));
	box.addChild(new Spacer(1));
	box.addChild(new Markdown(body, 0, 0, getMarkdownTheme(), { color: (text) => theme.fg("customMessageText", text) }));
	return box;
};
