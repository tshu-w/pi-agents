import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { pruneLocks, reserve } from "../src/roots/locks.mjs";

const dir = mkdtempSync("/tmp/pa-locks-");
after(() => rmSync(dir, { recursive: true, force: true }));
const locks = () => readdirSync(dir).filter((name) => name.endsWith(".lock"));
const file = join(dir, "2026-01-01T00-00-00-000Z_lock-a.jsonl");

async function holder() {
	const locksModule = new URL("../src/roots/locks.mjs", import.meta.url).href;
	const child = spawn(process.execPath, ["--input-type=module", "-e",
		`const { reserve } = await import(${JSON.stringify(locksModule)}); reserve(${JSON.stringify(dir)}, ${JSON.stringify(file)}, "lock-a"); console.log("held"); setInterval(() => {}, 1000);`,
	], { stdio: ["ignore", "pipe", "inherit"] });
	await new Promise((resolve) => child.stdout.once("data", resolve));
	return child;
}

async function kill(child) {
	child.kill("SIGKILL");
	await new Promise((resolve) => child.once("exit", resolve));
}

test("lock files go away on release, and those of a killed holder once pruned", async () => {
	reserve(dir, file, "lock-a").release();
	assert.deepEqual(locks(), []);

	const child = await holder();
	pruneLocks(dir);
	assert.equal(locks().length, 2);
	assert.throws(() => reserve(dir, file, "lock-a"), { code: "SESSION_OCCUPIED" });
	await kill(child);
	pruneLocks(dir);
	assert.deepEqual(readdirSync(dir), []);
});

test("a killed holder's locks are taken over at once, as are locks whose PID another process reused", async () => {
	await kill(await holder());
	reserve(dir, file, "lock-a").release();
	assert.deepEqual(locks(), []);

	const child = await holder();
	try {
		for (const name of locks()) renameSync(join(dir, name), join(dir, name.replace(/-\d+\.lock$/, "-1.lock")));
		reserve(dir, file, "lock-a").release();
		assert.deepEqual(locks(), []);
	} finally { await kill(child); }
});

test("a process that replaces itself with execve takes over the locks its previous image left", async () => {
	const locksModule = JSON.stringify(new URL("../src/roots/locks.mjs", import.meta.url).href);
	const other = join(dir, "2026-01-01T00-00-00-000Z_lock-b.jsonl");
	// A second lock directory where the previous image held the same Session.
	const second = mkdtempSync("/tmp/pa-locks-");
	const next = `const { reserve } = await import(${locksModule});
		try { reserve(${JSON.stringify(dir)}, ${JSON.stringify(file)}, "lock-a"); reserve(${JSON.stringify(second)}, ${JSON.stringify(file)}, "lock-a"); console.log("held"); }
		catch (error) { console.log(error.code); }
		setInterval(() => {}, 1000);`;
	// The first image holds two Sessions' locks and replaces itself without releasing them, as Pi's restart does.
	const child = spawn(process.execPath, ["--input-type=module", "-e", `const { reserve } = await import(${locksModule});
		reserve(${JSON.stringify(dir)}, ${JSON.stringify(file)}, "lock-a");
		reserve(${JSON.stringify(dir)}, ${JSON.stringify(other)}, "lock-b");
		reserve(${JSON.stringify(second)}, ${JSON.stringify(file)}, "lock-a");
		process.execve(process.execPath, [process.execPath, "--input-type=module", "-e", ${JSON.stringify(next)}]);`,
	], { stdio: ["ignore", "pipe", "inherit"] });
	try {
		const output = await new Promise((resolve) => child.stdout.once("data", resolve));
		assert.equal(String(output).trim(), "held");
		reserve(dir, other, "lock-b").release();
	} finally { await kill(child); }
	pruneLocks(dir);
	pruneLocks(second);
	assert.deepEqual([...locks(), ...readdirSync(second)], []);
	rmSync(second, { recursive: true });
});

test("an image clears its previous image's locks without dropping the ones it holds", async () => {
	const locksModule = new URL("../src/roots/locks.mjs", import.meta.url).href;
	const session = (name) => JSON.stringify(join(dir, `2026-01-01T00-00-00-000Z_${name}.jsonl`));
	const child = spawn(process.execPath, ["--input-type=module", "-e", `
		import { readdirSync, realpathSync } from "node:fs";
		const count = () => readdirSync(${JSON.stringify(dir)}).filter((name) => name.endsWith(".lock")).length;
		const first = await import(${JSON.stringify(`${locksModule}?first`)});
		first.reserve(${JSON.stringify(dir)}, ${session("lock-a")}, "lock-a");
		// A copy loaded by /reload whose earlier copy cleared nothing, as before this cleanup existed.
		delete globalThis[Symbol.for("pi-agents.cleared-lock-dirs")];
		const next = await import(${JSON.stringify(`${locksModule}?next`)});
		next.reserve(${JSON.stringify(dir)}, ${session("lock-b")}, "lock-b");
		const reloaded = count();
		// The same directory through a symlinked ancestor.
		next.reserve(realpathSync(${JSON.stringify(dir)}), ${session("lock-c")}, "lock-c");
		console.log(reloaded, count());`,
	], { stdio: ["ignore", "pipe", "inherit"] });
	const output = await new Promise((resolve) => child.stdout.once("data", resolve));
	await new Promise((resolve) => child.once("exit", resolve));
	assert.equal(String(output).trim(), "4 6");
	pruneLocks(dir);
	assert.deepEqual(locks(), []);
});

test("contenders and a pruner never let two processes hold a lock at once", async () => {
	const locksModule = new URL("../src/roots/locks.mjs", import.meta.url).href;
	const log = join(dir, "log");
	const run = (loop) => new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", `
			import { appendFileSync } from "node:fs";
			const { pruneLocks, reserve } = await import(${JSON.stringify(locksModule)});
			const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
			// Slow process/ps startup must not consume the whole contention window before any acquisition.
			let completed = 0;
			for (const end = Date.now() + 1500; Date.now() < end || completed === 0;) { ${loop}; completed++; }
		`], { stdio: "inherit" });
		child.once("exit", (status) => status === 0 ? resolve() : reject(new Error(`Exited with ${status}`)));
	});
	const contend = `
		let lock;
		try { lock = reserve(${JSON.stringify(dir)}, ${JSON.stringify(file)}, "lock-a"); }
		// Avoid keeping all six contenders in the same retry rhythm on a busy runner.
		catch (error) { if (error.code !== "SESSION_OCCUPIED") throw error; pause(25 + Math.random() * 100); continue; }
		appendFileSync(${JSON.stringify(log)}, "+");
		pause(5);
		appendFileSync(${JSON.stringify(log)}, "-");
		lock.release();
	`;
	await Promise.all([...Array.from({ length: 6 }, () => run(contend)), run(`pruneLocks(${JSON.stringify(dir)}); pause(5);`)]);
	const events = readFileSync(log, "utf8");
	assert.match(events, /^(\+-)+$/);
	assert.ok(events.length >= 12, "each of the six contenders acquired the lock at least once");
	rmSync(log);
});
