import { deliver, nodes, treeChanged, treeEntries, treeIdle } from "../../src/agents/registry.ts";
import { latestActivity } from "../../src/agents/search.ts";
import { createReporter } from "../../src/roots/report.ts";
import { createRootRuntime } from "../../src/roots/runtime.ts";
import { panelLines } from "../../src/ui/panel.ts";
import { ownedEntries } from "../../src/ui/viewer.ts";

/** Exposes the task panel, the task viewer's list and activity, tree idleness and changes, delivery, the root runtime, and the reporter to tests. */
export default function () {
	(globalThis as Record<string, unknown>).piAgentsTree = { nodes, deliver, treeIdle, treeChanged, panelLines, ownedEntries, latestActivity, treeEntries, createRootRuntime, createReporter };
}
