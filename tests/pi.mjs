import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Session locks and sockets of the tests stay out of the user's state directory.
// Socket paths must stay short, so the directory lives under /tmp.
if (!process.env.PI_AGENTS_STATE_DIR) {
	const state = mkdtempSync(join("/tmp", "pi-agents-state-"));
	process.env.PI_AGENTS_STATE_DIR = state;
	process.on("exit", () => rmSync(state, { recursive: true, force: true }));
}

// npm links `pi` to the package's `dist/bundle/cli.js`; Homebrew wraps it in a script beside `libexec`.
const bin = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
export const PI_PACKAGE = bin.endsWith(join("dist", "bundle", "cli.js"))
	? dirname(dirname(dirname(bin)))
	: join(dirname(dirname(bin)), "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
export const EXTENSION = fileURLToPath(new URL("../src/index.ts", import.meta.url));

export const pi = await import(join(PI_PACKAGE, "dist/index.js"));
export const ai = await import(join(PI_PACKAGE, "node_modules/@earendil-works/pi-ai/dist/index.js"));

export const textOf = (content) => typeof content === "string"
	? content
	: content.filter((block) => block.type === "text").map((block) => block.text).join("\n");

/** A gate that holds work until opened. */
export function gate() {
	let open;
	const promise = new Promise((resolve) => { open = resolve; });
	return { promise, open };
}

/** Resolves with the first truthy value of `check`, polled until the deadline. */
export async function until(check, label, timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs;
	do {
		const value = await check();
		if (value) return value;
		await delay(10);
	} while (Date.now() < deadline);
	throw new Error(`Timed out: ${label}`);
}

/**
 * Creates a Session in `cwd` with the given extensions, whose faux model answers every request
 * with `route`. Other options go to `createAgentSession`.
 */
export async function createSession({ cwd, route, extensions, extensionFactories, ...options }) {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "model" }], tokensPerSecond: 0 });
	faux.setResponses(Array.from({ length: 200 }, () => route));
	const modelRuntime = await pi.ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null });
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, extensionFactories, additionalExtensionPaths: extensions });
	await resourceLoader.reload();
	const { session } = await pi.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel(), ...options });
	return session;
}
