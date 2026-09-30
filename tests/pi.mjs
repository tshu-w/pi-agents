import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
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
const modules = join(PI_PACKAGE, "node_modules");

export const pi = await import(join(PI_PACKAGE, "dist/index.js"));

const { createJiti } = createRequire(import.meta.url)(join(modules, "jiti/lib/jiti.cjs"));

/** Imports this package's TypeScript modules against the installed Pi, as Pi's loader does. */
export const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-coding-agent": join(PI_PACKAGE, "dist/index.js"),
		"@earendil-works/pi-ai": join(modules, "@earendil-works/pi-ai/dist/compat.js"),
		"@earendil-works/pi-tui": join(modules, "@earendil-works/pi-tui/dist/index.js"),
		typebox: join(modules, "typebox/build/index.mjs"),
		"typebox/value": join(modules, "typebox/build/value/index.mjs"),
	},
});
