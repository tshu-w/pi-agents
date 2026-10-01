import { fileURLToPath } from "node:url";

/**
 * Registers a stdio MCP server with one tool, `shout`, under the namespace `mcp__echo`. The server
 * answers `initialize` after `PI_AGENTS_TEST_MCP_DELAY` milliseconds.
 */
export default function (pi) {
	const args = [fileURLToPath(new URL("./mcp-server.mjs", import.meta.url)), process.env.PI_AGENTS_TEST_MCP_DELAY ?? "0"];
	pi.registerMcpServer("echo", { command: process.execPath, args });
}
