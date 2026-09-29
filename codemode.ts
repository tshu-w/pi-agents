import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

type Codemode = typeof import("@earendil-works/pi-codemode");

let loaded: Promise<Codemode> | undefined;

/** Pi ships `@earendil-works/pi-codemode` but does not alias it for extensions, so load Pi's copy. */
export function loadCodemode(): Promise<Codemode> {
	loaded ??= (async () => {
		const dirs = createRequire(join(getPackageDir(), "package.json")).resolve.paths("@earendil-works/pi-codemode") ?? [];
		const entry = dirs.map((dir) => join(dir, "@earendil-works/pi-codemode/dist/index.js")).find(existsSync);
		if (!entry) throw new Error("pi-agents requires Pi with @earendil-works/pi-codemode");
		return import(pathToFileURL(entry).href);
	})();
	return loaded;
}
