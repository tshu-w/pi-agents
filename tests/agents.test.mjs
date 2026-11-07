import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const agentDir = mkdtempSync(join(tmpdir(), "pi-agents-home-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
const { pi, ai, EXTENSION, PI_PACKAGE, textOf, gate, until, createSession, notification, notificationsOf } = await import("./pi.mjs");

const bodyOf = (text) => text.startsWith("<agent-message ") ? text.split("\n").slice(1, -1).join("\n") : text;

/**
 * Starts a root Session whose model answers from its last message: owned Agents answer
 * `answer:<first input>`, and the root acknowledges notifications with plain text. While
 * `state.hold` is set, owned Agents count their turns in `state.busy` and answer once it opens,
 * or end when their turn is aborted unless `state.stuck` is set. `sessionFile` opens a Session that exists.
 */
async function startRoot(limits = {}, sessionFile) {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ "pi-agents": { maxConcurrent: 3, maxOutstanding: 8, ...limits } }));
	const cwd = sessionFile ? dirname(dirname(sessionFile)) : mkdtempSync(join(agentDir, "cwd-"));
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
	const sessionManager = sessionFile ? pi.SessionManager.open(sessionFile, dirname(sessionFile), cwd) : pi.SessionManager.create(cwd, join(cwd, "sessions"));
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

/** The results the root's notifications carried once there are `count`, as [name, state, result]. */
async function resultsOf(root, count) {
	const results = () => notificationsOf(root.session).flatMap((message) => message.details.results.map(({ name, status, body }) => [name, status, body]));
	await until(() => results().length >= count, `${count} results`);
	return results();
}

test("an owned Agent answers its first input, and its owner waits for it and is notified of the answer", async () => {
	const root = await startRoot();
	const spawned = await root.call({ action: "spawn", name: "worker", message: "hello" });
	assert.match(spawned, /started\.$/);
	const waited = await root.callResult({ action: "wait", target: "worker", timeout: 10 });
	assert.deepEqual([textOf(waited.content), waited.details], ["Wait completed.", { pending: [] }]);
	assert.deepEqual(await resultsOf(root, 1), [["worker", "completed", "answer:hello|seen:hello"]]);
	assert.equal(textOf((await notification(root.session, /^<agent-result /)).content).split('"')[3], idOf(spawned));
	assert.equal(await root.call({ action: "wait", target: "worker", timeout: 10 }), "Nothing to wait for.");
	const listed = await root.callResult({ action: "list", limit: 1 });
	const id = listed.details.agents[0].id;
	assert.ok(id.startsWith(idOf(spawned)));
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

const lockFiles = () => readdirSync(join(process.env.PI_AGENTS_STATE_DIR, "runtime/locks")).sort();

/** The hashes of the lock files of the root's only owned Agent. */
async function agentLockHashes(root) {
	const id = (await root.callResult({ action: "list" })).details.agents[0].id;
	const dir = join(root.session.sessionManager.getSessionDir(), "subagents");
	const file = readdirSync(dir).find((name) => name.endsWith(`_${id}.jsonl`));
	return [`path:${realpathSync(join(dir, file))}`, `id:${id}`].map((key) => createHash("sha256").update(key).digest("hex"));
}

test("an owned Agent holds its Session's locks while it is online and releases them when its owner closes", async () => {
	const root = await startRoot();
	const before = lockFiles();
	await root.call({ action: "spawn", name: "worker", message: "hello" });
	await root.call({ action: "wait", target: "worker", timeout: 10 });
	const hashes = await agentLockHashes(root);
	assert.deepEqual(lockFiles().filter((name) => !before.includes(name)).map((name) => name.slice(0, 64)).sort(), hashes.sort());
	await root.close();
	assert.deepEqual(lockFiles().filter((name) => hashes.includes(name.slice(0, 64))), []);
});

test("an owned Agent whose Session fails to load after its owner closed releases its Session's locks", async () => {
	const root = await startRoot({ extensions: [fileURLToPath(new URL("./fixtures/slow-extension.mjs", import.meta.url))] });
	await root.call({ action: "spawn", name: "worker", message: "hello" });
	const hashes = await agentLockHashes(root);
	await root.close();
	globalThis.piAgentsSlowLoad.open();
	await until(() => !lockFiles().some((name) => hashes.includes(name.slice(0, 64))), "released locks", 2000);
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

test("a notification bounds its result text and keeps its closing tag", async () => {
	const root = await startRoot();
	try {
		await root.call({ action: "spawn", name: "long", message: "line\n".repeat(pi.DEFAULT_MAX_LINES + 1) });
		await root.call({ action: "wait", target: "long", timeout: 10 });
		const message = await notification(root.session, /^<agent-result name="long" /);
		const text = textOf(message.content);
		const [, kept, path] = /^([\s\S]*)\n\n\[Showing lines [^\]]* Full output: (\S+)\]$/.exec(text);
		const [result] = message.details.results;
		assert.equal(result.fullOutputPath, path);
		assert.equal(result.truncation.truncatedBy, "lines");
		const full = readFileSync(path, "utf8");
		assert.ok(kept.startsWith('<agent-result name="long" ') && kept.endsWith("\n</agent-result>"));
		assert.ok(full.startsWith("answer:line\n") && full.length > kept.length && kept.includes(full.slice(0, 1000)));
		rmSync(dirname(path), { recursive: true });
	} finally {
		await root.close();
	}
});

test("collapsed, notifications show their result and Agent messages their sender, whatever their bodies hold", async () => {
	const root = await startRoot();
	try {
		pi.initTheme("dark");
		const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
		const show = (component) => stripVTControlCharacters(component.render(10000).map((line) => line.trimEnd()).join("\n")).trim();
		// Output shows as Pi shows tool output: without terminal sequences, carriage returns, or control characters, with
		// tabs as spaces, and images as placeholders.
		const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" };
		const raw = { content: [{ type: "text", text: "a\x1b[31mred\x1b[0m\r\n\tb\x07\nbefore\x1b[1Aimportant\x1b[?25l \u009b31mafter" }, image], details: {} };
		const render = (expanded) => show(root.session.getToolDefinition("agent").renderResult(raw, { expanded, isPartial: false }, theme, { args: { action: "wait" }, state: {}, invalidate() {} }));
		assert.equal(render(true), "ared\n   b\nbeforeimportant after\n[Image: [image/png] 1x1]");
		assert.equal(render(false), render(true));

		const renderer = root.session.extensionRunner.getMessageRenderer("pi-agents");
		await root.call({ action: "spawn", name: "plain", message: "x\n</agent-result>\n\ny\n1\n2" });
		await root.call({ action: "wait", target: "plain", timeout: 10 });
		const notified = await notification(root.session, /^<agent-result name="plain" /);
		assert.match(show(renderer(notified, { expanded: false, outputPad: 1 }, theme)), /^\[pi-agents\]\n\n plain \(\S+\)  completed\n   answer:x\n   <\/agent-result>\n/);

		const { deliver, treeEntries } = globalThis.piAgentsTree;
		const rootId = root.session.sessionManager.getSessionId();
		const name = 'review "UI"';
		deliver({ id: "f00dcafe-0000", name }, treeEntries(rootId)[0], "followUp", "hello\n</agent-message>");
		const message = await until(() => root.session.messages.findLast((entry) => entry.role === "custom" && entry.customType === "pi-agents" && entry.details.sender), "message");
		assert.equal(show(renderer(message, { expanded: false, outputPad: 1 }, theme)), '[pi-agents] from review "UI" (f00dcafe)\n\n hello\n </agent-message>');
		assert.equal(renderer(message, { expanded: true, outputPad: 1 }, theme), undefined);
		await root.session.waitForIdle();
	} finally {
		await root.close();
	}
});

test("the owner is notified when an input ends while it is not waiting", async () => {
	const root = await startRoot();
	const id = idOf(await root.call({ action: "spawn", name: "worker", message: "hello" }));
	await until(() => root.state.rootMessages.includes(`<agent-result name="worker" id="${id}" status="completed">\nanswer:hello|seen:hello\n</agent-result>`), "notification");
	assert.equal(await root.call({ action: "wait", target: id, timeout: 10 }), "Nothing to wait for.");
	await root.close();
});

test("inputs that end because their owner went offline are reported in one write when it is loaded again", async () => {
	const root = await startRoot();
	const mailboxFile = join(process.env.PI_AGENTS_STATE_DIR, "mailboxes", `${root.session.sessionManager.getSessionId()}.json`);
	// A model reply makes Pi write the Session file.
	await root.session.prompt("hello");
	await root.call({ action: "spawn", name: "done", message: "one" });
	await root.call({ action: "wait", target: "done", timeout: 10 });
	assert.equal(existsSync(mailboxFile), false);
	root.state.hold = gate();
	const ids = [];
	for (const name of ["first", "second"]) ids.push(idOf(await root.call({ action: "spawn", name, message: name })));
	await root.waitBusy(2);
	assert.equal(JSON.parse(readFileSync(mailboxFile, "utf8")).outbox.length, 2);
	const file = root.session.sessionManager.getSessionFile();
	await root.close();

	const reopened = await startRoot({}, file);
	const offline = "Interrupted because you went offline.";
	const reported = notificationsOf(reopened.session).filter((message) => message.details.results.some(({ body }) => body === offline));
	assert.equal(reported.length, 1);
	assert.equal(textOf(reported[0].content), ["first", "second"].map((name, index) => `<agent-result name="${name}" id="${ids[index]}" status="aborted">\n${offline}\n</agent-result>`).join("\n\n"));
	assert.equal(reported[0].details.delivery, "write");
	assert.equal(reopened.session.isStreaming, false);
	assert.deepEqual(reopened.state.rootMessages, []);
	assert.equal(existsSync(mailboxFile), false);
	await reopened.close();
});

const linesOf = (file) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const agentEntries = (file) => linesOf(file).filter((entry) => entry.customType === "pi-agents-agent" || entry.customType === "pi-agents-input");

/** A root whose owned Agent "worker" answered two inputs, closed; returns its Session file and the Agent's ID. */
async function answeredTwice() {
	const root = await startRoot();
	await root.session.prompt("hello");
	await root.call({ action: "spawn", name: "worker", message: "one" });
	await root.call({ action: "wait", target: "worker", timeout: 10 });
	await root.call({ action: "send", target: "worker", message: "two" });
	await root.call({ action: "wait", target: "worker", timeout: 10 });
	const id = (await root.callResult({ action: "list" })).details.agents[0].id;
	const file = root.session.sessionManager.getSessionFile();
	await root.close();
	return { file, id };
}

/** Reopens `file`, sends "three" to its Agent "worker", and returns the inputs restore and the send appended. */
async function reopenAndSend(file) {
	const before = agentEntries(file).length;
	const root = await startRoot({}, file);
	await root.call({ action: "send", target: "worker", message: "three" });
	await root.call({ action: "wait", target: "worker", timeout: 10 });
	await root.close();
	return agentEntries(file).slice(before).map(({ data }) => [data.id.split(":")[1], data.state, data.result]);
}

test("the owner's Session records an owned Agent once and each input change as one entry, and restores from them", async () => {
	const { file, id } = await answeredTwice();
	const entries = agentEntries(file);
	assert.deepEqual(entries.filter((entry) => entry.customType === "pi-agents-agent").map(({ data }) => Object.keys(data).sort()), [["createdAt", "cwd", "id", "name", "sessionFile"]]);
	const inputs = entries.filter((entry) => entry.customType === "pi-agents-input").map(({ data }) => [data.agentId, data.id.split(":")[1], data.state, data.result]);
	assert.deepEqual(inputs, [
		[id, "1", "queued", undefined], [id, "1", "running", undefined], [id, "1", "completed", "answer:one|seen:one"],
		[id, "2", "queued", undefined], [id, "2", "running", undefined], [id, "2", "completed", "answer:two|seen:one,two"],
	]);
	// Restored inputs are not written again, and the next input follows them.
	assert.deepEqual(await reopenAndSend(file), [["3", "queued", undefined], ["3", "running", undefined], ["3", "completed", "answer:three|seen:one,two,three"]]);
});

test("a full Agent record from an older Session is the baseline for the input entries after it", async () => {
	const { file, id } = await answeredTwice();
	// As older versions wrote: the record with its inputs, here before the second input ran, then a later change to it.
	const lines = linesOf(file).map((entry) => {
		if (entry.customType === "pi-agents-agent") {
			return { ...entry, data: { ...entry.data, inputs: [{ id: `${id}:1`, state: "completed", result: "answer:one|seen:one" }, { id: `${id}:2`, state: "queued" }] } };
		}
		if (entry.customType === "pi-agents-input" && !(entry.data.id === `${id}:2` && entry.data.state === "running")) return { ...entry, customType: "dropped" };
		return entry;
	});
	writeFileSync(file, lines.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	assert.deepEqual(await reopenAndSend(file), [
		["2", "aborted", "The process exited before this input ended."],
		["3", "queued", undefined], ["3", "running", undefined], ["3", "completed", "answer:three|seen:one,two,three"],
	]);
});

test("the user's input from the viewer reaches the Agent without a sender header and gives its owner no result", async () => {
	const root = await startRoot();
	const id = idOf(await root.call({ action: "spawn", name: "worker", message: "one" }));
	await root.call({ action: "wait", target: id, timeout: 10 });
	assert.deepEqual(await resultsOf(root, 1), [["worker", "completed", "answer:one|seen:one"]]);
	const owner = globalThis[Symbol.for("pi-agents:runtime")].nodes.get(root.session.sessionManager.getSessionId());
	const fullId = owner.agents.ownedTarget(id).record.id;
	owner.agents.prompt(fullId, "two", "steer");
	await until(() => owner.agents.conversation(fullId).messages.filter((message) => message.role === "assistant").length === 2, "second answer");
	const messages = owner.agents.conversation(fullId).messages;
	assert.ok(messages.some((message) => message.role === "custom" && message.content === "two" && message.details.user), JSON.stringify(messages));
	assert.equal(messages.at(-1).role, "assistant");
	await root.session.waitForIdle();
	assert.equal(notificationsOf(root.session).length, 1);

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
	await root.call({ action: "wait", target: ["a", "b"], timeout: 10 });
	assert.deepEqual((await resultsOf(root, 2)).sort(), [["a", "completed", "answer:one|seen:one"], ["b", "completed", "answer:two|seen:two"]]);
	await root.close();
});

test("a steer input joins the current turn and shares its notification, and a followUp input gets its own turn", async () => {
	const root = await startRoot();
	root.state.hold = gate();
	await root.call({ action: "spawn", name: "worker", message: "one" });
	await root.waitBusy(1);
	await root.call({ action: "send", target: "worker", message: "two", deliverAs: "steer" });
	await root.call({ action: "send", target: "worker", message: "three" });
	root.state.hold.open();
	await root.call({ action: "wait", target: "worker", timeout: 10 });
	await resultsOf(root, 2);
	await root.session.waitForIdle();
	assert.deepEqual((await resultsOf(root, 2)).map(([, , result]) => result), ["answer:two|seen:one,two", "answer:three|seen:one,two,three"]);
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
	assert.match(textOf(result.content), /^Wait interrupted by a new message\. Still pending: worker \(\S+\)$/);
	assert.equal(result.details.interrupted, true);
	agent.clearAllQueues();
	root.state.hold.open();
	assert.equal(await root.call({ action: "wait", target: "worker", timeout: 10 }), "Wait completed.");
	assert.match((await resultsOf(root, 1))[0][2], /^answer:one/);
	await root.close();
});

test("abort ends the current turn and queued inputs, and the Agent stays usable", async () => {
	const root = await startRoot();
	root.state.hold = gate();
	await root.call({ action: "spawn", name: "worker", message: "one" });
	await root.call({ action: "send", target: "worker", message: "two" });
	await root.waitBusy(1);
	assert.match(await root.call({ action: "abort", target: "worker" }), /aborted\.$/);
	// The owner aborted the inputs, so it is not notified of them.
	assert.equal(await root.call({ action: "wait", target: "worker", timeout: 10 }), "Nothing to wait for.");
	root.state.hold = undefined;
	await root.call({ action: "send", target: "worker", message: "three" });
	await root.call({ action: "wait", target: "worker", timeout: 10 });
	assert.deepEqual((await resultsOf(root, 1)).map(([, state, result]) => [state, result.split("|")[0]]), [["completed", "answer:three"]]);
	await root.close();
});

test("the user's abort of a running turn and a queued input ends the queued input at once and sends one notification", async () => {
	const root = await startRoot({ maxConcurrent: 2, maxOutstanding: 2 });
	root.state.hold = gate();
	root.state.stuck = true;
	const id = idOf(await root.call({ action: "spawn", name: "worker", message: "one" }));
	await root.call({ action: "send", target: "worker", message: "two" });
	await root.waitBusy(1);
	const owner = globalThis[Symbol.for("pi-agents:runtime")].nodes.get(root.session.sessionManager.getSessionId());
	const worker = owner.agents.ownedTarget(id).record;
	const aborting = owner.agents.abortAgent(worker.id);
	// While the turn stops, the withdrawn input has ended and no longer counts against the input limit.
	await root.call({ action: "spawn", name: "other", message: "three" });
	assert.deepEqual(worker.inputs.map((input) => input.state), ["running", "aborted"]);
	root.state.stuck = false;
	root.state.hold.open();
	assert.equal(await aborting, true);
	await root.call({ action: "wait", target: "other", timeout: 10 });
	await resultsOf(root, 2);
	await root.session.waitForIdle();
	assert.deepEqual((await resultsOf(root, 2)).filter(([name]) => name === "worker"), [["worker", "aborted", ""]]);
	await root.close();
});

test("aborting from the viewer puts the user's inputs the Agent did not receive back in the editor, as Pi does", async () => {
	const root = await startRoot();
	root.state.hold = gate();
	const id = idOf(await root.call({ action: "spawn", name: "worker", message: "one" }));
	await root.waitBusy(1);
	const owner = globalThis[Symbol.for("pi-agents:runtime")].nodes.get(root.session.sessionManager.getSessionId());
	const fullId = owner.agents.ownedTarget(id).record.id;
	pi.initTheme();
	const { theme } = await import(join(PI_PACKAGE, "dist/modes/interactive/theme/theme.js"));
	const noop = () => {};
	let text;
	let again;
	let selected = false;
	const custom = async (factory) => {
		if (!selected) return (selected = true, fullId);
		const viewer = factory({ terminal: { rows: 60, columns: 100 }, requestRender: noop }, theme, { matches: () => false, getKeys: () => [] }, noop);
		viewer.send("later", "followUp");
		viewer.send("now", "steer");
		// Another sender's input is not the user's to restore.
		await root.call({ action: "send", target: "worker", message: "other" });
		viewer.editor.setText("draft");
		viewer.editor.onEscape();
		// An Esc while the abort runs restores nothing again.
		viewer.editor.onEscape();
		text = await until(() => viewer.editor.getText() !== "draft" && viewer.editor.getText(), "restored text");
		// A received steer accounts for one of two inputs with its text; the queued follow-up is restored.
		await until(() => owner.agents.counts(fullId).state === "idle", "first abort");
		const busy = root.state.busy;
		viewer.send("again", "steer");
		await until(() => root.state.busy > busy, "second turn");
		viewer.send("same", "followUp");
		viewer.send("same", "steer");
		const held = root.state.hold;
		root.state.hold = gate();
		held.open();
		await until(() => owner.agents.conversation(fullId).messages.some((message) => message.content === "same"), "steer received");
		viewer.editor.setText("draft");
		viewer.editor.onEscape();
		again = await until(() => viewer.editor.getText() !== "draft" && viewer.editor.getText(), "restored follow-up");
		// A follow-up the Agent receives after its history shrinks, as on compaction, is no longer queued.
		await until(() => owner.agents.counts(fullId).state === "idle", "aborted");
		viewer.send("third", "steer");
		await until(() => root.state.busy > busy + 2, "third turn");
		viewer.send("fourth", "followUp");
		const session = owner.agents.conversation(fullId).session;
		session.agent.state.messages = session.messages.slice(0, 2);
		const third = root.state.hold;
		root.state.hold = gate();
		third.open();
		await until(() => session.messages.some((message) => message.content === "fourth"), "follow-up received");
		assert.deepEqual(owner.agents.userQueue(fullId), []);
		viewer.editor.setText("draft");
		viewer.editor.onEscape();
		assert.equal(viewer.editor.getText(), "draft");
		viewer.dispose();
	};
	const runner = root.session.extensionRunner;
	await runner.getCommand("tasks").handler("", { ...runner.createCommandContext(), ui: { notify: noop, custom } });
	assert.equal(text, "now\n\nlater\n\ndraft");
	assert.equal(again, "same\n\ndraft");
	root.state.hold.open();
	await root.close();
});

test("a user's steer withdrawn from a running turn ends at once, so it can be sent again while the turn stops", async () => {
	const root = await startRoot({ maxConcurrent: 1, maxOutstanding: 2 });
	root.state.hold = gate();
	root.state.stuck = true;
	const id = idOf(await root.call({ action: "spawn", name: "worker", message: "one" }));
	await root.waitBusy(1);
	const owner = globalThis[Symbol.for("pi-agents:runtime")].nodes.get(root.session.sessionManager.getSessionId());
	const fullId = owner.agents.ownedTarget(id).record.id;
	owner.agents.prompt(fullId, "now", "steer");
	assert.deepEqual(owner.agents.userQueue(fullId, true), [{ text: "now", delivery: "steer" }]);
	const aborting = owner.agents.abortAgent(fullId);
	owner.agents.prompt(fullId, "now", "steer");
	root.state.stuck = false;
	root.state.hold.open();
	assert.equal(await aborting, true);
	await root.close();
});

test("a user's steer sent while a turn stops stays queued and goes with the next turn, as in Pi", async () => {
	const root = await startRoot();
	const stopping = gate();
	root.state.hold = stopping;
	root.state.stuck = true;
	const id = idOf(await root.call({ action: "spawn", name: "worker", message: "one" }));
	await root.waitBusy(1);
	const owner = globalThis[Symbol.for("pi-agents:runtime")].nodes.get(root.session.sessionManager.getSessionId());
	const fullId = owner.agents.ownedTarget(id).record.id;
	const aborting = owner.agents.abortAgent(fullId);
	owner.agents.prompt(fullId, "during", "steer");
	assert.deepEqual(owner.agents.userQueue(fullId), [{ text: "during", delivery: "steer" }]);
	root.state.hold = gate();
	root.state.stuck = false;
	stopping.open();
	assert.equal(await aborting, true);
	await new Promise((resolve) => setTimeout(resolve, 100));
	// The steer starts no turn by itself.
	assert.equal(root.state.busy, 1);
	assert.equal(owner.agents.counts(fullId).state, "idle");
	assert.deepEqual(owner.agents.userQueue(fullId), [{ text: "during", delivery: "steer" }]);
	owner.agents.prompt(fullId, "two", "steer");
	await root.waitBusy(2);
	assert.deepEqual(owner.agents.userQueue(fullId), []);
	root.state.hold.open();
	await until(() => owner.agents.counts(fullId).state === "idle", "second turn");
	const last = owner.agents.conversation(fullId).messages.at(-1);
	assert.match(textOf(last.content), /^answer:during\|seen:one,two,during$/);
	await root.close();
});

test("after a held message, a notification still does not start a turn", async () => {
	const root = await startRoot();
	const stopping = gate();
	root.state.hold = stopping;
	root.state.stuck = true;
	const id = idOf(await root.call({ action: "spawn", name: "worker", message: "one" }));
	await root.waitBusy(1);
	const owner = globalThis[Symbol.for("pi-agents:runtime")].nodes.get(root.session.sessionManager.getSessionId());
	const fullId = owner.agents.ownedTarget(id).record.id;
	const aborting = owner.agents.abortAgent(fullId);
	owner.agents.prompt(fullId, "held", "steer");
	root.state.hold = gate();
	root.state.stuck = false;
	stopping.open();
	await aborting;
	assert.deepEqual(owner.agents.accept(fullId, "result", "steer", { fromOwner: false, notice: { results: [] } }), { queued: false });
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(root.state.busy, 1);
	assert.deepEqual(owner.agents.counts(fullId), { state: "idle", pending: 1, since: undefined, spent: undefined });
	assert.deepEqual(owner.agents.userQueue(fullId), [{ text: "held", delivery: "steer" }]);
	root.state.hold.open();
	await root.close();
});

test("a turn that does not stop within the abort timeout is abandoned, and the tree becomes idle", async () => {
	const root = await startRoot();
	root.state.hold = gate();
	root.state.stuck = true;
	await root.call({ action: "spawn", name: "worker", message: "one" });
	await root.waitBusy(1);
	await assert.rejects(root.call({ action: "abort", target: "worker" }), /did not stop within the timeout/);
	assert.equal(await root.call({ action: "wait", target: "worker", timeout: 10 }), "Nothing to wait for.");
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
