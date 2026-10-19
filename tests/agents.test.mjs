import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const agentDir = mkdtempSync(join(tmpdir(), "pi-agents-home-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
const { pi, ai, EXTENSION, PI_PACKAGE, textOf, gate, until, createSession } = await import("./pi.mjs");

const bodyOf = (text) => text.startsWith("<agent-message ") ? text.split("\n").slice(1, -1).join("\n") : text;

/**
 * Starts a root Session whose model answers from its last message: owned Agents answer
 * `answer:<first input>`, and the root acknowledges notifications with plain text. While
 * `state.hold` is set, owned Agents count their turns in `state.busy` and answer once it opens,
 * or end when their turn is aborted unless `state.stuck` is set.
 */
async function startRoot(limits = {}) {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ "pi-agents": { maxConcurrent: 3, maxOutstanding: 8, ...limits } }));
	const cwd = mkdtempSync(join(agentDir, "cwd-"));
	const state = { hold: undefined, stuck: false, busy: 0, rootMessages: [] };
	const route = async (context, options) => {
		const messages = context.messages;
		const first = textOf(messages.find((message) => message.role === "user")?.content ?? "");
		const last = textOf(messages.at(-1)?.content ?? "");
		if (!first.startsWith("<agent-message ")) {
			state.rootMessages.push(last);
			return ai.fauxAssistantMessage("noted");
		}
		if (state.hold) {
			const signal = options?.signal;
			state.busy += 1;
			await Promise.race([
				state.hold.promise,
				...state.stuck ? [] : [new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }))],
			]);
			if (signal?.aborted && !state.stuck) return ai.fauxAssistantMessage("", { stopReason: "aborted" });
		}
		const inputs = messages.filter((message) => message.role === "user").map((message) => bodyOf(textOf(message.content)));
		return ai.fauxAssistantMessage(`answer:${inputs.slice(-1)[0]}|seen:${inputs.join(",")}`);
	};
	const sessionManager = pi.SessionManager.create(cwd, join(cwd, "sessions"));
	const session = await createSession({ cwd, route, extensions: [EXTENSION, fileURLToPath(new URL("./fixtures/tree-extension.ts", import.meta.url))], sessionManager, tools: ["read", "agent"] });
	await session.bindExtensions({ mode: "print" });
	const tool = session.getToolDefinition("agent");
	let calls = 0;
	const callResult = async (args) => {
		const id = `test-${++calls}`;
		const signal = new AbortController().signal;
		const result = await tool.execute(id, args, signal, undefined, session.extensionRunner.createToolContext(id, signal));
		return result;
	};
	const call = async (args) => textOf((await callResult(args)).content);
	const close = async () => {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	};
	const waitBusy = (count) => until(() => state.busy >= count, `${count} held turns`);
	return { session, call, callResult, state, waitBusy, close };
}

const idOf = (text) => /\((\S+)\)/.exec(text)[1];

test("an owned Agent answers its first input, and wait returns the answer once", async () => {
	const root = await startRoot();
	const spawned = await root.call({ action: "spawn", name: "worker", message: "hello" });
	assert.match(spawned, /started\.$/);
	const waited = await root.callResult({ action: "wait", target: "worker", timeout: 10 });
	assert.equal(textOf(waited.content), "answer:hello|seen:hello");
	const id = waited.details.results[0].id;
	assert.ok(id.startsWith(idOf(spawned)));
	assert.deepEqual(waited.details, { results: [{ id, name: "worker", state: "completed", history: false, result: "answer:hello|seen:hello" }], pending: [] });
	const history = await root.callResult({ action: "wait", target: "worker", history: 1, timeout: 10 });
	assert.deepEqual(history.details.results, [{ ...waited.details.results[0], history: true }]);
	assert.deepEqual((await root.callResult({ action: "wait", target: "worker", timeout: 10 })).details, { results: [], pending: [] });
	const listed = await root.callResult({ action: "list", limit: 1 });
	assert.deepEqual(listed.details, { total: 1, agents: [{ id, name: "worker", ownerId: root.session.sessionManager.getSessionId(), state: "idle" }] });
	assert.deepEqual((await root.callResult({ action: "list", offset: 1 })).details, { total: 1, agents: [] });
	assert.equal((await root.callResult({ action: "list", query: "hello" })).details.total, 1);
	// A later input in the same Session file is found after its first search.
	await root.call({ action: "send", target: "worker", message: "zebra" });
	await root.call({ action: "wait", target: "worker", timeout: 10 });
	assert.match(await root.call({ action: "list", query: "zebra" }), /zebra/);
	assert.match(await root.call({ action: "list" }), /\n  \d{4}-\d\d-\d\d \d\d:\d\d  zebra$/);
	await root.close();
});

test("an owned Agent runs in its owner's execution environment, with cwd resolved there", async () => {
	const root = await startRoot();
	try {
		root.session.sessionManager.appendCustomEntry("env-state", { environment: "docker:box:/work", home: "/root" });
		await root.call({ action: "spawn", name: "worker", message: "hello", cwd: "src" });
		await root.call({ action: "wait", target: "worker", timeout: 10 });
		const dir = join(root.session.sessionManager.getSessionDir(), "subagents");
		const entries = readdirSync(dir).flatMap((file) => readFileSync(join(dir, file), "utf8").trim().split("\n").map((line) => JSON.parse(line)));
		const header = entries.find((entry) => entry.type === "session");
		assert.equal(header.cwd, root.session.sessionManager.getCwd());
		assert.deepEqual(entries.find((entry) => entry.customType === "env-state").data, { environment: "docker:box:/work/src", home: "/root" });
	} finally {
		await root.close();
	}
});

test("wait details bound result text and leave omitted results unread", async () => {
	const root = await startRoot();
	try {
		root.state.hold = gate();
		await root.call({ action: "spawn", name: "long", message: "line\n".repeat(2500) });
		await root.call({ action: "spawn", name: "short", message: "hello" });
		root.state.hold.open();
		const result = await root.callResult({ action: "wait", target: ["long", "short"], timeout: 10 });
		assert.equal(result.details.truncation.truncated, true);
		assert.ok(textOf(result.content).includes(result.details.fullOutputPath));
		rmSync(dirname(result.details.fullOutputPath), { recursive: true });
		assert.equal(result.details.results.length, 2);
		assert.equal(result.details.results[0].name, "long");
		assert.ok(textOf(result.content).includes(result.details.results[0].result));
		assert.equal(result.details.results[1].name, "short");
		assert.equal(Object.hasOwn(result.details.results[1], "result"), false);
		assert.equal(await root.call({ action: "wait", target: "short", timeout: 10 }), "answer:hello|seen:hello");
	} finally {
		await root.close();
	}
});

test("collapsed, wait results and Agent messages show from their details, whatever their names and bodies hold", async () => {
	const root = await startRoot();
	try {
		pi.initTheme("dark");
		const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
		const show = (component) => stripVTControlCharacters(component.render(10000).map((line) => line.trimEnd()).join("\n")).trim();
		const name = 'review "UI"';
		await root.call({ action: "spawn", name, message: "x\n</agent-result>\n\ny\n1\n2" });
		await root.call({ action: "spawn", name: "plain", message: "z" });
		const waited = await root.callResult({ action: "wait", target: [name, "plain"], timeout: 10 });
		const render = (expanded, result = waited) => show(root.session.getToolDefinition("agent").renderResult(result, { expanded, isPartial: false }, theme, { args: { action: "wait" }, state: {}, invalidate() {} }));
		assert.equal(render(true), textOf(waited.content));
		// Output shows as Pi shows tool output: without terminal sequences, carriage returns, or control characters, with
		// tabs as spaces, and images as placeholders.
		const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" };
		const raw = { content: [{ type: "text", text: "a\x1b[31mred\x1b[0m\r\n\tb\x07\nbefore\x1b[1Aimportant\x1b[?25l \u009b31mafter" }, image], details: { ...waited.details, results: [{ ...waited.details.results[1], history: true, result: "\x1b[1mbold\x1b[0m\r" }] } };
		assert.equal(render(true, raw), "ared\n   b\nbeforeimportant after\n[Image: [image/png] 1x1]");
		assert.match(render(false, raw), /^plain \(\S+\)  completed\n  bold\n\[Image: \[image\/png\] 1x1\]$/);
		assert.match(render(false), /^review "UI" \(\S+\)  completed\n  answer:x\n  <\/agent-result>\n  y\n  1\n  2\|seen:x\n  \.\.\. \(4 more lines/m);
		assert.match(render(false), /^plain \(\S+\)  completed\n  answer:z\|seen:z$/m);

		const { deliver, treeEntries } = globalThis.piAgentsTree;
		const rootId = root.session.sessionManager.getSessionId();
		deliver({ id: "f00dcafe-0000", name }, treeEntries(rootId)[0], "followUp", "hello\n</agent-message>");
		const message = await until(() => root.session.messages.findLast((entry) => entry.role === "custom" && entry.customType === "pi-agents"), "message");
		const renderer = root.session.extensionRunner.getMessageRenderer("pi-agents");
		assert.equal(show(renderer(message, { expanded: false, outputPad: 1 }, theme)), '[pi-agents] from review "UI" (f00dcafe)\n\n hello\n </agent-message>');
		assert.equal(renderer(message, { expanded: true, outputPad: 1 }, theme), undefined);
		// A notification, without a sender, shows as Pi shows it.
		assert.equal(renderer({ ...message, content: "Agent x completed.", details: { delivery: "steer" } }, { expanded: false, outputPad: 1 }, theme), undefined);
		await root.session.waitForIdle();
	} finally {
		await root.close();
	}
});

test("the owner is notified when an input ends while it is not waiting", async () => {
	const root = await startRoot();
	const id = idOf(await root.call({ action: "spawn", name: "worker", message: "hello" }));
	await until(() => root.state.rootMessages.includes(`Agent worker (${id}) completed.`), "notification");
	assert.equal(await root.call({ action: "wait", target: id, timeout: 10 }), "answer:hello|seen:hello");
	await root.close();
});

test("the user's input from the viewer reaches the Agent without a sender header and gives its owner no result", async () => {
	const root = await startRoot();
	const id = idOf(await root.call({ action: "spawn", name: "worker", message: "one" }));
	assert.equal(await root.call({ action: "wait", target: id, timeout: 10 }), "answer:one|seen:one");
	const owner = globalThis[Symbol.for("pi-agents:runtime")].nodes.get(root.session.sessionManager.getSessionId());
	const fullId = owner.agents.ownedTarget(id).record.id;
	owner.agents.prompt(fullId, "two", "steer");
	await until(() => owner.agents.conversation(fullId).messages.filter((message) => message.role === "assistant").length === 2, "second answer");
	const messages = owner.agents.conversation(fullId).messages;
	assert.ok(messages.some((message) => message.role === "custom" && message.content === "two" && message.details.user), JSON.stringify(messages));
	assert.equal(messages.at(-1).role, "assistant");
	await root.session.waitForIdle();
	assert.ok(!root.state.rootMessages.some((text) => text.startsWith("Agent worker")), root.state.rootMessages.join("\n"));
	assert.equal(await root.call({ action: "wait", target: id, timeout: 10 }), "No results.");

	// The viewer shows the conversation as Pi's chat does: messages through their renderers, and `!` commands.
	owner.agents.conversation(fullId).session.recordBashResult("echo hi", { output: "hi\n", exitCode: 0, cancelled: false, truncated: false });
	pi.initTheme();
	const { theme } = await import(join(PI_PACKAGE, "dist/modes/interactive/theme/theme.js"));
	const noop = () => {};
	let lines;
	const custom = async (factory) => {
		if (lines === undefined) return (lines = "", fullId);
		const viewer = factory({ terminal: { rows: 60, columns: 100 }, requestRender: noop }, theme, { matches: () => false, getKeys: () => [] }, noop);
		lines = viewer.render(100).map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");
		assert.match(lines, /• worker .*back\n/);
		// A reply still streaming renders as streaming, as Pi tells Markdown transformers.
		viewer.streaming = { role: "assistant", content: [{ type: "text", text: "partial" }], timestamp: 0 };
		viewer.render(100);
		assert.equal(viewer.live.component.isStreaming, true);
		viewer.dispose();
	};
	const runner = root.session.extensionRunner;
	await runner.getCommand("tasks").handler("", { ...runner.createCommandContext(), ui: { notify: noop, custom } });
	assert.match(lines, /\[pi-agents\] from \S+\n\n one\n/);
	assert.match(lines, /\n two\n/);
	assert.match(lines, /\$ echo hi\n[\s\S]*\bhi\n/);
	await root.close();
});

test("inputs queue for a slot and are rejected beyond the input limit", async () => {
	const root = await startRoot({ maxConcurrent: 1, maxOutstanding: 2 });
	root.state.hold = gate();
	assert.match(await root.call({ action: "spawn", name: "a", message: "one" }), /started\.$/);
	assert.match(await root.call({ action: "spawn", name: "b", message: "two" }), /queued: all 1 slots are busy\.$/);
	const listed = await root.call({ action: "list" });
	assert.match(listed, /^a \(\S+\)\s+running/m);
	assert.match(listed, /^b \(\S+\)\s+queued/m);
	await assert.rejects(root.call({ action: "send", target: "a", message: "three" }), /Input rejected: 2 inputs have not ended/);
	root.state.hold.open();
	const { results } = (await root.callResult({ action: "wait", target: ["a", "b"], timeout: 10 })).details;
	assert.deepEqual(results.map((result) => [result.name, result.state, result.result]).sort(), [["a", "completed", "answer:one|seen:one"], ["b", "completed", "answer:two|seen:two"]]);
	await root.close();
});

test("a steer input joins the current turn, and a followUp input gets its own turn", async () => {
	const root = await startRoot();
	root.state.hold = gate();
	await root.call({ action: "spawn", name: "worker", message: "one" });
	await root.waitBusy(1);
	await root.call({ action: "send", target: "worker", message: "two", deliverAs: "steer" });
	await root.call({ action: "send", target: "worker", message: "three" });
	root.state.hold.open();
	const { results } = (await root.callResult({ action: "wait", target: "worker", timeout: 10 })).details;
	assert.deepEqual(results.map((result) => result.result), ["answer:two|seen:one,two", "answer:two|seen:one,two", "answer:three|seen:one,two,three"]);
	await root.close();
});

test("a steer queued for the waiting Agent ends wait early, and a write does not", async () => {
	const root = await startRoot();
	root.state.hold = gate();
	await root.call({ action: "spawn", name: "worker", message: "one" });
	await root.waitBusy(1);
	const agent = root.session.agent;
	agent.steer({ role: "custom", customType: "pi-agents", content: "note", display: true, details: { delivery: "write" }, timestamp: Date.now() });
	let settled = false;
	const waiting = root.callResult({ action: "wait", target: "worker", timeout: 10 }).finally(() => { settled = true; });
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(settled, false);
	agent.steer({ role: "user", content: [{ type: "text", text: "look" }], timestamp: Date.now() });
	const result = await waiting;
	assert.match(textOf(result.content), /^Still pending: worker/);
	assert.equal(result.details.interrupted, true);
	agent.clearAllQueues();
	root.state.hold.open();
	assert.match(await root.call({ action: "wait", target: "worker", timeout: 10 }), /^answer:one/);
	await root.close();
});

test("abort ends the current turn and queued inputs, and the Agent stays usable", async () => {
	const root = await startRoot();
	root.state.hold = gate();
	await root.call({ action: "spawn", name: "worker", message: "one" });
	await root.call({ action: "send", target: "worker", message: "two" });
	await root.waitBusy(1);
	assert.match(await root.call({ action: "abort", target: "worker" }), /aborted\.$/);
	const { results } = (await root.callResult({ action: "wait", target: "worker", timeout: 10 })).details;
	assert.deepEqual(results.map((result) => result.state), ["aborted", "aborted"]);
	assert.ok(!root.state.rootMessages.some((text) => text.endsWith("aborted.")), root.state.rootMessages.join("\n"));
	root.state.hold = undefined;
	await root.call({ action: "send", target: "worker", message: "three" });
	assert.match(await root.call({ action: "wait", target: "worker", timeout: 10 }), /^answer:three/);
	await root.close();
});

test("a turn that does not stop within the abort timeout is abandoned, and the tree becomes idle", async () => {
	const root = await startRoot();
	root.state.hold = gate();
	root.state.stuck = true;
	await root.call({ action: "spawn", name: "worker", message: "one" });
	await root.waitBusy(1);
	await assert.rejects(root.call({ action: "abort", target: "worker" }), /did not stop within the timeout/);
	assert.match(await root.call({ action: "wait", target: "worker", timeout: 10 }), /aborted/);
	assert.equal(globalThis.piAgentsTree.treeIdle(root.session.sessionManager.getSessionId()), true);
	root.state.hold.open();
	await root.close();
});


test("an Agent message queued in a busy root is listed until taken in and survives clearing the queue; after the user stops the turn, Agent messages start no turn until the user's next input", async () => {
	const cwd = mkdtempSync(join(agentDir, "cwd-"));
	let hold = gate();
	let turns = 0;
	const route = async (context, options) => {
		turns += 1;
		if (textOf(context.messages.at(-1).content) !== "hold") return ai.fauxAssistantMessage("ok");
		await Promise.race([hold.promise, new Promise((resolve) => options?.signal?.addEventListener("abort", resolve, { once: true }))]);
		return ai.fauxAssistantMessage("", { stopReason: options?.signal?.aborted ? "aborted" : "stop" });
	};
	const sessionManager = pi.SessionManager.create(cwd, join(cwd, "sessions"));
	const session = await createSession({ cwd, route, extensions: [EXTENSION, fileURLToPath(new URL("./fixtures/tree-extension.ts", import.meta.url))], sessionManager, tools: ["agent"] });
	const widgets = new Map();
	const noop = () => {};
	const uiContext = { notify: noop, setStatus: noop, setWidget: (key, content) => widgets.set(key, content), setFooter: noop, setTitle: noop, setWorkingMessage: noop, select: noop, confirm: noop, input: noop, editor: noop, custom: noop, onTerminalInput: () => noop };
	await session.bindExtensions({ mode: "interactive", uiContext });
	const lines = () => widgets.get("pi-agents-queue")({ requestRender: noop }, { fg: (_color, text) => text }).render(80).map((line) => line.trim());
	const node = globalThis.piAgentsTree.nodes.get(sessionManager.getSessionId());
	const message = '<agent-message name="peer" id="ab" note="Reply with send">\nhello\nthere\n</agent-message>';

	const last = () => session.messages.at(-1);

	// Clearing the queue, as Pi's dequeue does, leaves it queued; stopping the turn adds it without a turn.
	let turn = session.prompt("hold");
	await until(() => session.isStreaming, "turn started");
	node.receive(message, "followUp", undefined, { id: "ab", name: "peer" });
	assert.deepEqual(lines(), ["Follow-up: [peer] hello there"]);
	session.clearQueue();
	assert.deepEqual(lines(), ["Follow-up: [peer] hello there"]);
	// One that arrives while the turn stops is added as well.
	const stopping = session.abort();
	node.receive(message, "steer", undefined, { id: "ab", name: "peer" });
	await stopping;
	await turn;
	assert.equal(session.messages.filter((entry) => entry.content === message).length, 2);
	assert.deepEqual(lines(), []);
	assert.equal(last().role, "custom");
	assert.equal(last().content, message);
	assert.equal(turns, 1);

	// One that arrives later is added without a turn too.
	node.receive(message, "steer", undefined, { id: "ab", name: "peer" });
	await session.waitForIdle();
	assert.equal(last().content, message);
	assert.equal(turns, 1);

	// After the user's input, a turn takes it in.
	hold = gate();
	turn = session.prompt("hold");
	await until(() => session.isStreaming, "second turn started");
	node.receive(message, "followUp", undefined, { id: "ab", name: "peer" });
	hold.open();
	await turn;
	await session.waitForIdle();
	assert.deepEqual(lines(), []);
	assert.equal(turns, 3);
	assert.equal(session.messages.at(-2).content, message);
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
});
