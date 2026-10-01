import { fileURLToPath } from "node:url";

/** Registers a stdio MCP server with one tool, `shout`, under the namespace `mcp__echo`. */
export default function (pi) {
	pi.registerMcpServer("echo", { command: process.execPath, args: [fileURLToPath(new URL("./mcp-server.mjs", import.meta.url))] });
}
