import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const agentDir = mkdtempSync(join(tmpdir(), "pi-agents-home-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { pi, PI_PACKAGE } = await import("./pi.mjs");
const ai = await import(join(PI_PACKAGE, "node_modules/@earendil-works/pi-ai/dist/index.js"));

const textOf = (content) => typeof content === "string"
	? content
	: content.filter((block) => block.type === "text").map((block) => block.text).join("");

/**
 * A root Session whose model calls `program` with the arguments of each `call`, and otherwise
 * records the message and answers "noted". Programs call tools only within the agent loop.
 */
async function startRoot(cwd = mkdtempSync(join(tmpdir(), "pi-agents-cwd-")), sessionFile = undefined) {
	writeFileSync(join(cwd, "note.txt"), "note");
	const messages = [];
	const pending = [];
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "model" }], tokensPerSecond: 0 });
	faux.setResponses(Array.from({ length: 100 }, () => (context) => {
		const last = context.messages.at(-1);
		if (last?.role === "user" && textOf(last.content) === "call") return ai.fauxAssistantMessage(ai.fauxToolCall("program", pending.shift()));
		if (last?.role !== "toolResult") messages.push(textOf(last?.content ?? ""));
		return ai.fauxAssistantMessage("noted");
	}));
	const modelRuntime = await pi.ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null });
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const resourceLoader = new pi.DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true,
		additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))],
	});
	await resourceLoader.reload();
	const sessionManager = sessionFile ? pi.SessionManager.open(sessionFile) : pi.SessionManager.create(cwd, join(cwd, "sessions"));
	const { session } = await pi.createAgentSession({
		cwd, agentDir, settingsManager, resourceLoader, sessionManager, modelRuntime, model: faux.getModel(), tools: ["read", "program"],
	});
	await session.bindExtensions({ mode: "print" });
	const call = async (args) => {
		await session.waitForIdle();
		pending.push(args);
		await session.prompt("call");
		const result = session.messages.findLast((message) => message.role === "toolResult");
		return { content: result.content, isError: result.isError || undefined };
	};
	const text = async (args) => {
		const result = await call(args);
		if (result.isError && !/^Script failed/.test(textOf(result.content))) throw new Error(textOf(result.content));
		return textOf(result.content);
	};
	const close = async () => {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	};
	return { cwd, session, sessionManager, call, text, messages, close };
}

const idOf = (text) => /^Program (\S+) started\.$/.exec(text)[1];

test("a foreground Program calls the caller's tools except program and keeps store writes only when it completes", async () => {
	const root = await startRoot();
	const completed = await root.call({ action: "run", code: "const note = await tools.read({ path: 'note.txt' }); store('note', note); return [typeof tools.program, note]" });
	assert.equal(completed.isError, undefined, textOf(completed.content));
	assert.match(textOf(completed.content), /^Script completed\nWall time [\d.]+ seconds\nOutput:\n\["undefined","note"\]$/);
	const failed = await root.call({ action: "run", code: "store('lost', 1); throw new Error('boom')" });
	assert.equal(failed.isError, true);
	assert.match(textOf(failed.content), /^Script failed\n[\s\S]*Error: boom/);
	assert.match(await root.text({ action: "run", code: "return [load('note'), load('lost') ?? null]" }), /\["note",null\]$/);
	await root.close();
});

test("a background Program runs on after run returns, notifies its caller, and wait returns its result once", async () => {
	const root = await startRoot();
	const id = idOf(await root.text({ action: "run", background: true, code: "await tools.read({ path: 'note.txt' }); return 'done'" }));
	const deadline = Date.now() + 10000;
	while (!root.messages.includes(`Program ${id} completed.`) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(root.messages.includes(`Program ${id} completed.`), root.messages.join("\n"));
	assert.match(await root.text({ action: "wait", timeout: 10 }), /^Script completed\n[\s\S]*Output:\ndone$/);
	assert.equal(await root.text({ action: "wait", timeout: 10 }), "No results.");
	assert.match(await root.text({ action: "list" }), new RegExp(`^${id}  completed  \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d$`));
	await root.close();
});

test("stop and timeout stop background Programs", async () => {
	const root = await startRoot();
	const loop = "while (true) await tools.read({ path: 'note.txt' })";
	const stopped = idOf(await root.text({ action: "run", background: true, code: loop }));
	const timedOut = idOf(await root.text({ action: "run", background: true, code: loop, timeout: 0.2 }));
	assert.equal(await root.text({ action: "stop", target: stopped }), `Program ${stopped} stopped.`);
	assert.equal(await root.text({ action: "stop", target: stopped }), `Program ${stopped} has already ended.`);
	const results = await root.text({ action: "wait", target: [stopped, timedOut], timeout: 10 });
	assert.match(results, new RegExp(`<program-result id="${stopped}" status="stopped">\\n[\\s\\S]*Script aborted: Program stopped[\\s\\S]*?</program-result>`));
	assert.match(results, new RegExp(`<program-result id="${timedOut}" status="stopped">\\n[\\s\\S]*Script timed out`));
	await assert.rejects(root.text({ action: "stop", target: "missing" }), /No Program matches "missing"\. Use list to find Programs\./);
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
