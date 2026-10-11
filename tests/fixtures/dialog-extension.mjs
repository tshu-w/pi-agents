import { existsSync, rmSync } from "node:fs";

/**
 * `/ask` opens an editor dialog and reports the text in a notification; `/relay <text>` sends the text as a prompt.
 * With `AGENTS_TEST_RELEASE`, input starting with "gate " waits until `<release>-gate` exists; a turn settles only
 * once `<release>-pause` is gone, and if `<release>-chain` exists then, a message starts another turn.
 */
export default function (pi) {
	const release = process.env.AGENTS_TEST_RELEASE;
	pi.registerCommand("ask", {
		description: "Ask for text",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`edited:${await ctx.ui.editor("Proceed?", "draft")}`);
		},
	});
	pi.registerCommand("relay", {
		description: "Send text as a prompt",
		handler: async (args) => {
			pi.sendUserMessage(args);
		},
	});
	pi.on("input", async (event) => {
		if (!release || !event.text.startsWith("gate ")) return;
		while (!existsSync(`${release}-gate`)) await new Promise((resolve) => setTimeout(resolve, 20));
		rmSync(`${release}-gate`, { force: true });
	});
	pi.on("agent_settled", async () => {
		if (!release) return;
		while (existsSync(`${release}-pause`)) await new Promise((resolve) => setTimeout(resolve, 20));
		if (!existsSync(`${release}-chain`)) return;
		rmSync(`${release}-chain`, { force: true });
		pi.sendMessage({ customType: "chain", content: "hold", display: true }, { triggerTurn: true });
	});
}
