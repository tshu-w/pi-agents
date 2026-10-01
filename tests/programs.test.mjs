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
 * first value, and with the second after an error; `hold` answers once `state.release` is called;
 * `call:<json>` calls `agent` with those arguments and answers with its result.
 */
async function startRoot(cwd = mkdtempSync(join(tmpdir(), "pi-agents-cwd-")), sessionFile = undefined, limits = {}, settings = {}, extensions = []) {
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
			if (body.startsWith("call:")) {
				if (last.role !== "toolResult") return ai.fauxAssistantMessage(ai.fauxToolCall("agent", JSON.parse(body.slice("call:".length))));
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
		additionalExtensionPaths: [fileURLToPath(new URL("../src/index.ts", import.meta.url)), ...extensions],
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
		return { content: result.content, details: result.details, isError: result.isError || undefined };
	};
	const text = async (args, tool) => {
		const result = await call(args, tool);
		// A failed Program is a result with its calls; other errors are the tool's own.
		if (result.isError && !Array.isArray(result.details?.calls)) throw new Error(textOf(result.content));
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
	assert.match(textOf(completed.content), /\["undefined","note"\]$/);
	const failed = await root.call({ action: "run", code: "store('lost', 1); throw new Error('boom')" });
	assert.equal(failed.isError, true);
	assert.match(textOf(failed.content), /boom/);
	assert.match(await root.text({ action: "run", code: "return [load('note'), load('lost') ?? null]" }), /\["note",null\]$/);
	await root.close();
});

test("a background Program runs on after run returns, notifies its caller, and wait returns its result once", async () => {
	const root = await startRoot();
	const id = idOf(await root.text({ action: "run", background: true, code: "await tools.read({ path: 'note.txt' }); return 'done'" }));
	const deadline = Date.now() + 10000;
	while (!root.messages.includes(`Program ${id} completed.`) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(root.messages.includes(`Program ${id} completed.`), root.messages.join("\n"));
	assert.match(await root.text({ action: "wait", timeout: 10 }), /done$/);
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
	const results = await root.text({ action: "wait", target: [stopped, timedOut], timeout: 10 });
	assert.match(results, new RegExp(`<program-result id="${stopped}" status="stopped">`));
	assert.match(results, new RegExp(`<program-result id="${timedOut}" status="stopped">`));
	await root.close();
});

test("a background Program's calls keep distinct IDs across turns, and their hooks follow the Program's signal", async () => {
	const hookExtension = fileURLToPath(new URL("./fixtures/hook-extension.mjs", import.meta.url));
	const root = await startRoot(undefined, undefined, {}, {}, [hookExtension]);
	const { hooks } = await import(hookExtension);
	hooks.holdMs = 300;
	const id = idOf(await root.text({ action: "run", background: true, code: "for (let i = 0; i < 4; i++) await tools.read({ path: 'note.txt' }); return 'done'" }));
	// A caller turn that is aborted while the Program calls tools.
	const turn = root.call({ action: "run", code: "await tools.read({ path: 'note.txt' }); return 'fg'" });
	await new Promise((resolve) => setTimeout(resolve, 100));
	await root.session.abort();
	await turn;
	assert.match(await root.text({ action: "wait", target: id, timeout: 10 }), /done$/);
	const runCallId = root.session.messages.find((message) => message.role === "toolResult" && textOf(message.content) === `Program ${id} started.`).toolCallId;
	const background = hooks.calls.filter((call) => call.id.startsWith(`${runCallId}:`));
	assert.equal(background.length, 4);
	assert.equal(new Set(background.map((call) => call.id)).size, 4);
	assert.ok(background.every((call) => call.signal && !call.aborted));
	// Stopping the Program aborts the signal its hooks see.
	hooks.calls.length = 0;
	hooks.holdMs = 5000;
	const stopped = idOf(await root.text({ action: "run", background: true, code: "await tools.read({ path: 'note.txt' })" }));
	while (hooks.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
	await root.text({ action: "stop", target: stopped });
	assert.equal(hooks.calls[0].aborted, true);
	// ctx.abort() in a hook stops the Program, not the caller's turn.
	hooks.holdMs = 300;
	const aborted = idOf(await root.text({ action: "run", background: true, code: "await tools.read({ path: 'note.txt' }); await tools.read({ path: 'abort.txt' }); return 'unreachable'" }));
	const caller = await root.call({ action: "run", code: "await tools.read({ path: 'note.txt' }); await tools.read({ path: 'note.txt' }); return 'fg'" });
	assert.match(textOf(caller.content), /fg$/);
	assert.match(await root.text({ action: "wait", target: aborted, timeout: 10 }), new RegExp(`<program-result id="${aborted}" status="stopped">`));
	await root.close();
});

test("compaction lists the files of background Programs", async () => {
	const root = await startRoot(undefined, undefined, {}, { compaction: { keepRecentTokens: 1 } });
	const id = idOf(await root.text({ action: "run", background: true, code: "await tools.read({ path: 'note.txt' })" }));
	await root.text({ action: "wait", target: id, timeout: 10 });
	await root.text({ action: "list" });
	await root.session.compact();
	const compaction = root.sessionManager.getEntries().findLast((entry) => entry.type === "compaction");
	assert.deepEqual(compaction.details.readFiles, ["note.txt"]);
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
		try { await a.send('submit:{"m":1}', { schema: ${schema} }); } catch (error) { errors.push(error.message); }
		return { names: [a.name, b.name], answers, errors };
	` });
	const value = JSON.parse(result.slice(result.indexOf("Output:\n") + 8));
	assert.deepEqual(value.names, ["w", "agent-1"]);
	assert.deepEqual(value.answers, ["answer:hello", { n: 2 }]);
	assert.equal(value.errors.length, 1);
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

test("each of a Program's Agents sees only itself and the Agents under it", async () => {
	const root = await startRoot();
	const result = await root.text({ action: "run", code: `
		const a = agent({ name: 'alpha' }), b = agent({ name: 'beta' });
		await b.send('hello');
		return [
			await a.send('call:{"action":"list"}'),
			await a.send('call:{"action":"send","target":"beta","message":"hi"}'),
		];
	` });
	const [list, send] = JSON.parse(result.slice(result.indexOf("Output:\n") + 8));
	assert.equal(list, "No matching Agents.");
	assert.match(send, /^No visible Agent matches "beta"/);
	await root.close();
});

test("codemode.mode decides whether program lists the direct tools or they keep their own declarations", async () => {
	const declared = (root) => Object.fromEntries(root.session.agent.state.tools.map((tool) => [tool.name, tool.description]));
	const on = await startRoot();
	const readDescription = on.session.getAllTools().find((tool) => tool.name === "read").description;
	let tools = declared(on);
	assert.ok(tools.read.startsWith(readDescription) && tools.read.length > readDescription.length);
	assert.ok(!tools.program.includes(readDescription));
	assert.deepEqual([...on.session._hiddenDeclarations], []);
	await on.close();
	const only = await startRoot(undefined, undefined, {}, { codemode: { mode: "only" } });
	tools = declared(only);
	assert.ok(tools.program.includes(readDescription));
	assert.deepEqual([...only.session._hiddenDeclarations].sort(), ["agent", "read"]);
	await only.close();
});

test("MCP activates program, and a Program waits for the MCP server its code names", async () => {
	process.env.PI_AGENTS_TEST_MCP_DELAY = "1500";
	const cwd = mkdtempSync(join(tmpdir(), "pi-agents-cwd-"));
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "model" }], tokensPerSecond: 0 });
	faux.setResponses([
		() => {
			return ai.fauxAssistantMessage(ai.fauxToolCall("program", { action: "run", code: "return (await tools.mcp__echo__shout({ text: 'hi' })).content[0].text" }));
		},
		() => ai.fauxAssistantMessage("done"),
	]);
	const modelRuntime = await pi.ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null });
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const resourceLoader = new pi.DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true,
		extensionFactories: [{ name: "codemode", builtin: true, factory: pi.createCodemodeExtension() }, { name: "mcp", builtin: true, factory: pi.createMcpExtension() }],
		additionalExtensionPaths: ["builtin:codemode", "builtin:mcp", fileURLToPath(new URL("../src/index.ts", import.meta.url)), fileURLToPath(new URL("./fixtures/mcp-extension.mjs", import.meta.url))],
	});
	await resourceLoader.reload();
	const { session } = await pi.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: pi.SessionManager.inMemory(cwd), modelRuntime, model: faux.getModel() });
	const notes = [];
	const noop = () => undefined;
	const uiContext = { notify: (message) => notes.push(message), setStatus: noop, setWidget: noop, setFooter: noop, setTitle: noop, setWorkingMessage: noop, select: noop, confirm: noop, input: noop, editor: noop, custom: noop, onTerminalInput: () => noop };
	await session.bindExtensions({ mode: "interactive", uiContext });
	delete process.env.PI_AGENTS_TEST_MCP_DELAY;
	assert.ok(session.getActiveToolNames().includes("program"));
	assert.ok(!session.getActiveToolNames().includes("codemode"));
	assert.ok(!session.getAllTools().some((tool) => tool.name === "mcp__echo__shout"));
	await session.prompt("shout");
	assert.match(textOf(session.messages.findLast((message) => message.role === "toolResult").content), /HI$/);
	assert.deepEqual(notes.filter((note) => /MCP tools are only reachable/.test(note)), []);
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
});
