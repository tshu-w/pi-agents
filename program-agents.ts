import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Agents, label, messageText, nodes, THINKING_LEVELS, type AgentNode, type Limits } from "./agents.ts";
import type { AgentOptions, ProgramAgentHost, SendOptions } from "./program-sandbox.ts";

const CLEANUP_TIMEOUT_MS = 10_000;
const DELIVERIES = ["followUp", "steer", "write"];

export interface ProgramScope {
	host: ProgramAgentHost;
	/** Aborts unfinished inputs and takes the Agents offline, or gives up after a timeout. */
	close(): Promise<void>;
}

/**
 * The Agents a Program creates with `agent()`. They count toward the caller's tree, see only
 * one another, and are never persisted: when the Program ends they go offline for good.
 */
export function programScope(
	id: string,
	caller: AgentNode,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: { agentDir: string; limits: Limits; extensions: string[] },
): ProgramScope {
	const self = { id, rootId: caller.rootId, scopeId: id, ownerId: caller.id, name: () => "program" };
	const agents = new Agents(pi, self, options.agentDir, options.limits, options.extensions, true);
	agents.setContext(ctx);
	nodes.set(id, {
		...self,
		program: true,
		agents,
		cwd: () => ctx.cwd,
		busy: () => true,
		sessionFile: () => undefined,
		receive: () => { throw new Error("A Program does not receive messages."); },
		persistUsage: () => {},
	});
	const from = { id, name: self.name() };
	const host: ProgramAgentHost = {
		create: async (agentId, name, agentOptions: AgentOptions) => {
			const { cwd, context, model, thinkingLevel } = agentOptions;
			if (typeof name !== "string" || !name.trim()) throw new Error("agent() name must be a non-empty string");
			if (cwd !== undefined && typeof cwd !== "string") throw new Error("agent() cwd must be a string");
			if (context !== undefined && context !== "fresh" && context !== "fork") throw new Error('agent() context must be "fresh" or "fork"');
			if (model !== undefined && typeof model !== "string") throw new Error("agent() model must be provider/modelId");
			if (thinkingLevel !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(thinkingLevel)) {
				throw new Error(`agent() thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`);
			}
			agents.create({ name, cwd, context, model, thinkingLevel: thinkingLevel as (typeof THINKING_LEVELS)[number] | undefined }, agentId);
		},
		send: async (agentId, message, sendOptions: SendOptions) => {
			const delivery = sendOptions.deliverAs ?? "followUp";
			const { schema } = sendOptions;
			if (typeof message !== "string" || !message.trim()) throw new Error("send() requires a non-empty message");
			if (!DELIVERIES.includes(delivery)) throw new Error('send() deliverAs must be "followUp", "steer", or "write"');
			if (schema !== undefined) {
				if (delivery !== "followUp") throw new Error('send() accepts schema only with deliverAs "followUp"');
				if (typeof schema !== "boolean" && (typeof schema !== "object" || schema === null || Array.isArray(schema))) {
					throw new Error("send() schema must be a JSON Schema object or boolean");
				}
			}
			const agent = agents.ownedTarget(agentId).record;
			const text = messageText(from, true, delivery, message);
			if (delivery === "write") {
				agents.accept(agentId, text, "write", { fromOwner: true, notification: false });
				return undefined;
			}
			const record = await agents.request(agentId, text, delivery, schema);
			if (record.state === "completed") return schema === undefined ? record.result : record.value;
			throw new Error(record.state === "failed" ? `Agent ${label(agent)} failed: ${record.result}` : `Agent ${label(agent)} was aborted.`);
		},
		abort: async (agentId) => {
			await agents.abort(agents.ownedTarget(agentId));
		},
	};
	return {
		host,
		close: async () => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					agents.shutdown(),
					new Promise((resolve) => { timer = setTimeout(resolve, CLEANUP_TIMEOUT_MS); }),
				]);
			} finally {
				clearTimeout(timer);
				nodes.delete(id);
			}
		},
	};
}
