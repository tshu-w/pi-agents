/** Records the nested `read` calls hooks see; a call waits up to `holdMs` or until its signal aborts. */
export const hooks = { calls: [], holdMs: 0 };
globalThis.piAgentsHooks = hooks;

export default function (pi) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "read" || !event.parentToolCallId) return;
		const signal = ctx.signal;
		const call = { id: event.toolCallId, signal, aborted: false };
		hooks.calls.push(call);
		if (!hooks.holdMs) return;
		await new Promise((resolve) => {
			const timer = setTimeout(resolve, hooks.holdMs);
			signal?.addEventListener("abort", () => { call.aborted = true; clearTimeout(timer); resolve(); }, { once: true });
		});
	});
}
