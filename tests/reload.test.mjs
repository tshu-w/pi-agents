import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const agentDir = mkdtempSync(join(tmpdir(), "pi-agents-home-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
const { pi, ai, EXTENSION, textOf, until, notification, createSession } = await import("./pi.mjs");

// Its own file, so that no copy of pi-agents has patched Pi in this process before the test marks Pi as patched.
test("after /reload over a copy whose patches did not record Sessions, owned Agents still use their owner's MCP tools", async () => {
	// As an earlier copy leaves Pi after /reload: patched, by patches that do not record Sessions' runners.
	for (const proto of [pi.AgentSession.prototype, pi.ExtensionRunner.prototype]) proto[Symbol.for("pi-agents:patched")] = true;
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ "pi-agents": { extensions: [] } }));
	const cwd = mkdtempSync(join(agentDir, "cwd-"));
	const route = (context) => {
		const messages = context.messages;
		const last = messages.at(-1);
		if (!textOf(messages.find((message) => message.role === "user").content).startsWith("<agent-message ")) return ai.fauxAssistantMessage("noted");
		return last.role === "toolResult"
			? ai.fauxAssistantMessage(textOf(last.content))
			: ai.fauxAssistantMessage(ai.fauxToolCall("program", { action: "run", code: "return (await tools.mcp__alpha__shout({ text: 'hi' })).content[0].text" }));
	};
	const session = await createSession({
		cwd, route, sessionManager: pi.SessionManager.create(cwd, join(cwd, "sessions")), tools: ["+agent", "+program"],
		extensionFactories: [{ name: "mcp", builtin: true, factory: pi.createMcpExtension() }],
		extensions: ["builtin:mcp", EXTENSION, fileURLToPath(new URL("./fixtures/mcp-servers.mjs", import.meta.url))],
	});
	await session.bindExtensions({ mode: "print" });
	await until(() => session.getAllTools().some((tool) => tool.name === "mcp__alpha__shout"), "server connected");
	const signal = new AbortController().signal;
	await session.getToolDefinition("agent").execute("spawn", { action: "spawn", name: "worker", message: "shout" }, signal, undefined, session.extensionRunner.createToolContext("spawn", signal));
	assert.match(textOf((await notification(session, /^<agent-result name="worker"/)).content), /status="completed">\n[\s\S]*\nHI\n<\/agent-result>$/);
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
});
