import { nodes, treeIdle } from "../../src/agents/registry.ts";
import { panelLines } from "../../src/ui/panel.ts";
import { ownedEntries } from "../../src/ui/viewer.ts";

/** Exposes the task panel, the Agent viewer's list, and tree idleness to tests. */
export default function () {
	(globalThis as Record<string, unknown>).piAgentsTree = { nodes, treeIdle, panelLines, ownedEntries };
}
