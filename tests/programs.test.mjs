import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const agentDir = mkdtempSync(join(tmpdir(), "pi-agents-home-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { pi, ai, EXTENSION, textOf, gate, until, createSession } = await import("./pi.mjs");

/** The text an Agent received from its owner, without the header and the schema instruction. */
const bodyOf = (text) => text.split("\n").slice(1, -1).join("\n").split("\n\nWhen done, call")[0];

/**
 * A root Session whose model calls a tool with the arguments of each `call`, and otherwise
 * records the message and answers "noted". Programs call tools only within the agent loop.
 * `state.declared` holds the tool declarations the root's model saw last.
 *
 * Agents answer `answer:<body>`. A body `submit:<json>[|<json>]` calls `submit_result` with the
 * first value, and with the second after an error; `hold` counts itself in `state.busy` and answers
 * once `state.hold` opens; `call:<json>` and `program:<json>` call `agent` or `program` with those
 * arguments and answer with the result.
 */
async function startRoot(cwd = mkdtempSync(join(tmpdir(), "pi-agents-cwd-")), sessionFile = undefined, limits = {}, settings = {}, extensions = []) {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ ...settings, "pi-agents": { maxConcurrent: 3, maxOutstanding: 8, ...limits } }));
	writeFileSync(join(cwd, "note.txt"), "note");
	const messages = [];
	const pending = [];
	const state = { busy: 0, hold: gate(), declared: [] };
	const route = async (context, options) => {
		const last = context.messages.at(-1);
		const first = textOf(context.messages.find((message) => message.role === "user")?.content ?? "");
		if (first.startsWith("<agent-message ")) {
			const body = bodyOf(textOf(context.messages.findLast((message) => message.role === "user").content));
			if (body.startsWith("submit:")) {
				const [value, retry] = body.slice("submit:".length).split("|").map((json) => JSON.parse(json));
				if (last.role !== "toolResult") return ai.fauxAssistantMessage(ai.fauxToolCall("submit_result", { value }));
				if (last.isError && retry !== undefined) return ai.fauxAssistantMessage(ai.fauxToolCall("submit_result", { value: retry }));
				return ai.fauxAssistantMessage(textOf(last.content));
			}
			const [, tool, json] = /^(call|program):(.*)$/s.exec(body) ?? [];
			if (tool) {
				if (last.role !== "toolResult") return ai.fauxAssistantMessage(ai.fauxToolCall(tool === "call" ? "agent" : "program", JSON.parse(json)));
				return ai.fauxAssistantMessage(textOf(last.content));
			}
			if (body === "hold") {
				state.busy += 1;
				await Promise.race([state.hold.promise, new Promise((resolve) => options?.signal?.addEventListener("abort", resolve, { once: true }))]);
				if (options?.signal?.aborted) return ai.fauxAssistantMessage("", { stopReason: "aborted" });
			}
			return ai.fauxAssistantMessage(`answer:${body}`);
		}
		state.declared = context.messages.filter((message) => message.role === "system").flatMap((message) => message.toolsAdded ?? []);
		if (last?.role === "user" && textOf(last.content) === "call") {
			const [tool, args] = pending.shift();
			return ai.fauxAssistantMessage(ai.fauxToolCall(tool, args));
		}
		if (last?.role !== "toolResult") messages.push(textOf(last?.content ?? ""));
		return ai.fauxAssistantMessage("noted");
	};
	const sessionManager = sessionFile ? pi.SessionManager.open(sessionFile) : pi.SessionManager.create(cwd, join(cwd, "sessions"));
	const session = await createSession({ cwd, route, extensions: [EXTENSION, ...extensions], sessionManager, tools: ["read", "program", "agent"] });
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
	const completed = await root.call({ action: "run", code: "const note = await tools.read({ path: 'note.txt' }); store('note', note); return ['program' in tools, note]" });
	assert.equal(completed.isError, undefined, textOf(completed.content));
	assert.match(textOf(completed.content), /\[false,"note"\]$/);
	const failed = await root.call({ action: "run", code: "store('lost', 1); throw new Error('boom')" });
	assert.equal(failed.isError, true);
	assert.match(textOf(failed.content), /boom/);
	assert.match(await root.text({ action: "run", code: "return [load('note'), load('lost') ?? null]" }), /\["note",null\]$/);
	await root.close();
});

test("a background Program runs on after run returns, notifies its caller, and wait returns its result once", async () => {
	const root = await startRoot();
	const id = idOf(await root.text({ action: "run", background: true, code: "await tools.read({ path: 'note.txt' }); return 'done'" }));
	await until(() => root.messages.includes(`Program ${id} completed.`), "notification");
	assert.match(await root.text({ action: "wait", timeout: 10 }), /done$/);
	assert.equal(await root.text({ action: "wait", timeout: 10 }), "No results.");
	assert.match(await root.text({ action: "list" }), new RegExp(`^${id}  completed$`));
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
	hooks.holdMs = 80;
	const id = idOf(await root.text({ action: "run", background: true, code: "for (let i = 0; i < 4; i++) await tools.read({ path: 'note.txt' }); return 'done'" }));
	// A caller turn that is aborted while a foreground Program and the background one call tools.
	const turn = root.call({ action: "run", code: "await tools.read({ path: 'foreground.txt' }); return 'fg'" });
	const foreground = await until(() => hooks.calls.find((call) => call.path === "foreground.txt"), "foreground call");
	await root.session.abort();
	await turn;
	assert.equal(foreground.aborted, true);
	assert.match(await root.text({ action: "wait", target: id, timeout: 10 }), /done$/);
	const background = hooks.calls.filter((call) => call.path === "note.txt");
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
	hooks.holdMs = 80;
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

test("a background Program keeps its caller's tree busy until it ends, and the user sees its Agents under it", async () => {
	const root = await startRoot(undefined, undefined, {}, {}, [fileURLToPath(new URL("./fixtures/tree-extension.ts", import.meta.url))]);
	const { nodes, treeIdle, panelLines, ownedEntries } = globalThis.piAgentsTree;
	const self = nodes.get(root.session.sessionManager.getSessionId());
	const id = idOf(await root.text({ action: "run", background: true, code: `
		await agent({ name: 'inner' }).send('hold');
		while (true) await tools.read({ path: 'note.txt' });
	` }));
	await until(() => root.state.busy === 1, "inner Agent busy");
	assert.deepEqual(panelLines(self).slice(1).map((line) => line.replace(/\(\S+\)/, "(id)")), [`  Program ${id}  running`, "    Agent inner (id)  busy"]);
	assert.deepEqual(ownedEntries(self).map((entry) => entry.name), ["inner"]);
	// After its Agent answers, the Program only calls tools, and the tree stays busy.
	root.state.hold.open();
	await until(() => panelLines(self).length === 2, "inner Agent idle");
	assert.equal(treeIdle(self.rootId), false);
	await root.text({ action: "stop", target: id });
	await root.session.waitForIdle();
	assert.equal(treeIdle(self.rootId), true);
	assert.deepEqual(panelLines(self), []);
	await root.close();
});

test("an owned Agent gives up its slot while its foreground Program waits for an Agent under it", async () => {
	const root = await startRoot(undefined, undefined, { maxConcurrent: 1, maxOutstanding: 2 });
	const run = { action: "run", code: "return await agent().send('inner')" };
	await root.text({ action: "spawn", name: "outer", message: `program:${JSON.stringify(run)}` }, "agent");
	assert.match(await root.text({ action: "wait", target: "outer", timeout: 10 }, "agent"), /^Script completed\n[\s\S]*answer:inner$/);
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
	const declared = async (root) => {
		await root.session.prompt("hello");
		return Object.fromEntries(root.state.declared.map((tool) => [tool.name, tool.description]));
	};
	const on = await startRoot();
	const readDescription = on.session.getAllTools().find((tool) => tool.name === "read").description;
	let tools = await declared(on);
	assert.deepEqual(Object.keys(tools).sort(), ["agent", "program", "read"]);
	assert.ok(tools.read.startsWith(readDescription) && tools.read.length > readDescription.length);
	assert.ok(!tools.program.includes(readDescription));
	await on.close();
	const only = await startRoot(undefined, undefined, {}, { codemode: { mode: "only" } });
	tools = await declared(only);
	assert.deepEqual(Object.keys(tools), ["program"]);
	assert.ok(tools.program.includes(readDescription));
	await only.close();
});

test("MCP activates program, and a Program waits for the MCP server its code names", async () => {
	process.env.PI_AGENTS_TEST_MCP_DELAY = "300";
	const cwd = mkdtempSync(join(tmpdir(), "pi-agents-cwd-"));
	const route = (context) => context.messages.at(-1).role === "toolResult"
		? ai.fauxAssistantMessage("done")
		: ai.fauxAssistantMessage(ai.fauxToolCall("program", { action: "run", code: "return (await tools.mcp__echo__shout({ text: 'hi' })).content[0].text" }));
	const session = await createSession({
		cwd, route, sessionManager: pi.SessionManager.inMemory(cwd),
		extensionFactories: [{ name: "codemode", builtin: true, factory: pi.createCodemodeExtension() }, { name: "mcp", builtin: true, factory: pi.createMcpExtension() }],
		extensions: ["builtin:codemode", "builtin:mcp", EXTENSION, fileURLToPath(new URL("./fixtures/mcp-extension.mjs", import.meta.url))],
	});
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
