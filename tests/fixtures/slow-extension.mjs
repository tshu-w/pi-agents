/** Holds an Agent's extension loading until `piAgentsSlowLoad.open()`, then fails it. */
let open;
const held = new Promise((resolve) => { open = resolve; });
globalThis.piAgentsSlowLoad = { open: () => open() };

export default async function () {
	await held;
	throw new Error("slow extension failed");
}
