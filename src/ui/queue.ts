import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TruncatedText, type TUI } from "@earendil-works/pi-tui";
import { MESSAGE_TAG, MESSAGE_TYPE } from "../agents/registry.ts";

const WIDGET_KEY = "pi-agents-queue";

type Queued = { role: string; customType?: string; content?: unknown; details?: { delivery?: string } };

/** One line for an Agent message: its sender and body. */
function summary(content: unknown): string {
	const text = typeof content === "string" ? content : "";
	const match = new RegExp(`^<${MESSAGE_TAG} from="([^"]*)"[^>]*>\\n([\\s\\S]*)\\n</${MESSAGE_TAG}>$`).exec(text);
	return (match ? `[${match[1]}] ${match[2]}` : text).replace(/\s+/g, " ").trim();
}

/** Agent messages waiting in the Session's queues, which Pi does not list as it lists the user's. */
export function queuedLines(agent: AgentSession["agent"]): string[] {
	const queues = agent as unknown as Record<"steeringQueue" | "followUpQueue", { messages: Queued[] }>;
	const lines = (label: string, messages: Queued[]) => messages
		.filter((message) => message.role === "custom" && message.customType === MESSAGE_TYPE)
		// A write waits in the steering queue but asks for nothing, so it is labeled apart from a steer.
		.map((message) => `${message.details?.delivery === "write" ? "Write" : label}: ${summary(message.content)}`);
	return [...lines("Steering", queues.steeringQueue.messages), ...lines("Follow-up", queues.followUpQueue.messages)];
}

/**
 * Lists the Agent messages queued in `session` under Pi's own queued messages. The list is read from
 * the queues on each render, so it follows them as they are consumed or cleared; `update` renders it
 * after a message is queued.
 */
export function showQueue(ctx: ExtensionContext, session: () => AgentSession | undefined) {
	let tui: TUI | undefined;
	if (ctx.hasUI) {
		ctx.ui.setWidget(WIDGET_KEY, (current, theme) => {
			tui = current;
			return {
				render: (width: number) => {
					const agent = session()?.agent;
					return agent ? queuedLines(agent).flatMap((line) => new TruncatedText(theme.fg("dim", line), 1, 0).render(width)) : [];
				},
				invalidate() {},
			};
		});
	}
	return { update: () => tui?.requestRender() };
}
