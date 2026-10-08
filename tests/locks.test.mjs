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

test("contenders and a pruner never let two processes hold a lock at once", async () => {
	const locksModule = new URL("../src/roots/locks.mjs", import.meta.url).href;
	const log = join(dir, "log");
	const run = (loop) => new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", `
			import { appendFileSync } from "node:fs";
			const { pruneLocks, reserve } = await import(${JSON.stringify(locksModule)});
			const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
			for (const end = Date.now() + 1500; Date.now() < end;) { ${loop} }
		`], { stdio: "inherit" });
		child.once("exit", (status) => status === 0 ? resolve() : reject(new Error(`Exited with ${status}`)));
	});
	const contend = `
		let lock;
		try { lock = reserve(${JSON.stringify(dir)}, ${JSON.stringify(file)}, "lock-a"); }
		catch (error) { if (error.code !== "SESSION_OCCUPIED") throw error; pause(1); continue; }
		appendFileSync(${JSON.stringify(log)}, "+");
		pause(5);
		appendFileSync(${JSON.stringify(log)}, "-");
		lock.release();
	`;
	await Promise.all([...Array.from({ length: 6 }, () => run(contend)), run(`pruneLocks(${JSON.stringify(dir)});`)]);
	assert.match(readFileSync(log, "utf8"), /^(\+-)+$/);
	rmSync(log);
});
