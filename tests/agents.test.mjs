import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const agentDir = mkdtempSync(join(tmpdir(), "pi-agents-home-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { pi, PI_PACKAGE } = await import("./pi.mjs");
const ai = await import(join(PI_PACKAGE, "node_modules/@earendil-works/pi-ai/dist/index.js"));

const textOf = (content) => typeof content === "string"
	? content
	: content.filter((block) => block.type === "text").map((block) => block.text).join("\n");

/** A gate that holds owned Agents' answers until opened, or until their turn is aborted. */
function gate() {
	let open;
	const promise = new Promise((resolve) => { open = resolve; });
	return { promise, open };
}

/**
 * Starts a root Session whose model answers from its last message: owned Agents answer
 * `answer:<first input>`, and the root acknowledges notifications with plain text.
 */
async function startRoot(limits = {}) {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ "pi-agents": { maxConcurrent: 3, maxOutstanding: 8, ...limits } }));
	const cwd = mkdtempSync(join(tmpdir(), "pi-agents-cwd-"));
	const state = { hold: undefined, rootMessages: [] };
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "model" }], tokensPerSecond: 0 });
	const route = async (context, options) => {
		const messages = context.messages;
		const first = textOf(messages.find((message) => message.role === "user")?.content ?? "");
		const last = textOf(messages.at(-1)?.content ?? "");
		if (!first.startsWith("Message from")) {
			state.rootMessages.push(last);
			return ai.fauxAssistantMessage("noted");
		}
		if (state.hold) {
			const signal = options?.signal;
			await Promise.race([
				state.hold.promise,
				new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true })),
			]);
			if (signal?.aborted) return ai.fauxAssistantMessage("", { stopReason: "aborted" });
		}
		const inputs = messages.filter((message) => message.role === "user").map((message) => textOf(message.content).split("\n").slice(1).join("\n"));
		return ai.fauxAssistantMessage(`answer:${inputs.slice(-1)[0]}|seen:${inputs.join(",")}`);
	};
	faux.setResponses(Array.from({ length: 200 }, () => route));
	const modelRuntime = await pi.ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null });
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const resourceLoader = new pi.DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))],
	});
	await resourceLoader.reload();
	const sessionManager = pi.SessionManager.create(cwd, join(cwd, "sessions"));
	const { session } = await pi.createAgentSession({
		cwd, agentDir, settingsManager, resourceLoader, sessionManager, modelRuntime, model: faux.getModel(), tools: ["read", "agent"],
	});
	await session.bindExtensions({ mode: "print" });
	const tool = session.getToolDefinition("agent");
	let calls = 0;
	const call = async (args) => {
		const id = `test-${++calls}`;
		const signal = new AbortController().signal;
		const result = await tool.execute(id, args, signal, undefined, session.extensionRunner.createToolContext(id, signal));
		return textOf(result.content);
	};
	const close = async () => {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	};
	return { session, call, state, close };
}

const idOf = (text) => /\((\S+)\)/.exec(text)[1];

test("an owned Agent answers its first input, and wait returns the answer once", async () => {
	const root = await startRoot();
	const spawned = await root.call({ action: "spawn", name: "worker", message: "hello" });
	assert.match(spawned, /^Agent worker \(\S+\) started\.$/);
	assert.equal(await root.call({ action: "wait", target: "worker", timeout: 10 }), "answer:hello|seen:hello");
	assert.equal(await root.call({ action: "wait", timeout: 10 }), "No results.");
	assert.match(await root.call({ action: "wait", target: "worker", history: 1, timeout: 10 }), /status="completed" history="true">\nanswer:hello/);
	assert.match(await root.call({ action: "list" }), new RegExp(`^worker \\(${idOf(spawned)}\\)  idle  `));
	await root.close();
});

test("the owner is notified when an input ends while it is not waiting", async () => {
	const root = await startRoot();
	const id = idOf(await root.call({ action: "spawn", name: "worker", message: "hello" }));
	await new Promise((resolve) => setTimeout(resolve, 200));
	await root.session.waitForIdle();
	assert.ok(root.state.rootMessages.includes(`Agent worker (${id}) completed.`), root.state.rootMessages.join("\n"));
	assert.equal(await root.call({ action: "wait", target: id, timeout: 10 }), "answer:hello|seen:hello");
	await root.close();
});

test("inputs queue for a slot and are rejected beyond the input limit", async () => {
	const root = await startRoot({ maxConcurrent: 1, maxOutstanding: 2 });
	root.state.hold = gate();
	assert.match(await root.call({ action: "spawn", name: "a", message: "one" }), /started\.$/);
	assert.match(await root.call({ action: "spawn", name: "b", message: "two" }), /queued: all 1 slots are busy\.$/);
	await assert.rejects(root.call({ action: "send", target: "a", message: "three" }), /Input rejected: 2 inputs have not ended/);
	root.state.hold.open();
	const results = await root.call({ action: "wait", target: ["a", "b"], timeout: 10 });
	assert.match(results, /name="a" id="\S+" status="completed">\nanswer:one/);
	assert.match(results, /name="b" id="\S+" status="completed">\nanswer:two/);
	await root.close();
});

test("a steer input joins the current turn, and a followUp input gets its own turn", async () => {
	const root = await startRoot();
	root.state.hold = gate();
	await root.call({ action: "spawn", name: "worker", message: "one" });
	await new Promise((resolve) => setTimeout(resolve, 50));
	await root.call({ action: "send", target: "worker", message: "two", deliverAs: "steer" });
	await root.call({ action: "send", target: "worker", message: "three" });
	root.state.hold.open();
	await new Promise((resolve) => setTimeout(resolve, 50));
	const results = await root.call({ action: "wait", target: "worker", timeout: 10 });
	const answers = [...results.matchAll(/status="completed">\n(.*)/g)].map((match) => match[1]);
	assert.deepEqual(answers, ["answer:two|seen:one,two", "answer:two|seen:one,two", "answer:three|seen:one,two,three"]);
	await root.close();
});

test("abort ends the current turn and queued inputs, and the Agent stays usable", async () => {
	const root = await startRoot();
	root.state.hold = gate();
	await root.call({ action: "spawn", name: "worker", message: "one" });
	await root.call({ action: "send", target: "worker", message: "two" });
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.match(await root.call({ action: "abort", target: "worker" }), /^Agent worker \(\S+\) aborted\.$/);
	const results = await root.call({ action: "wait", target: "worker", timeout: 10 });
	assert.equal([...results.matchAll(/status="aborted"/g)].length, 2);
	assert.match(await root.call({ action: "abort", target: "worker" }), /has no turn or queued inputs\.$/);
	root.state.hold = undefined;
	await root.call({ action: "send", target: "worker", message: "three" });
	assert.match(await root.call({ action: "wait", target: "worker", timeout: 10 }), /^answer:three/);
	await root.close();
});

test("names are unique among siblings and unknown targets are rejected", async () => {
	const root = await startRoot();
	const id = idOf(await root.call({ action: "spawn", name: "worker", message: "hello" }));
	await assert.rejects(root.call({ action: "spawn", name: "worker", message: "again" }), new RegExp(`Name "worker" is already used by ${id}\\.`));
	await assert.rejects(root.call({ action: "send", target: "nobody", message: "hi" }), /No visible Agent matches "nobody"\. Use list to find Agents\./);
	await root.call({ action: "wait", timeout: 10 });
	await root.close();
});
