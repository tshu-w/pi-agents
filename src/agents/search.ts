import { existsSync, readFileSync, statSync } from "node:fs";
import { entryLine, MESSAGE_TAG, MESSAGE_TYPE, type Entry } from "./registry.ts";

interface SearchText {
	time: number;
	text: string;
}

/** Parsed texts by Session file, reused while the file is unchanged. */
const cache = new Map<string, { stamp: string; texts: SearchText[] }>();

function sessionTexts(sessionFile: string | undefined): SearchText[] {
	if (!sessionFile) return [];
	const stats = statSync(sessionFile, { throwIfNoEntry: false });
	if (!stats) {
		cache.delete(sessionFile);
		return [];
	}
	const stamp = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
	const cached = cache.get(sessionFile);
	if (cached?.stamp === stamp) return cached.texts;
	const texts: SearchText[] = [];
	for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
		if (!line) continue;
		let entry: Record<string, any>;
		try { entry = JSON.parse(line); } catch { continue; }
		const time = Date.parse(entry.timestamp ?? "") || 0;
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			if (typeof entry.summary === "string") texts.push({ time, text: entry.summary });
		} else if (entry.type === "message" && entry.message?.role === "user") {
			const content = entry.message.content;
			const text = typeof content === "string"
				? content
				: Array.isArray(content) ? content.flatMap((part: any) => part?.type === "text" ? [part.text] : []).join("\n") : "";
			if (text) texts.push({ time, text });
		} else if (entry.type === "custom_message" && entry.customType === MESSAGE_TYPE && typeof entry.content === "string") {
			texts.push({ time, text: entry.content });
		}
	}
	cache.set(sessionFile, { stamp, texts });
	return texts;
}

function matcher(query: string): (text: string) => string[] | undefined {
	const groups = query.toLowerCase().split("|").map((group) => group.trim().split(/\s+/).filter(Boolean)).filter((group) => group.length > 0);
	return (text) => {
		const lower = text.toLowerCase();
		return groups.find((terms) => terms.every((term) => lower.includes(term)));
	};
}

function excerpt(text: string, term: string): string {
	const flat = text.replace(/\s+/g, " ");
	const index = Math.max(0, flat.toLowerCase().indexOf(term));
	const start = Math.max(0, index - 40);
	const end = Math.min(flat.length, index + term.length + 80);
	return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

function formatTime(time: number): string {
	const date = new Date(time);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface ListItem {
	entry: Entry;
	match?: SearchText & { excerpt: string };
}

/** Filters entries by a query over ID, name, cwd, summaries, and user messages, most recent match first. */
export function searchEntries(entries: Entry[], query: string | undefined): ListItem[] {
	if (!query?.trim()) return entries.map((entry) => ({ entry }));
	const match = matcher(query);
	const items: Array<ListItem & { time: number }> = [];
	for (const entry of entries) {
		let latest: ListItem["match"];
		for (const text of sessionTexts(entry.sessionFile)) {
			const terms = match(text.text);
			if (terms && (!latest || text.time >= latest.time)) latest = { ...text, excerpt: excerpt(text.text, terms[0]!) };
		}
		if (latest) items.push({ entry, match: latest, time: latest.time });
		else if (match([entry.id, entry.name ?? "", entry.cwd].join("\n"))) items.push({ entry, time: 0 });
	}
	return items.sort((left, right) => right.time - left.time).map(({ time: _time, ...item }) => item);
}

export function listLine(item: ListItem, ids: Iterable<string>): string {
	const line = entryLine(item.entry, ids);
	return item.match ? `${line}\n  ${formatTime(item.match.time)}  ${item.match.excerpt}` : line;
}

/**
 * An Agent's latest activity on one line: its last tool call, as `$ <command>` for bash, the tool and
 * its path for file tools, or the `agent` action and its targets; or the last line of its last reply; before it has any, its first input without the sender header. A forked
 * conversation is not its input.
 */
export function latestActivity(sessionFile: string | undefined): string | undefined {
	if (!sessionFile || !existsSync(sessionFile)) return undefined;
	let input: string | undefined;
	let activity: string | undefined;
	for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
		let entry: Record<string, any>;
		try { entry = JSON.parse(line); } catch { continue; }
		if (input === undefined && entry.type === "custom_message" && entry.customType === MESSAGE_TYPE && typeof entry.content === "string") {
			input = entry.content.startsWith(`<${MESSAGE_TAG} `) ? entry.content.slice(entry.content.indexOf("\n") + 1, entry.content.lastIndexOf("\n")) : entry.content;
		}
		if (input !== undefined && entry.type === "message" && entry.message?.role === "assistant" && Array.isArray(entry.message.content)) {
			activity = replyActivity(entry.message.content) ?? activity;
		}
	}
	return (activity ?? input)?.replace(/\s+/g, " ").trim();
}

function toolActivity(name: string, args: Record<string, any>): string {
	if (name === "bash" && typeof args.command === "string") return `$ ${args.command}`;
	if (typeof args.path === "string") return `${name} ${args.path}`;
	if (name === "agent" && typeof args.action === "string") {
		const targets = [args.target, args.name].flat().filter((target) => typeof target === "string");
		return [args.action, targets.join(", ")].filter(Boolean).join(" ");
	}
	return name;
}

function replyActivity(content: Array<Record<string, any>>): string | undefined {
	for (const block of [...content].reverse()) {
		if (block.type === "toolCall") return toolActivity(block.name, block.arguments ?? {});
		if (block.type === "text" && typeof block.text === "string" && block.text.trim()) return block.text.trim().split("\n").at(-1);
	}
	return undefined;
}
