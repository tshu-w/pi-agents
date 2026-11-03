import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { treeMetadata } from "./agents/registry.ts";
import { statePaths } from "./roots/paths.mjs";

export const MAIN_FLAG = "main";
const instructions = readFileSync(new URL("./main-agent.md", import.meta.url), "utf8").trim();

/** The main Agent's Session file, as `main.json` names it. */
function mainSessionFile(): string | undefined {
	try {
		return (JSON.parse(readFileSync(statePaths().mainSession, "utf8")) as { sessionFile?: string }).sessionFile;
	} catch {
		return undefined;
	}
}

/**
 * The main Agent is the Session `main.json` names: `pd main` starts one with `--main`, and `/new` in it starts the
 * next. It gets the main Agent's instructions.
 */
export function registerMainAgent(pi: ExtensionAPI): void {
	pi.registerFlag(MAIN_FLAG, { type: "boolean", description: "Start the main Agent (used by pd main)" });
	let main = false;
	pi.on("session_start", (event, ctx) => {
		main = false;
		if (treeMetadata(ctx)) return;
		// Absolute, as `pd main` compares it from other directories; a session directory may be relative.
		const current = ctx.sessionManager.getSessionFile();
		const file = current && path.resolve(current);
		const started = event.reason === "startup" && pi.getFlag(MAIN_FLAG) === true;
		const renewed = event.reason === "new" && event.previousSessionFile !== undefined && path.resolve(event.previousSessionFile) === mainSessionFile();
		if (file && (started || renewed)) {
			const record = statePaths().mainSession;
			mkdirSync(path.dirname(record), { recursive: true, mode: 0o700 });
			// Replaced at once, so that a reader never sees it half written.
			const temporary = `${record}.${process.pid}`;
			writeFileSync(temporary, JSON.stringify({ sessionFile: file }));
			renameSync(temporary, record);
		}
		main = file !== undefined && file === mainSessionFile();
	});
	pi.on("before_agent_start", (event) => {
		if (main) event.systemPromptOptions.sections["main-agent"] = instructions;
	});
}
