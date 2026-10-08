import { nodes, treeIdle } from "../../src/agents/registry.ts";
import { latestActivity } from "../../src/agents/search.ts";
import { createRootRuntime } from "../../src/roots/runtime.ts";
import { panelLines } from "../../src/ui/panel.ts";
import { ownedEntries } from "../../src/ui/viewer.ts";

/** Exposes the task panel, the Agent viewer's list and activity, tree idleness, and the root runtime to tests. */
export default function () {
	(globalThis as Record<string, unknown>).piAgentsTree = { nodes, treeIdle, panelLines, ownedEntries, latestActivity, createRootRuntime };
}
