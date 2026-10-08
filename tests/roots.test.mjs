import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// Everything a background Worker needs is inherited through the environment.
const home = mkdtempSync("/tmp/pa-roots-");
const agentDir = join(home, "agent");
const sessionRoot = join(agentDir, "sessions");
const model = fileURLToPath(new URL("./fixtures/model.ts", import.meta.url));
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [model] }));
Object.assign(process.env, {
	PI_CODING_AGENT_DIR: agentDir,
	PI_AGENTS_STATE_DIR: join(home, "state"),
	PI_OFFLINE: "1",
	PI_SKIP_VERSION_CHECK: "1",
	PI_TELEMETRY: "0",
});
const { pi, PI_PACKAGE, EXTENSION: extension, textOf, until } = await import("./pi.mjs");
const { rootPaths } = await import("../src/roots/paths.mjs");
const { request } = await import("../src/roots/transport.mjs");
const { reserve } = await import("../src/roots/ownership.mjs");
const { default: ownershipExtension } = await import("../src/roots/ownership-extension.mjs");
const paths = rootPaths();
const cli = join(PI_PACKAGE, "dist/bundle/cli.js");

const entriesOf = (file) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));

/** Writes a root Session that is not loaded anywhere. */
function offlineRoot(id, name) {
	const cwd = mkdtempSync(join(home, "cwd-"));
	const dir = join(sessionRoot, `--${id}--`);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${id}.jsonl`);
	const timestamp = new Date().toISOString();
	writeFileSync(file, [
		{ type: "session", version: 3, id, cwd, timestamp },
		{ type: "model_change", id: "m", parentId: null, provider: "agents-test", modelId: "fake", timestamp },
		{ type: "session_info", id: "n", parentId: "m", name, timestamp },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return { id, cwd, file };
}

const children = [];
function runPi(args, cwd) {
	const child = spawn(process.execPath, [cli, "--mode", "rpc", "-e", extension, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
	let output = "";
	child.stdout.setEncoding("utf8").on("data", (text) => { output += text; });
	child.stderr.setEncoding("utf8").on("data", (text) => { output += text; });
	const exited = new Promise((resolve) => child.once("exit", resolve));
	children.push(child);
	return { child, exited, output: () => output };
}

/** A root Agent in this process that calls the `agent` tool directly. */
async function startRoot() {
	const cwd = mkdtempSync(join(home, "cwd-"));
	const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, additionalExtensionPaths: [extension, model] });
	await resourceLoader.reload();
	const sessionManager = pi.SessionManager.create(cwd, join(sessionRoot, "--sender--"));
	const { session } = await pi.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager, tools: ["agent"] });
	await session.setModel(session.modelRuntime.getModel("agents-test", "fake"));
	await session.bindExtensions({ mode: "print" });
	sessionManager.appendSessionInfo("sender");
	const tool = session.getToolDefinition("agent");
	let calls = 0;
	const call = async (args) => {
		const id = `test-${++calls}`;
		const signal = new AbortController().signal;
		const result = await tool.execute(id, args, signal, undefined, session.extensionRunner.createToolContext(id, signal));
		return textOf(result.content);
	};
	return { session, sessionManager, call };
}

const sender = await startRoot();

after(async () => {
	for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	try {
		const supervisor = await request(paths.supervisor, { action: "status" }, { timeoutMs: 1000 });
		process.kill(supervisor.pid, "SIGTERM");
	} catch { /* the Supervisor did not start */ }
	await sender.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	sender.session.dispose();
	rmSync(home, { recursive: true, force: true });
});

test("an input restores the offline root's active branch, which answers and exits", async () => {
	const target = offlineRoot("offline-a", "reviewer");
	const timestamp = new Date().toISOString();
	appendFileSync(target.file, [
		{ type: "model_change", id: "abandoned", parentId: "n", provider: "unavailable", modelId: "missing", timestamp },
		{ type: "session_info", id: "active", parentId: "n", name: "reviewer", timestamp },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	assert.match(await sender.call({ action: "list", query: "reviewer" }), /reviewer \(offline-\)\s+idle/);
	assert.equal(await sender.call({ action: "send", target: "reviewer", message: "hello" }), "Input accepted by reviewer (offline-).");
	const answered = await until(() => entriesOf(target.file).find((entry) => entry.type === "message" && entry.message.role === "assistant"), "answer");
	assert.match(textOf(answered.message.content), /^answer:<agent-message from="sender" id="\S+" note="Reply with send">\nhello\n<\/agent-message>$/);
	// The Worker gives up the Session once it exits.
	await until(() => {
		try {
			reserve(paths.ownership, target.file, target.id).release();
			return true;
		} catch (error) {
			if (error.code !== "SESSION_OCCUPIED") throw error;
		}
	}, "worker exit");
	assert.equal(existsSync(paths.worker(target.id)), false);
});

test("a root whose Session another process holds without answering is busy", async () => {
	const target = offlineRoot("held-d", "held");
	const ownership = new URL("../src/roots/ownership.mjs", import.meta.url).href;
	const holder = spawn(process.execPath, ["--input-type=module", "-e",
		`const { reserve } = await import(${JSON.stringify(ownership)}); reserve(${JSON.stringify(paths.ownership)}, ${JSON.stringify(target.file)}, "held-d"); console.log("held"); setInterval(() => {}, 1000);`,
	], { stdio: ["ignore", "pipe", "inherit"] });
	children.push(holder);
	await new Promise((resolve) => holder.stdout.once("data", resolve));
	assert.match(await sender.call({ action: "list", query: "held" }), /held \(held-d\)\s+running/);
	holder.kill("SIGKILL");
	await new Promise((resolve) => holder.once("exit", resolve));
	assert.match(await sender.call({ action: "list", query: "held" }), /held \(held-d\)\s+idle/);
});

test("a write to an offline root is rejected and does not wake it", async () => {
	const target = offlineRoot("offline-w", "dormant");
	await assert.rejects(sender.call({ action: "send", target: "dormant", message: "note", deliverAs: "write" }), /dormant \(\S+\) is offline\./);
	reserve(paths.ownership, target.file, target.id).release();
	assert.equal(existsSync(paths.worker(target.id)), false);
	assert.equal(entriesOf(target.file).length, 3);
});

test("a root in another process is listed with its state and cannot be opened twice", async () => {
	const target = offlineRoot("live-c", "live");
	const first = runPi(["--session", target.file], target.cwd);
	await until(async () => {
		try { return (await request(paths.worker(target.id), { action: "status" }, { timeoutMs: 1000 })).ready; }
		catch (error) { if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error; }
	}, "live root");
	assert.match(await sender.call({ action: "list", query: "live" }), /live \(live-c\)\s+idle/);

	const second = runPi(["--session", target.file], target.cwd);
	await second.exited;
	assert.match(second.output(), /\[pi-agents\] Session live-c is in use \(PID \d+\)\. Quit the other Pi instance\./);
	assert.equal(first.child.exitCode, null);

	const handlers = new Map();
	ownershipExtension({ on: (event, handler) => handlers.set(event, handler) });
	let dialog, dismiss;
	let shutdown = false;
	const opening = handlers.get("session_start")({ reason: "startup" }, {
		mode: "tui", hasUI: true,
		sessionManager: { getSessionFile: () => target.file, getSessionId: () => target.id },
		ui: {
			notify() {},
			select(title, options) {
				dialog = { title, options };
				return new Promise((resolve) => { dismiss = resolve; });
			},
		},
		shutdown() { shutdown = true; },
	});
	assert.match(dialog?.title ?? "", /\[pi-agents\] Session live-c is in use/);
	assert.deepEqual(dialog.options, ["Quit"]);
	assert.equal(shutdown, false);
	dismiss("Quit");
	await opening;
	assert.equal(shutdown, true);

	await sender.call({ action: "send", target: "live-c", message: "note", deliverAs: "write" });
	await until(() => entriesOf(target.file).some((entry) => entry.type === "custom_message" && sender.sessionManager.getSessionId().startsWith(/^<agent-message from="sender" id="(\S{8,})">\nnote\n<\/agent-message>$/.exec(entry.content)?.[1] ?? "-")), "write");
});
