import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const home = mkdtempSync("/tmp/pa-root-runtime-");
Object.assign(process.env, { PI_CODING_AGENT_DIR: home, PI_AGENTS_STATE_DIR: join(home, "state") });
const { pi, gate } = await import("./pi.mjs");
const { rootPaths } = await import("../src/roots/paths.mjs");
const { request } = await import("../src/roots/transport.mjs");
const loader = new pi.DefaultResourceLoader({
	cwd: home, agentDir: home, noExtensions: true, additionalExtensionPaths: [fileURLToPath(new URL("./fixtures/tree-extension.ts", import.meta.url))],
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const { createRootRuntime, treeIdle } = globalThis.piAgentsTree;

test("a root stays busy while it receives a message from another root", async (t) => {
	const manager = pi.SessionManager.create(home, join(home, "sessions"));
	const id = manager.getSessionId();
	const events = new Map();
	const entered = gate();
	const receiving = gate();
	const runtime = createRootRuntime({ on: (event, handler) => events.set(event, handler), getSessionName: () => undefined }, {
		receivedIds: () => [],
		treeIdle: () => treeIdle(id),
		receive: async () => {
			entered.open();
			await receiving.promise;
		},
	});
	t.after(() => runtime.stop());
	await runtime.start({
		cwd: home, sessionManager: manager, model: { provider: "test", id: "fake" },
		isIdle: () => true, hasPendingMessages: () => false, isProjectTrusted: () => true,
	});
	events.get("resources_discover")();
	const socket = rootPaths().worker(id);
	const receipt = request(socket, { action: "deliver", message: { id: "message", sender: { id: "sender" }, recipient: id, body: "work" } });
	await entered.promise;
	assert.equal((await request(socket, { action: "status" })).state, "running");
	receiving.open();
	await receipt;
	assert.equal((await request(socket, { action: "status" })).state, "idle");
});
