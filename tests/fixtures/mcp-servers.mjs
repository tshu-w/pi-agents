import { fileURLToPath } from "node:url";

/**
 * Registers two stdio MCP servers: `alpha` with `codemode` exposure, whose `loud` is `direct`, and
 * `beta` with `deferred` exposure.
 */
export default function (pi) {
	const server = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url));
	pi.registerMcpServer("alpha", { command: process.execPath, args: [server, "0", "shout", "loud"], toolExposure: { loud: "direct" } });
	pi.registerMcpServer("beta", { command: process.execPath, args: [server, "0", "whisper"], exposure: "deferred" });
}
