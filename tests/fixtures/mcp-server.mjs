/**
 * A minimal stdio MCP server whose tools, named by the arguments after the first (default `shout`), return their text
 * uppercased. The first argument delays `initialize` in milliseconds.
 */
import { createInterface } from "node:readline";
const [delay = "0", ...names] = process.argv.slice(2);
const tools = names.length > 0 ? names : ["shout"];
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
createInterface({ input: process.stdin }).on("line", async (line) => {
	const msg = JSON.parse(line);
	if (msg.id === undefined) return;
	if (msg.method === "initialize") await new Promise((resolve) => setTimeout(resolve, Number(delay)));
	if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" }, instructions: "Echo server for tests." } });
	if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools: tools.map((name) => ({ name, description: "Uppercase a text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } })) } });
	if (msg.method === "tools/call") return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String(msg.params.arguments.text).toUpperCase() }] } });
	send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no method" } });
});
