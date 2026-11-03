import { getMarkdownTheme, UserMessageComponent, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { RESULT_TAG } from "../agents/agents.ts";
import { messageBody, type NotifiedResult, type Sender } from "../agents/registry.ts";
import { PROGRAM_RESULT_TAG, SCRIPT_HEADER } from "../programs/programs.ts";
import { formatDuration, renderResultList } from "../render-call.ts";

const AGENT_NOTIFICATION = new RegExp(`^<${RESULT_TAG} name="([^"]*)" id="([^"]*)" status="([^"]*)">\\n([\\s\\S]*)\\n</${RESULT_TAG}>(?:\\n+([\\s\\S]*))?$`);
const PROGRAM_NOTIFICATION = new RegExp(`^<${PROGRAM_RESULT_TAG} id="([^"]*)" status="([^"]*)">\\n([\\s\\S]*)\\n</${PROGRAM_RESULT_TAG}>(?:\\n+([\\s\\S]*))?$`);

/** The result of a notification made before notifications recorded their results, parsed from its text. */
function parsedResult(text: string): NotifiedResult | undefined {
	const agent = AGENT_NOTIFICATION.exec(text);
	if (agent) return { name: agent[1], id: agent[2]!, status: agent[3]!, body: agent[4]!, notice: agent[5] };
	const program = PROGRAM_NOTIFICATION.exec(text);
	if (!program) return undefined;
	const header = SCRIPT_HEADER.exec(program[3]!);
	return { id: program[1]!, status: program[2]!, ...(header?.[1] !== undefined && { seconds: Number(header[1]) }), body: program[3]!.slice(header?.[0].length ?? 0), notice: program[4] };
}

/** A result's line: an Agent's name and ID, or a Program's ID and wall time, with its status. */
function resultLine({ name, id, status, seconds }: NotifiedResult): string {
	if (name !== undefined) return `${name} (${id})  ${status}`;
	return [`Program ${id}`, status, ...(seconds === undefined ? [] : [formatDuration(seconds * 1000)])].join("  ");
}

/**
 * Collapsed, a message from another Agent shows its sender after the label, as Pi shows a collapsed skill, and the
 * user's input from the task viewer shows as a user message. Expanded, or for any other message, Pi shows the text the
 * model received.
 */
export const renderAgentMessage: MessageRenderer = (message, { expanded, outputPad }, theme) => {
	if (expanded) return undefined;
	const details = message.details as { user?: boolean; sender?: Sender; results?: NotifiedResult[] } | undefined;
	// A Program's notification also holds the images of its result, which show when expanded.
	const content = typeof message.content === "string" ? message.content : message.content.find((part) => part.type === "text")?.text;
	if (content === undefined) return undefined;
	if (details?.user) return new UserMessageComponent(content, getMarkdownTheme(), outputPad);
	const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
	const label = theme.fg("customMessageLabel", `\x1b[1m[${message.customType}]\x1b[22m`);
	// A notification shows each of its results as a line with the first lines of its body.
	const parsed = !details?.sender && !details?.results && parsedResult(content);
	const results = details?.results ?? (parsed ? [parsed] : undefined);
	if (results) {
		box.addChild(new Text(label, 0, 0));
		box.addChild(new Spacer(1));
		box.addChild(renderResultList(results.map((result) => ({ line: resultLine(result), body: result.body })), results.flatMap((result) => result.notice ? [result.notice] : []), {}, theme));
		return box;
	}
	const body = details?.sender && messageBody(content, details.sender);
	if (body === undefined) return undefined;
	const { id, name } = details!.sender!;
	const sender = name === undefined ? theme.fg("customMessageText", ` from ${id}`) : theme.fg("customMessageText", ` from ${name}`) + theme.fg("dim", ` (${id})`);
	box.addChild(new Text(label + sender, 0, 0));
	box.addChild(new Spacer(1));
	box.addChild(new Markdown(body, 0, 0, getMarkdownTheme(), { color: (text) => theme.fg("customMessageText", text) }));
	return box;
};
