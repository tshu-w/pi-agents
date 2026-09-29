import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { jiti, pi, PI_PACKAGE } from "./pi.mjs";

const ai = await import(join(PI_PACKAGE, "node_modules/@earendil-works/pi-ai/dist/index.js"));
const { loadCodemode } = await jiti.import("../codemode.ts");
const { agentGlobals, withAgentPrefix } = await jiti.import("../program-sandbox.ts");
const { Type } = await jiti.import("typebox");
const { CodemodeSandbox } = await loadCodemode();

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("a background Program keeps calling tools after its tool returns and stops with its own signal", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-agents-program-"));
	writeFileSync(join(cwd, "note.txt"), "note");
	const agentDir = mkdtempSync(join(tmpdir(), "pi-agents-home-"));
	const controller = new AbortController();
	const state = { calls: 0, running: undefined };
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "model" }], tokensPerSecond: 0 });
	faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("start", {})), ai.fauxAssistantMessage("started")]);
	const modelRuntime = await pi.ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null });
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const resourceLoader = new pi.DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			(api) => api.registerTool({
				name: "start",
				label: "start",
				description: "Starts a background Program.",
				parameters: Type.Object({}),
				async execute(_id, _args, _signal, _onUpdate, ctx) {
					const read = {
						name: "read",
						execute: async (args) => {
							state.calls++;
							const outcome = await ctx.executeTool("read", args, { signal: controller.signal });
							return outcome.result.content[0].text;
						},
					};
					state.running = new CodemodeSandbox({ tools: [read], timeoutMs: Infinity })
						.execute("while (true) await tools.read({ path: 'note.txt' })", { signal: controller.signal });
					return { content: [{ type: "text", text: "started" }], details: {} };
				},
			}),
		],
	});
	await resourceLoader.reload();
	const { session } = await pi.createAgentSession({
		cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel(),
		sessionManager: pi.SessionManager.inMemory(cwd), tools: ["read", "start"],
	});
	await session.bindExtensions({ mode: "print" });
	await session.prompt("go");
	const afterTurn = state.calls;
	while (state.calls < afterTurn + 5) await new Promise((resolve) => setTimeout(resolve, 10));
	controller.abort(new Error("Program stopped"));
	const result = await state.running;
	assert.equal(result.ok, false);
	assert.equal(result.error.kind, "aborted");
	assert.equal(result.error.message, "Program stopped");
	session.dispose();
});

test("agent() returns a handle at once, and its calls reach the host in order", async () => {
	const events = [];
	const host = {
		create: async (id, name, options) => {
			events.push(["create", name, options]);
			if (options.name === "broken") throw new Error("cwd does not exist");
		},
		send: async (id, message) => (events.push(["send", id, message]), `${message}!`),
		abort: async (id) => void events.push(["abort", id]),
	};
	const sandbox = new CodemodeSandbox({ globals: agentGlobals(host) });
	const code = withAgentPrefix(`const a = agent();
const b = agent({ name: "reviewer", cwd: "/tmp" });
const c = agent();
const answer = await a.send("hi");
await b.abort();
let failure;
try { await agent({ name: "broken" }).send("x"); } catch (error) { failure = error.message; }
return { ids: [a.id, b.id, c.id], names: [a.name, b.name, c.name], answer, failure };`);
	const result = await sandbox.execute(code);
	assert.equal(result.ok, true, JSON.stringify(result.error));
	const { ids, names, answer, failure } = result.value;
	assert.deepEqual(names, ["agent-1", "reviewer", "agent-2"]);
	assert.equal(new Set(ids).size, 3);
	for (const id of ids) assert.match(id, UUID_V7);
	assert.equal(answer, "hi!");
	assert.equal(failure, "cwd does not exist");
	assert.deepEqual(events.slice(0, 4), [
		["create", "agent-1", {}],
		["create", "reviewer", { name: "reviewer", cwd: "/tmp" }],
		["create", "agent-2", {}],
		["send", ids[0], "hi"],
	]);
	assert.deepEqual(events[4], ["abort", ids[1]]);
});

test("Programs started together give their Agents different IDs", async () => {
	const host = { create: async () => {}, send: async () => {}, abort: async () => {} };
	const results = await Promise.all(
		Array.from({ length: 6 }, () => new CodemodeSandbox({ globals: agentGlobals(host) }).execute(withAgentPrefix("return [agent().id, agent().id, agent().id]"))),
	);
	const ids = results.flatMap((result) => (assert.equal(result.ok, true, JSON.stringify(result.error)), result.value));
	assert.equal(new Set(ids).size, 18);
	for (const id of ids) assert.match(id, UUID_V7);
});

test("errors in a script with agent() report the line as written", async () => {
	const sandbox = new CodemodeSandbox({ globals: agentGlobals({ create: async () => {}, send: async () => {}, abort: async () => {} }) });
	const result = await sandbox.execute(withAgentPrefix("const a = agent();\nthrow new Error('boom');"));
	assert.equal(result.ok, false);
	assert.match(result.error.stack, /codemode\.js:2/);
});
