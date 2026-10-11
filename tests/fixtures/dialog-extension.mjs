/** `/ask` opens an editor dialog and reports the text in a notification. */
export default function (pi) {
	pi.registerCommand("ask", {
		description: "Ask for text",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`edited:${await ctx.ui.editor("Proceed?", "draft")}`);
		},
	});
}
