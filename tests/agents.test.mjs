import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const agentDir = mkdtempSync(join(tmpdir(), "pi-agents-home-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { pi, ai, EXTENSION, textOf, gate, until, createSession } = await import("./pi.mjs");

const bodyOf = (text) => text.startsWith("<agent-message ") ? text.split("\n").slice(1, -1).join("\n") : text;

/**
 * Starts a root Session whose model answers from its last message: owned Agents answer
 * `answer:<first input>`, and the root acknowledges notifications with plain text. While
 * `state.hold` is set, owned Agents count their turns in `state.busy` and answer once it opens,
 * or end when their turn is aborted unless `state.stuck` is set.
 */
async function startRoot(limits = {}) {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ "pi-agents": { maxConcurrent: 3, maxOutstanding: 8, ...limits } }));
	const cwd = mkdtempSync(join(tmpdir(), "pi-agents-cwd-"));
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
	assert.match(spawned, /^Agent worker \([0-9a-f]{8}\) started\.$/);
	const waited = await root.callResult({ action: "wait", target: "worker", timeout: 10 });
	assert.equal(textOf(waited.content), "answer:hello|seen:hello");
	const id = waited.details.results[0].id;
	assert.ok(id.startsWith(idOf(spawned)));
	assert.deepEqual(waited.details, { results: [{ id, name: "worker", state: "completed", history: false, result: "answer:hello|seen:hello" }], pending: [] });
	const history = await root.callResult({ action: "wait", target: "worker", history: 1, timeout: 10 });
	assert.match(textOf(history.content), /status="completed" history="true">\nanswer:hello/);
	assert.deepEqual(history.details.results, [{ ...waited.details.results[0], history: true }]);
	assert.deepEqual((await root.callResult({ action: "wait", target: "worker", timeout: 10 })).details, { results: [], pending: [] });
	const listed = await root.callResult({ action: "list", limit: 1 });
	assert.deepEqual(listed.details, { total: 1, agents: [{ id, name: "worker", ownerId: root.session.sessionManager.getSessionId(), state: "idle" }] });
	assert.deepEqual((await root.callResult({ action: "list", offset: 1 })).details, { total: 1, agents: [] });
	assert.match(await root.call({ action: "list" }), new RegExp(`^worker \\(${idOf(spawned)}\\)  idle  `));
	assert.equal((await root.callResult({ action: "list", query: "hello" })).details.total, 1);
	// A later input in the same Session file is found after its first search.
	await root.call({ action: "send", target: "worker", message: "zebra" });
	await root.call({ action: "wait", target: "worker", timeout: 10 });
	assert.match(await root.call({ action: "list", query: "zebra" }), /zebra/);
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
	const results = await root.call({ action: "wait", target: ["a", "b"], timeout: 10 });
	assert.match(results, /name="a" id="\S+" status="completed">\nanswer:one/);
	assert.match(results, /name="b" id="\S+" status="completed">\nanswer:two/);
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
	await root.waitBusy(1);
	assert.match(await root.call({ action: "abort", target: "worker" }), /^Agent worker \(\S+\) aborted\.$/);
	const results = await root.call({ action: "wait", target: "worker", timeout: 10 });
	assert.equal([...results.matchAll(/status="aborted"/g)].length, 2);
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
	await assert.rejects(root.call({ action: "abort", target: "worker" }), /^Error: Agent worker \(\S+\) did not stop within the timeout and may still be running\.$/);
	assert.match(await root.call({ action: "wait", target: "worker", timeout: 10 }), /aborted/);
	assert.equal(globalThis.piAgentsTree.treeIdle(root.session.sessionManager.getSessionId()), true);
	root.state.hold.open();
	await root.close();
});

