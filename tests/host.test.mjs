import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const require = createRequire(import.meta.url);
const pty = require("@lydell/node-pty");
const { Terminal } = require("@xterm/headless");

const home = mkdtempSync("/tmp/pa-host-");
const agentDir = join(home, "agent");
mkdirSync(agentDir);
const model = fileURLToPath(new URL("./fixtures/model.ts", import.meta.url));
const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const dialog = fileURLToPath(new URL("./fixtures/dialog-extension.mjs", import.meta.url));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [model, extension, dialog], defaultProvider: "agents-test", defaultModel: "fake", quietStartup: true }));
// Pi in the host runs 100 times faster, so its 10 minute idle limit takes 6 seconds.
const clock = join(home, "clock.mjs");
writeFileSync(clock, `if (process.env.PI_AGENTS_HOST) {
  const now = Date.now, start = now();
  Date.now = () => start + (now() - start) * 100;
  const interval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms / 100, ...args);
}`);
Object.assign(process.env, {
	PI_CODING_AGENT_DIR: agentDir,
	PI_AGENTS_STATE_DIR: join(home, "state"),
	PI_OFFLINE: "1",
	PI_SKIP_VERSION_CHECK: "1",
	PI_TELEMETRY: "0",
	NODE_OPTIONS: `--import=${clock}`,
	TERM: "xterm-256color",
	AGENTS_TEST_RELEASE: join(home, "release"),
});
const { until, PI_PACKAGE } = await import("./pi.mjs");
const { statePaths } = await import("../src/roots/paths.mjs");
const { listHosts } = await import("../src/host/client.mjs");
const { request } = await import("../src/roots/transport.mjs");
const paths = statePaths();
const client = fileURLToPath(new URL("../bin/pd.mjs", import.meta.url));

/** Runs the `pi` client in a terminal of its own. */
function terminal(args, env = process.env) {
	const [cols, rows] = [100, 30];
	const screen = new Terminal({ cols, rows, allowProposedApi: true });
	const child = pty.spawn(process.execPath, [client, ...args], { cols, rows, cwd: home, env });
	let output = "";
	child.onData((data) => { output += data; screen.write(data); });
	// The terminal answers what Pi asks of it.
	screen.onData((data) => child.write(data));
	const exited = new Promise((resolve) => child.onExit(resolve));
	const text = () => {
		const buffer = screen.buffer.active;
		return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? "").join("\n");
	};
	return { child, exited, text, output: () => output };
}

after(async () => {
	for (const host of await listHosts(paths)) process.kill(host.pid, "SIGTERM");
	try { process.kill((await request(paths.daemon, { action: "status" }, { timeoutMs: 1000 })).pid, "SIGTERM"); }
	catch { /* the daemon did not start */ }
	rmSync(home, { recursive: true, force: true });
});

test("Pi keeps running in its host when another terminal takes over or the terminal detaches, and exits once idle and detached", async () => {
	const opener = terminal([]);
	const host = await until(async () => (await listHosts(paths)).find((entry) => entry.session), "host");
	// Opening the Session by its ID takes it over, before it has a file and after.
	const first = terminal(["--session-id", host.session.id]);
	assert.equal((await opener.exited).exitCode, 0);
	first.child.write("hello");
	await until(() => first.text().includes("hello"), "typed");
	first.child.write("\r");
	await until(() => first.text().includes("answer:hello"), "answer");

	// A message given to a running Session reaches it, and the terminal attaches before the message is accepted.
	const second = terminal(["--session-id", host.session.id, "gate again"]);
	assert.equal((await first.exited).exitCode, 0);
	assert.match(stripVTControlCharacters(first.output()), /Attached in another terminal\.\r?\nPi keeps running\. To reattach: pd attach \S+/);
	await until(() => second.text().includes("answer:hello"), "restored screen");
	writeFileSync(`${process.env.AGENTS_TEST_RELEASE}-gate`, "");
	await until(() => second.text().includes("answer:gate again"), "answer to the message");
	assert.ok(!second.output().includes("without applying"));

	// An attached host outlives the idle limit.
	await delay(7000);
	assert.deepEqual((await listHosts(paths)).map((entry) => entry.pid), [host.pid]);

	// The detach key works while a dialog has the keyboard.
	second.child.write("/settings\r");
	await until(() => second.text().includes("Auto-compact"), "settings dialog");
	second.child.write("\x1a");
	assert.equal((await second.exited).exitCode, 0);
	assert.match(stripVTControlCharacters(second.output()), /Pi keeps running\. To reattach: pd attach \S+/);
	await until(async () => (await listHosts(paths)).length === 0, "idle exit", 15000);
});

test("a message given to a running Session reaches Pi only once the terminal is attached", async () => {
	const opener = terminal([]);
	const host = await until(async () => (await listHosts(paths)).find((entry) => entry.session), "host");
	opener.child.write("\x1a");
	assert.equal((await opener.exited).exitCode, 0);
	// The host pauses as the terminal connects, so a message sent then would find no terminal for its dialog.
	const pause = join(home, "pause.mjs");
	writeFileSync(pause, `const setRawMode = process.stdin.setRawMode;
process.stdin.setRawMode = function (mode) {
  if (mode) {
    process.kill(${host.pid}, "SIGSTOP");
    setTimeout(() => process.kill(${host.pid}, "SIGCONT"), 1000);
  }
  return setRawMode.call(this, mode);
};`);
	const asking = terminal(["--session-id", host.session.id, "/ask"], { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS} --import=${pause}` });
	await until(() => asking.text().includes("Proceed?"), "the dialog");
	asking.child.write("\x1a");
	assert.equal((await asking.exited).exitCode, 0);
	process.kill(host.pid, "SIGTERM");
	await until(async () => (await listHosts(paths)).length === 0, "host exit");
});

test("pd groups arguments as Pi reads them, so an option's value is never taken for an option", async () => {
	const { argGroups } = await import("../src/host/rpc-client.mjs");
	const { parseArgs } = await import(join(PI_PACKAGE, "dist/cli/args.js"));
	// `--thinking` takes `-p` and reports it as an invalid level.
	assert.deepEqual(argGroups(parseArgs, ["--thinking", "-p", "hello", "--append-system-prompt", "-c", "-p", "-c", "--", "-c"]),
		[["--thinking", "-p"], ["hello"], ["--append-system-prompt", "-c"], ["-p"], ["-c"], ["--", "-c"]]);
});

test("a terminal attaching to a background host gets Pi's startup queries and status, even when split across chunks", async () => {
	const { startHost } = await import("../src/host/client.mjs");
	const { FRAME, frame, readFrames } = await import("../src/host/frames.mjs");
	const net = await import("node:net");
	const script = join(home, "split.mjs");
	writeFileSync(script, `for (const text of ${JSON.stringify(["\x1b[?", "u\x1b]7501;state=working\x1b\\", "\x1b]7501;state=", "clear\x1b\\\x1b]7501;state=bl", "ocked\x1b\\"])}) {
		process.stdout.write(text);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	setInterval(() => {}, 1000);`);
	const socket = await startHost(paths, { pi: process.execPath, args: [script], cwd: home, env: { ...process.env, NODE_OPTIONS: "" } });
	await delay(800);
	const connection = net.connect(socket);
	let output = "";
	readFrames(connection, (type, body) => { if (type === FRAME.data) output += body.toString(); });
	connection.write(frame(FRAME.attach, { cols: 80, rows: 24 }));
	await until(() => output.includes("\x1b[?u"), "the replayed query");
	assert.ok(output.includes("\x1b]7501;state=blocked\x1b\\"));
	assert.ok(!output.includes("state=working"));
	connection.destroy();
	process.kill(Number(/h-(\d+)\.sock$/.exec(socket)[1]), "SIGTERM");
});

/** Runs `pd args` in `cwd` with `input` piped to it. */
function run(args, input = "", cwd = home) {
	const child = spawn(process.execPath, [client, ...args], { cwd, env: process.env });
	let stdout = "", stderr = "";
	child.stdout.on("data", (data) => { stdout += data; });
	child.stderr.on("data", (data) => { stderr += data; });
	child.stdin.end(input);
	return new Promise((resolve) => child.on("exit", (code) => resolve({ code, stdout, stderr })));
}

/** Runs `pd --mode rpc args`. */
function rpc(args) {
	const child = spawn(process.execPath, [client, "--mode", "rpc", ...args], { cwd: home, env: process.env, stdio: ["pipe", "pipe", "inherit"] });
	const records = [];
	let buffer = "";
	child.stdout.on("data", (data) => {
		buffer += data;
		for (let at; (at = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(at + 1)) records.push(JSON.parse(buffer.slice(0, at)));
	});
	let id = 0;
	return {
		records,
		find: (check, label) => until(() => records.find(check), label),
		async call(command) {
			const request = { id: `r${++id}`, ...command };
			child.stdin.write(`${JSON.stringify(request)}\n`);
			return until(() => records.find((record) => record.type === "response" && record.id === request.id), command.type);
		},
		end() {
			child.stdin.end();
			return new Promise((resolve) => child.on("exit", resolve));
		},
	};
}

const answered = (records, text) => records.some((record) => record.type === "message_end" && record.message.content[0]?.text === text);
const notified = (message) => (record) => record.type === "extension_ui_request" && record.message === message;

test("-p and --mode json run on the Session in a host, beside the attached terminal", async () => {
	const printed = await run(["-p", "hello"]);
	assert.deepEqual(printed, { code: 0, stdout: "answer:hello\n", stderr: "" });
	const host = (await listHosts(paths)).find((entry) => entry.session);
	assert.equal(host.attached, false);

	const screen = terminal(["attach", host.session.id]);
	await until(() => screen.text().includes("answer:hello"), "attached");
	const json = await run(["--mode", "json", "-c"], "again\n");
	assert.equal(json.code, 0);
	const records = json.stdout.trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(records[0].type, "session");
	assert.equal(records[0].id, host.session.id);
	assert.ok(answered(records, "answer:again"));
	await until(() => screen.text().includes("answer:again"), "the terminal shows the prompt");

	screen.child.write("\x1a");
	assert.equal((await screen.exited).exitCode, 0);
	process.kill(host.pid, "SIGTERM");
	await until(async () => (await listHosts(paths)).length === 0, "host exit");
});

test("-c finds the Session running in a host when the project keeps Sessions in a relative directory", async () => {
	const project = join(home, "project");
	mkdirSync(join(project, ".pi"), { recursive: true });
	writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ sessionDir: "project-sessions" }));
	assert.deepEqual(await run(["--approve", "-p", "hello"], "", project), { code: 0, stdout: "answer:hello\n", stderr: "" });
	const host = (await listHosts(paths)).find((entry) => entry.session);
	assert.deepEqual(await run(["-p", "-c", "again"], "", project), { code: 0, stdout: "answer:again\n", stderr: "" });
	assert.deepEqual((await listHosts(paths)).map((entry) => entry.pid), [host.pid]);
	process.kill(host.pid, "SIGTERM");
	await until(async () => (await listHosts(paths)).length === 0, "host exit");
});

test("-p and --mode json run their own turns once the Session is idle, and a signal withdraws or stops them", async () => {
	const release = () => writeFileSync(process.env.AGENTS_TEST_RELEASE, "");
	const gate = () => writeFileSync(`${process.env.AGENTS_TEST_RELEASE}-gate`, "");
	const other = rpc([]);
	const { sessionFile, sessionId } = (await other.call({ type: "get_state" })).data;
	const start = (args) => {
		const child = spawn(process.execPath, [client, "--session", sessionFile, ...args], { cwd: home, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.on("data", (data) => { stdout += data; });
		child.stderr.on("data", (data) => { stderr += data; });
		const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
		return { child, exited, output: () => stdout + stderr, records: () => stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
	};
	const since = (at, check, label) => until(() => other.records.slice(at).find(check), label);
	const user = (text) => (record) => record.type === "message_end" && record.message.role === "user" && record.message.content[0]?.text === text;
	const reply = (reason) => (record) => record.type === "message_end" && record.message.role === "assistant" && record.message.stopReason === reason;

	// It waits for another client's turn without output, then outputs only its own turns.
	await other.call({ type: "prompt", message: "hold" });
	const json = start(["--mode", "json", "mine"]);
	await delay(1000);
	assert.equal(json.output(), "");
	release();
	assert.equal(await json.exited, 0);
	const records = json.records();
	assert.equal(records[0].type, "session");
	assert.ok(answered(records, "answer:mine"));
	assert.ok(!answered(records, "answer:hold"));
	assert.equal(records.filter((record) => record.type === "agent_settled").length, 1);
	assert.equal(records.at(-1).type, "agent_settled");

	// The turn an extension command starts is its own, even when its prompt is admitted after the command returns.
	const relayed = start(["--mode", "json", "/relay gate relayed"]);
	await delay(1000);
	assert.equal(relayed.child.exitCode, null);
	gate();
	assert.equal(await relayed.exited, 0);
	assert.ok(answered(relayed.records(), "answer:gate relayed"));

	// A signal stops its turn, including input another client added to it, with Pi's exit code.
	let at = other.records.length;
	const joined = start(["-p", "hold"]);
	await since(at, user("hold"), "its turn started");
	assert.equal((await other.call({ type: "steer", message: "hold" })).success, true);
	release();
	await since(at, reply("stop"), "the first reply");
	await until(() => other.records.slice(at).filter(user("hold")).length === 2, "the other client's input joined");
	joined.child.kill("SIGTERM");
	assert.equal(await joined.exited, 143);
	await since(at, reply("aborted"), "its turn stopped");

	// Input another client sent during its turn, which an input hook holds past the turn, starts a turn after it.
	at = other.records.length;
	const crossed = start(["--mode", "json", "hold"]);
	await since(at, user("hold"), "its turn started");
	const outside = other.call({ type: "prompt", message: "gate outside", streamingBehavior: "followUp" });
	await delay(300);
	release();
	assert.equal(await crossed.exited, 0);
	gate();
	assert.equal((await outside).success, true);
	await since(at, (record) => answered([record], "answer:gate outside"), "the other client's turn");
	assert.ok(answered(crossed.records(), "answer:hold"));

	// An Agent's message that arrives while its turn settles starts a turn after it, also after the turn that its
	// turn's extension starts then, which a signal stops.
	at = other.records.length;
	const pause = `${process.env.AGENTS_TEST_RELEASE}-pause`;
	writeFileSync(pause, "");
	writeFileSync(`${process.env.AGENTS_TEST_RELEASE}-chain`, "");
	const settling = start(["--mode", "json", "mine again"]);
	await since(at, (record) => answered([record], "answer:mine again"), "its reply");
	const message = { id: "outside-message", sender: { id: "sender" }, recipient: sessionId, body: "outside" };
	assert.equal((await request(paths.session(sessionId), { action: "deliver", message })).accepted, true);
	rmSync(pause);
	const chain = (record) => record.type === "message_end" && record.message.customType === "chain";
	await since(at, chain, "its chained turn started");
	settling.child.kill("SIGTERM");
	assert.equal(await settling.exited, 143);
	const outsider = (record) => record.type === "message_end" && record.message.role === "assistant" && record.message.content[0]?.text.includes("outside");
	assert.equal((await since(at, outsider, "the Agent's turn")).message.stopReason, "stop");
	assert.ok(settling.records().some(chain));
	assert.ok(!settling.records().some(outsider));

	// A signal also stops a turn that its turn's extension starts once it settles.
	at = other.records.length;
	writeFileSync(`${process.env.AGENTS_TEST_RELEASE}-chain`, "");
	const chained = start(["-p", "hold"]);
	await since(at, user("hold"), "its turn started");
	chained.child.kill("SIGTERM");
	assert.equal(await chained.exited, 143);
	// The model holds both turns until they are aborted.
	await until(() => other.records.slice(at).filter((record) => record.type === "agent_settled").length === 2, "both turns stopped");

	// While it waits for another client's turn, a signal withdraws its prompt and leaves that turn alone.
	at = other.records.length;
	await other.call({ type: "prompt", message: "hold" });
	const waiting = start(["-p", "later"]);
	await delay(1000);
	waiting.child.kill("SIGINT");
	assert.equal(await waiting.exited, 130);
	release();
	await since(at, (record) => record.type === "agent_settled", "the other turn finished");
	await delay(500);
	assert.ok(!other.records.slice(at).some(reply("aborted")));
	assert.ok(!other.records.slice(at).some(user("later")));

	// `/program` prints its output, or its error with status 1.
	writeFileSync(join(home, "ok.js"), "return 'program output'");
	writeFileSync(join(home, "fail.js"), "throw new Error('program failure')");
	const ok = start(["-p", "/program ok.js"]);
	assert.equal(await ok.exited, 0);
	assert.equal(ok.output(), "program output\n");
	// A failed run keeps status 1 when a reply follows it.
	const failed = start(["-p", "/program fail.js", "mine"]);
	assert.equal(await failed.exited, 1);
	assert.match(failed.output(), /answer:mine/);
	assert.match(failed.output(), /program failure/);
	assert.equal(await other.end(), 0);
	for (const host of await listHosts(paths)) process.kill(host.pid, "SIGTERM");
	await until(async () => (await listHosts(paths)).length === 0, "host exit");
});

test("RPC clients share a Session, dialogs wait only for an attached terminal, and fork moves only its caller", async () => {
	const first = rpc([]);
	const { sessionId, sessionFile } = (await first.call({ type: "get_state" })).data;
	const second = rpc(["--session", sessionFile]);
	assert.equal((await second.call({ type: "get_state" })).data.sessionId, sessionId);
	await first.call({ type: "prompt", message: "one" });
	await second.find((record) => answered([record], "answer:one"), "the other client sees the answer");

	// Without a terminal a dialog is cancelled at once; with one it waits, until the terminal detaches.
	await first.call({ type: "prompt", message: "/ask" });
	await second.find(notified("edited:undefined"), "cancelled dialog");
	const screen = terminal(["attach", sessionId]);
	await until(() => screen.text().includes("answer:one"), "attached");
	const asking = first.call({ type: "prompt", message: "/ask" });
	await until(() => screen.text().includes("Proceed?"), "dialog");
	assert.equal(second.records.filter(notified("edited:undefined")).length, 1);
	screen.child.write("\x1a");
	await screen.exited;
	await until(() => second.records.filter(notified("edited:undefined")).length === 2, "dialog cancelled on detach");
	await asking;

	// A host with an RPC client outlives the idle limit.
	const [host] = await listHosts(paths);
	await delay(7000);
	assert.deepEqual((await listHosts(paths)).map((entry) => entry.pid), [host.pid]);

	const { messages } = (await first.call({ type: "get_fork_messages" })).data;
	const fork = await first.call({ type: "fork", entryId: messages[0].entryId });
	assert.deepEqual(fork.data, { text: "one", cancelled: false });
	const forked = (await first.call({ type: "get_state" })).data;
	assert.notEqual(forked.sessionId, sessionId);
	assert.equal((await second.call({ type: "get_state" })).data.sessionId, sessionId);

	// A client whose host stops opens its Session again; a command sent as it stops fails instead of hanging.
	process.kill(host.pid, "SIGTERM");
	let state;
	do state = await second.call({ type: "get_state" }); while (!state.success && state.error === "The Session stopped.");
	const reopened = state.data;
	assert.equal(reopened.sessionId, sessionId);
	assert.ok(reopened.messageCount > 0);

	assert.equal(await first.end(), 0);
	assert.equal(await second.end(), 0);
	await until(async () => (await listHosts(paths)).length === 0, "idle exit without clients", 15000);
});
