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
	: content.filter((block) => block.type === "text").map((block) => block.text).join("");

/** The text an Agent received from its owner, without the header and the schema instruction. */
const bodyOf = (text) => text.split("\n").slice(1).join("\n").split("\n\nWhen done, call")[0];

/**
 * A root Session whose model calls a tool with the arguments of each `call`, and otherwise
 * records the message and answers "noted". Programs call tools only within the agent loop.
 *
 * Agents answer `answer:<body>`. A body `submit:<json>[|<json>]` calls `submit_result` with the
 * first value, and with the second after an error; `hold` answers once `state.release` is called.
 */
async function startRoot(cwd = mkdtempSync(join(tmpdir(), "pi-agents-cwd-")), sessionFile = undefined, limits = {}, settings = {}) {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ ...settings, "pi-agents": { maxConcurrent: 3, maxOutstanding: 8, ...limits } }));
	writeFileSync(join(cwd, "note.txt"), "note");
	const messages = [];
	const pending = [];
	const state = { busy: 0 };
	let release;
	const released = new Promise((resolve) => { release = resolve; });
	state.release = release;
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "model" }], tokensPerSecond: 0 });
	faux.setResponses(Array.from({ length: 200 }, () => async (context, options) => {
		const last = context.messages.at(-1);
		const first = textOf(context.messages.find((message) => message.role === "user")?.content ?? "");
		if (first.startsWith("Message from")) {
			const body = bodyOf(textOf(context.messages.findLast((message) => message.role === "user").content));
			if (body.startsWith("submit:")) {
				const [value, retry] = body.slice("submit:".length).split("|").map((json) => JSON.parse(json));
				if (last.role !== "toolResult") return ai.fauxAssistantMessage(ai.fauxToolCall("submit_result", { value }));
				if (last.isError && retry !== undefined) return ai.fauxAssistantMessage(ai.fauxToolCall("submit_result", { value: retry }));
				return ai.fauxAssistantMessage(textOf(last.content));
			}
			if (body === "hold") {
				state.busy += 1;
				await Promise.race([released, new Promise((resolve) => options?.signal?.addEventListener("abort", resolve, { once: true }))]);
				if (options?.signal?.aborted) return ai.fauxAssistantMessage("", { stopReason: "aborted" });
			}
			return ai.fauxAssistantMessage(`answer:${body}`);
		}
		if (last?.role === "user" && textOf(last.content) === "call") {
			const [tool, args] = pending.shift();
			return ai.fauxAssistantMessage(ai.fauxToolCall(tool, args));
		}
		if (last?.role !== "toolResult") messages.push(textOf(last?.content ?? ""));
		return ai.fauxAssistantMessage("noted");
	}));
	const modelRuntime = await pi.ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null });
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const resourceLoader = new pi.DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true,
		additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))],
	});
	await resourceLoader.reload();
	const sessionManager = sessionFile ? pi.SessionManager.open(sessionFile) : pi.SessionManager.create(cwd, join(cwd, "sessions"));
	const { session } = await pi.createAgentSession({
		cwd, agentDir, settingsManager, resourceLoader, sessionManager, modelRuntime, model: faux.getModel(), tools: ["read", "program", "agent"],
	});
	await session.bindExtensions({ mode: "print" });
	const call = async (args, tool = "program") => {
		await session.waitForIdle();
		pending.push([tool, args]);
		await session.prompt("call");
		const result = session.messages.findLast((message) => message.role === "toolResult");
		return { content: result.content, isError: result.isError || undefined };
	};
	const text = async (args, tool) => {
		const result = await call(args, tool);
		if (result.isError && !/^Script failed/.test(textOf(result.content))) throw new Error(textOf(result.content));
		return textOf(result.content);
	};
	const close = async () => {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	};
	return { cwd, session, sessionManager, call, text, messages, state, close };
}

const idOf = (text) => /^Program (\S+) started\.$/.exec(text)[1];

test("a foreground Program calls the caller's tools except program and keeps store writes only when it completes", async () => {
	const root = await startRoot();
	const completed = await root.call({ action: "run", code: "const note = await tools.read({ path: 'note.txt' }); store('note', note); return [typeof tools.program, note]" });
	assert.equal(completed.isError, undefined, textOf(completed.content));
	assert.match(textOf(completed.content), /^Script completed\nWall time [\d.]+ seconds\nOutput:\n\["undefined","note"\]$/);
	const failed = await root.call({ action: "run", code: "store('lost', 1); throw new Error('boom')" });
	assert.equal(failed.isError, true);
	assert.match(textOf(failed.content), /^Script failed\n[\s\S]*Error: boom/);
	assert.match(await root.text({ action: "run", code: "return [load('note'), load('lost') ?? null]" }), /\["note",null\]$/);
	await root.close();
});

test("a background Program runs on after run returns, notifies its caller, and wait returns its result once", async () => {
	const root = await startRoot();
	const id = idOf(await root.text({ action: "run", background: true, code: "await tools.read({ path: 'note.txt' }); return 'done'" }));
	const deadline = Date.now() + 10000;
	while (!root.messages.includes(`Program ${id} completed.`) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(root.messages.includes(`Program ${id} completed.`), root.messages.join("\n"));
	assert.match(await root.text({ action: "wait", timeout: 10 }), /^Script completed\n[\s\S]*Output:\ndone$/);
	assert.equal(await root.text({ action: "wait", timeout: 10 }), "No results.");
	assert.match(await root.text({ action: "list" }), new RegExp(`^${id}  completed  \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d$`));
	await root.close();
});

test("stop and timeout stop background Programs", async () => {
	const root = await startRoot();
	const loop = "while (true) await tools.read({ path: 'note.txt' })";
	const stopped = idOf(await root.text({ action: "run", background: true, code: loop }));
	const timedOut = idOf(await root.text({ action: "run", background: true, code: loop, timeout: 0.2 }));
	assert.equal(await root.text({ action: "stop", target: stopped }), `Program ${stopped} stopped.`);
	assert.equal(await root.text({ action: "stop", target: stopped }), `Program ${stopped} has already ended.`);
	const results = await root.text({ action: "wait", target: [stopped, timedOut], timeout: 10 });
	assert.match(results, new RegExp(`<program-result id="${stopped}" status="stopped">\\n[\\s\\S]*Script aborted: Program stopped[\\s\\S]*?</program-result>`));
	assert.match(results, new RegExp(`<program-result id="${timedOut}" status="stopped">\\n[\\s\\S]*Script timed out`));
	await assert.rejects(root.text({ action: "stop", target: "missing" }), /No Program matches "missing"\. Use list to find Programs\./);
	await root.close();
});

test("a caller going offline stops its Programs, and their results remain when it is loaded again", async () => {
	const root = await startRoot();
	const id = idOf(await root.text({ action: "run", background: true, code: "while (true) await tools.read({ path: 'note.txt' })" }));
	const file = root.sessionManager.getSessionFile();
	await root.close();
	const reopened = await startRoot(root.cwd, file);
	assert.match(await reopened.text({ action: "wait", target: id, timeout: 10 }), new RegExp(`<program-result id="${id}" status="stopped">\\n[\\s\\S]*the caller went offline`));
	await reopened.close();
});

test("agent() handles return answers and submitted values, and schema inputs fail without a valid submission", async () => {
	const root = await startRoot();
	const schema = "{ type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }";
	const result = await root.text({ action: "run", code: `
		const a = agent({ name: 'w' });
		const b = agent();
		const answers = await Promise.all([a.send('hello'), b.send('submit:{"n":"x"}|{"n":2}', { schema: ${schema} })]);
		const errors = [];
		for (const run of [() => a.send('submit:{"m":1}', { schema: ${schema} }), () => a.send('plain', { schema: ${schema} }), () => a.send('x', { deliverAs: 'steer', schema: ${schema} })]) {
			try { await run(); } catch (error) { errors.push(error.message); }
		}
		return { names: [a.name, b.name], answers, errors };
	` });
	const value = JSON.parse(result.slice(result.indexOf("Output:\n") + 8));
	assert.deepEqual(value.names, ["w", "agent-1"]);
	assert.deepEqual(value.answers, ["answer:hello", { n: 2 }]);
	assert.match(value.errors[0], /^Agent w \(\S+\) failed: The turn ended without calling submit_result\.$/);
	assert.match(value.errors[1], /failed: The turn ended without calling submit_result\.$/);
	assert.equal(value.errors[2], 'send() accepts schema only with deliverAs "followUp"');
	await root.close();
});

test("a Program's Agents are invisible to the caller, count toward its limit, and are aborted when it stops", async () => {
	const root = await startRoot(undefined, undefined, { maxConcurrent: 2, maxOutstanding: 2 });
	const waitBusy = async (count) => {
		const deadline = Date.now() + 10000;
		while (root.state.busy < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(root.state.busy, count);
	};
	assert.match(await root.text({ action: "spawn", name: "outside", message: "hold" }, "agent"), /^Agent outside \(\S+\) started\.$/);
	await waitBusy(1);
	const id = idOf(await root.text({ action: "run", background: true, code: `
		const a = agent(), b = agent();
		const held = a.send('hold');
		try { await b.send('x'); } catch (error) { text(error.message); }
		await held;
	` }));
	await waitBusy(2);
	// Other roots may be listed; the Program's Agents share the caller's cwd.
	assert.match(await root.text({ action: "list", query: root.cwd }, "agent"), /^outside \(\S+\)  busy  \S+$/);
	assert.equal(await root.text({ action: "stop", target: id }), `Program ${id} stopped.`);
	const result = await root.text({ action: "wait", target: id, timeout: 10 });
	assert.match(result, /status="stopped">\n[\s\S]*Input rejected: 2 inputs have not ended/);
	await root.close();
});

test("codemode.mode decides whether program lists the direct tools or they keep their own declarations", async () => {
	const declared = (root) => Object.fromEntries(root.session.agent.state.tools.map((tool) => [tool.name, tool.description]));
	const on = await startRoot();
	let tools = declared(on);
	assert.match(tools.read, /program tool declaration:\n```ts\ndeclare const tools: \{ read\(/);
	assert.doesNotMatch(tools.program, /Nested tools:/);
	await on.close();
	const only = await startRoot(undefined, undefined, {}, { codemode: { mode: "only" } });
	tools = declared(only);
	assert.match(tools.program, /Nested tools: COMPLETE list \(2 tools\)\.[\s\S]*### `read`[\s\S]*### `agent`/);
	assert.deepEqual([...only.session._hiddenDeclarations].sort(), ["agent", "read"]);
	await only.close();
});
