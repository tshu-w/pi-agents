import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pty = require("@lydell/node-pty");
const { Terminal } = require("@xterm/headless");

const home = mkdtempSync("/tmp/pa-host-");
const agentDir = join(home, "agent");
mkdirSync(agentDir);
const model = fileURLToPath(new URL("./fixtures/model.ts", import.meta.url));
const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [model, extension], defaultProvider: "agents-test", defaultModel: "fake", quietStartup: true }));
// Pi in the host runs 100 times faster, so its 5 minute idle limit takes 3 seconds.
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
});
const { until } = await import("./pi.mjs");
const { statePaths } = await import("../src/roots/paths.mjs");
const { listHosts } = await import("../src/host/client.mjs");
const { request } = await import("../src/roots/transport.mjs");
const paths = statePaths();
const client = fileURLToPath(new URL("../bin/pd.mjs", import.meta.url));

/** Runs the `pi` client in a terminal of its own. */
function terminal(args) {
	const [cols, rows] = [100, 30];
	const screen = new Terminal({ cols, rows, allowProposedApi: true });
	const child = pty.spawn(process.execPath, [client, ...args], { cols, rows, cwd: home, env: process.env });
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
	const first = terminal([]);
	const host = await until(async () => (await listHosts(paths)).find((entry) => entry.session), "host");
	first.child.write("hello");
	await until(() => first.text().includes("hello"), "typed");
	first.child.write("\r");
	await until(() => first.text().includes("answer:hello"), "answer");

	const second = terminal(["attach", host.session.id.slice(0, 8)]);
	assert.equal((await first.exited).exitCode, 0);
	assert.match(first.output(), /Attached in another terminal\.\r?\nPi keeps running\. To reattach, run pd attach \S+/);
	await until(() => second.text().includes("answer:hello"), "restored screen");

	// An attached host outlives the idle limit.
	await delay(4000);
	assert.deepEqual((await listHosts(paths)).map((entry) => entry.pid), [host.pid]);

	// The detach key works while a dialog has the keyboard.
	second.child.write("/settings\r");
	await until(() => second.text().includes("Auto-compact"), "settings dialog");
	second.child.write("\x1a");
	assert.equal((await second.exited).exitCode, 0);
	assert.match(second.output(), /Pi keeps running\. To reattach, run pd attach \S+/);
	await until(async () => (await listHosts(paths)).length === 0, "idle exit", 15000);
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
