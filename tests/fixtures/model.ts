import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

/** A local model that answers `answer:<last message>`; the tests never call a real provider. */
export default function (pi: any) {
	pi.registerProvider("agents-test", {
		api: "agents-test-api",
		baseUrl: "http://127.0.0.1:1",
		apiKey: "local-test-only",
		models: [{ id: "fake", name: "Local fake", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1000 }],
		streamSimple(model: any, context: any) {
			const stream = createAssistantMessageEventStream();
			const last = context.messages.at(-1);
			const text = typeof last.content === "string" ? last.content : last.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("");
			const output = {
				role: "assistant", content: [{ type: "text", text: `answer:${text}` }], api: model.api, provider: model.provider, model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop", timestamp: Date.now(),
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: output } as any);
				stream.push({ type: "done", reason: "stop", message: output } as any);
				stream.end();
			});
			return stream;
		},
	});
}
