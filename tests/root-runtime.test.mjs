import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const home = mkdtempSync("/tmp/pa-root-runtime-");
Object.assign(process.env, { PI_CODING_AGENT_DIR: home, PI_AGENTS_STATE_DIR: join(home, "state") });
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
const { pi, gate, until } = await import("./pi.mjs");
const { statePaths } = await import("../src/roots/paths.mjs");
const { request } = await import("../src/roots/transport.mjs");
const loader = new pi.DefaultResourceLoader({
	cwd: home, agentDir: home, noExtensions: true, additionalExtensionPaths: [fileURLToPath(new URL("./fixtures/tree-extension.ts", import.meta.url))],
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const { createRootRuntime, createReporter, treeChanged, treeIdle } = globalThis.piAgentsTree;

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
	const socket = statePaths().session(id);
	const receipt = request(socket, { action: "deliver", message: { id: "message", sender: { id: "sender" }, recipient: id, body: "work" } });
	await entered.promise;
	assert.equal((await request(socket, { action: "status" })).state, "running");
	receiving.open();
	await receipt;
	assert.equal((await request(socket, { action: "status" })).state, "idle");
});

test("a reporter whose end frame fails at shutdown stops reporting until the next start", async (t) => {
	t.after(async () => process.kill((await request(statePaths().daemon, { action: "status" })).pid, "SIGTERM"));
	const events = new Map();
	let reports = 0;
	createReporter({ on: (event, handler) => events.set(event, handler), getSessionName: () => undefined }, {
		treeIdle: () => true,
		liveWork: () => { reports++; return 0; },
		browsing: () => false,
	});
	// Like Pi's, a context throws once its extension is reloaded; the first one also fails the end frame.
	const context = (sessionManager) => ({
		cwd: home,
		stale: false,
		failing: false,
		get sessionManager() {
			if (this.stale) throw new Error("stale ctx");
			if (this.failing) throw new Error("end frame failed");
			return sessionManager;
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
	});
	const first = context(pi.SessionManager.create(home, join(home, "sessions")));
	events.get("session_start")({}, first);
	await until(() => reports > 0, "the first report");
	events.get("agent_start")();
	first.failing = true;
	await assert.rejects(events.get("session_shutdown")(), /end frame failed/);
	first.stale = true;
	treeChanged();
	const before = reports;
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(reports, before);

	events.get("session_start")({}, context(pi.SessionManager.create(home, join(home, "sessions"))));
	await until(() => reports > before, "a report after the next start");
});

/** Starts a root runtime on `manager` whose Session holds the messages `inSession` names. */
async function startRuntime(t, manager, receive, inSession = () => []) {
	const events = new Map();
	const runtime = createRootRuntime({ on: (event, handler) => events.set(event, handler), getSessionName: () => undefined }, {
		receivedIds: inSession,
		treeIdle: () => true,
		receive,
	});
	t.after(() => runtime.stop());
	await runtime.start({
		cwd: home, sessionManager: manager, model: { provider: "test", id: "fake" },
		isIdle: () => true, hasPendingMessages: () => false, isProjectTrusted: () => true,
	});
	events.get("resources_discover")();
	return { runtime, events };
}

test("an accepted message survives the recipient's exit and enters its Session once", async (t) => {
	const manager = pi.SessionManager.create(home, join(home, "sessions"));
	const id = manager.getSessionId();
	const mailboxFile = join(statePaths().state, "mailboxes", `${id}.json`);
	const inboxIds = () => JSON.parse(readFileSync(mailboxFile, "utf8")).inbox.map((message) => message.id);
	const socket = statePaths().session(id);
	const message = (name) => ({ id: name, sender: { id: "sender" }, recipient: id, body: name });
	const first = await startRuntime(t, manager, () => {});
	for (const name of ["queued", "entered"]) await request(socket, { action: "deliver", message: message(name) });
	assert.deepEqual(inboxIds(), ["queued", "entered"]);
	// It exits before its turn takes either message in.
	await first.runtime.stop();

	const received = [];
	const inSession = ["entered"];
	const second = await startRuntime(t, manager, (delivered) => { received.push(delivered.id); }, () => inSession);
	await until(() => received.length > 0, "redelivery");
	// Until Pi writes the Session file, its entries are only in memory.
	assert.deepEqual(inboxIds(), ["queued", "entered"]);
	manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	second.events.get("agent_end")();
	assert.deepEqual(inboxIds(), ["queued"]);
	assert.deepEqual(await request(socket, { action: "deliver", message: message("queued") }), { accepted: true, messageId: "queued" });
	assert.deepEqual(received, ["queued"]);
	inSession.push("queued");
	second.events.get("agent_end")();
	assert.equal(existsSync(mailboxFile), false);
});

test("a send whose delivery is uncertain is sent again once with the same message ID", async (t) => {
	const { listen } = await import("../src/roots/transport.mjs");
	const target = "uncertain-recipient";
	const ids = [];
	const server = await listen(statePaths().session(target), {
		status: () => ({}),
		accept: (message) => {
			ids.push(message.id);
			if (ids.length === 1) throw Object.assign(new Error("Acknowledgement lost"), { code: "ETIMEDOUT", uncertainDelivery: true });
			return { accepted: true, messageId: message.id };
		},
	});
	t.after(() => server.close());
	const { runtime } = await startRuntime(t, pi.SessionManager.create(home, join(home, "sessions")), () => {});
	await runtime.send({ id: target, label: target }, "write", "hello");
	assert.equal(ids.length, 2);
	assert.equal(ids[0], ids[1]);
});
