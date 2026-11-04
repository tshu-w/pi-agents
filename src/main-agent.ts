import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { treeMetadata } from "./agents/registry.ts";
import { statePaths } from "./roots/paths.mjs";

export const MAIN_FLAG = "main";
const instructions = readFileSync(new URL("./main-agent.md", import.meta.url), "utf8").trim();

/** The main Agents' Session files by entry name, as `main.json` maps them; an old `{ sessionFile }` is the entry `main`. */
function mainEntries(): Record<string, string> {
	try {
		const entries = JSON.parse(readFileSync(statePaths().mainSession, "utf8")) as Record<string, string>;
		return typeof entries.sessionFile === "string" ? { main: entries.sessionFile } : entries;
	} catch {
		return {};
	}
}

/**
 * A main Agent is a Session an entry of `main.json` names: `pd main --name <entry>` starts one with `--main=<entry>`,
 * and `/new` in it starts the next for the same entry. It gets the main Agent's instructions.
 */
export function registerMainAgent(pi: ExtensionAPI): void {
	pi.registerFlag(MAIN_FLAG, { type: "string", description: "Start the main Agent of this entry (used by pd main)" });
	let main = false;
	pi.on("session_start", (event, ctx) => {
		main = false;
		if (treeMetadata(ctx)) return;
		// Absolute, as `pd main` compares it from other directories; a session directory may be relative.
		const current = ctx.sessionManager.getSessionFile();
		const file = current && path.resolve(current);
		const mains = mainEntries();
		const flag = pi.getFlag(MAIN_FLAG);
		const previous = event.reason === "new" && event.previousSessionFile !== undefined ? path.resolve(event.previousSessionFile) : undefined;
		const names = event.reason === "startup" && typeof flag === "string"
			? [flag]
			: Object.keys(mains).filter((name) => previous !== undefined && mains[name] === previous);
		if (file && names.length > 0) {
			for (const name of names) mains[name] = file;
			const record = statePaths().mainSession;
			mkdirSync(path.dirname(record), { recursive: true, mode: 0o700 });
			// Replaced at once, so that a reader never sees it half written.
			const temporary = `${record}.${process.pid}`;
			writeFileSync(temporary, JSON.stringify(mains), { mode: 0o600 });
			renameSync(temporary, record);
		}
		main = file !== undefined && Object.values(mains).includes(file);
	});
	pi.on("before_agent_start", (event) => {
		if (main) event.systemPromptOptions.sections["main-agent"] = instructions;
	});
}
