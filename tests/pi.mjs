import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

// Session locks and sockets of the tests stay out of the user's state directory.
// Socket paths must stay short, so the directory lives under /tmp.
if (!process.env.PI_AGENTS_STATE_DIR) {
	const state = mkdtempSync(join("/tmp", "pi-agents-state-"));
	process.env.PI_AGENTS_STATE_DIR = state;
	process.on("exit", () => rmSync(state, { recursive: true, force: true }));
}

const prefix = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
export const PI_PACKAGE = join(prefix, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");

export const pi = await import(join(PI_PACKAGE, "dist/index.js"));

