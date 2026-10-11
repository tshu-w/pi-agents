/**
 * Agent messages queued in a root Session outlive the user's actions on Pi's queue. Relies on
 * private members of `AgentSession`; check them when Pi is updated.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { takeQueued } from "../agents/agents.ts";
import { nodes } from "../agents/registry.ts";

const PATCHED = Symbol.for("pi-agents:queue-patched");

type Patchable = Record<PropertyKey, any>;

/**
 * Clearing the queue, as Pi's dequeue does, leaves Agent messages queued; stopping the turn adds
 * them to the Session without starting a turn. Owned Agents withdraw their queued inputs on abort.
 */
export function installQueuePatches(Session: typeof AgentSession): void {
	const session = Session.prototype as unknown as Patchable;
	if (session[PATCHED]) return;
	session[PATCHED] = true;
	const root = (self: AgentSession) => nodes.get(self.sessionManager.getSessionId())?.ownerId === undefined;
	const clearQueue = session.clearQueue;
	session.clearQueue = function (this: AgentSession) {
		if (!root(this)) return clearQueue.call(this);
		const kept = takeQueued(this.agent);
		const cleared = clearQueue.call(this);
		for (const message of kept) {
			if (message.details.delivery === "followUp") this.agent.followUp(message);
			else this.agent.steer(message);
		}
		return cleared;
	};
	const abort = session.abort;
	session.abort = async function (this: AgentSession) {
		if (root(this)) for (const message of takeQueued(this.agent)) await this.sendCustomMessage(message, { triggerTurn: false });
		return abort.call(this);
	};
}
