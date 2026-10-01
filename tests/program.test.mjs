import assert from "node:assert/strict";
import { test } from "node:test";
import { jiti } from "./pi.mjs";

const { loadCodemode } = await jiti.import("../codemode.ts");
const { agentGlobals, withAgentPrefix } = await jiti.import("../program-sandbox.ts");
const { CodemodeSandbox } = await loadCodemode();

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
	assert.match(result.error.stack, /:2\b/);
});
