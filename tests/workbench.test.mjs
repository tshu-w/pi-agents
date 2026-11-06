import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { conversation, loadPi } from "../src/workbench.mjs";

const modules = await loadPi(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
modules.themes.initTheme("dark");

const user = (text, timestamp) => ({ role: "user", content: text, timestamp });
const reply = (content, timestamp, stopReason = "toolUse") => ({ role: "assistant", content, stopReason, timestamp });
const text = (value) => ({ type: "text", text: value });
const call = (name) => ({ type: "toolCall", id: name, name, arguments: {} });
const notice = (value, timestamp) => ({ role: "custom", customType: "pi-agents", content: value, display: true, details: {}, timestamp });
const show = (messages, options) => stripVTControlCharacters(conversation(modules, messages, { outputPad: 1, ...options }).render(100).join("\n"));

test("the preview folds each finished turn behind a Worked for rule", () => {
	const messages = [
		user("First question", 0),
		reply([text("Looking"), call("bash")], 1000),
		reply([call("read")], 20_000),
		reply([text("Failed")], 40_000, "error"),
		reply([text("First answer")], 83_000, "stop"),
		notice("Agent finished", 90_000),
		reply([text("Notified reply")], 120_000, "stop"),
	];
	const shown = show(messages, { working: false });
	assert.match(shown, /First question\s+─── Worked for 1m 23s, 2 steps, 1 retry: bash, read ───\s+First answer\s+─── Worked for 30s, 1 step: messages ───\s+Notified reply/);
	assert.doesNotMatch(shown, /Looking|Failed|Agent finished|expand/);
	// Tool names go first on a narrow line.
	assert.match(stripVTControlCharacters(conversation(modules, messages, { outputPad: 3, working: false }).render(60).join("\n")), /^ {3}─── Worked for 1m 23s, 2 steps, 1 retry: bash, … ───$/m);
});

test("the running turn shows its texts and folds its steps without a time", () => {
	const shown = show([
		user("Question", 0),
		reply([text("Looking"), call("bash")], 1000),
		reply([text("Still looking"), call("read"), call("bash")], 2000),
		notice("Agent finished", 3000),
	], { working: true });
	assert.match(shown, /Question\s+Looking\s+─── 1 step: bash ───\s+Still looking\s+─── 3 steps: read, bash, messages ───$/);
	assert.doesNotMatch(shown, /Worked/);
});

test("a turn that ended folds while a background Program keeps the Session working", () => {
	const shown = show([
		user("Question", 0),
		reply([text("Starting a Program"), call("program")], 1000),
		reply([text("It runs in the background")], 5000, "stop"),
	], { working: true });
	assert.match(shown, /Question\s+─── Worked for 5s, 1 step: program ───\s+It runs in the background\s*$/);
	assert.doesNotMatch(shown, /Starting a Program/);
});
