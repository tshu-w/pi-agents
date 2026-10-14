import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deferred, settlesBy, STEER_POLL_MS, WAIT_INTERRUPTED, waitForChange, type Deferred } from "../agents/agents.ts";
import { shortId, trackTreeWork } from "../agents/registry.ts";
import { boundBlocks, boundText } from "../output.ts";
import { CLEANUP_TIMEOUT_MS, PROGRAM_TOOL_NAME, type ProgramFiles, type ProgramOutcome, type ProgramRunResult } from "./execute.ts";

const PROGRAM_ENTRY = "pi-agents-program";
/** Ends the result of a Program some of whose work did not stop. */
export const CLEANUP_ERROR = "Cleanup error: some of the Program's work did not stop within the timeout and may still be running.";

type Item = ProgramRunResult["result"]["content"][number];

export type ProgramState = "running" | ProgramOutcome;

export interface ProgramRecord {
	id: string;
	state: ProgramState;
	startedAt: number;
	content?: Item[];
	isError?: boolean;
	/** Files the Program's tool calls used, for compaction. */
	files?: ProgramFiles;
	/** The tool calls its result lists, which the task viewer shows after a restart. */
	calls?: unknown[];
	/** Whether `wait` has returned the result. */
	returned: boolean;
	notified: boolean;
}

/** What the task viewer shows of a Program, as its tool call shows in the foreground. */
export interface ProgramView {
	record: ProgramRecord;
	code?: string;
	/** The latest partial result while it runs, then its result. */
	result?: ProgramRunResult["result"];
}

interface Running {
	record: ProgramRecord;
	code?: string;
	result?: ProgramRunResult["result"];
	controller?: AbortController;
	done?: Promise<void>;
	/** Stops counting the Program as the tree's work. */
	release?: () => void;
	/** Whether some of its work did not stop. */
	abandoned?: boolean;
	waiters: number;
}

export interface ProgramWaitOutcome {
	results: ProgramRecord[];
	running: ProgramRecord[];
	/** A steer ended the wait. */
	interrupted?: boolean;
}

function ended(record: ProgramRecord): boolean {
	return record.state !== "running";
}

/** The text of a result: the "Script completed" header, then the output items on their own lines. */
function textOf(content: Item[] | undefined): string {
	const [header = "", ...rest] = (content ?? []).flatMap((item) => item.type === "text" ? [item.text] : []);
	return header.endsWith("\n") ? header + rest.join("\n") : [header, ...rest].join("\n");
}

/** A caller's background Programs: they run on after `run` returns and stop when the caller goes offline. */
export class Programs {
	private programs = new Map<string, Running>();
	private change: Deferred = deferred();
	private closing = false;
	private viewers = new Set<() => void>();

	constructor(
		private rootId: string,
		private hooks: {
			appendEntry(customType: string, data: unknown): void;
			notify(text: string): void;
			/** Called when a Program starts, ends, or has its result returned. */
			changed?(): void;
		},
	) {}

	restore(ctx: ExtensionContext): void {
		// A Program's code is in the `run` call that started it, whose result names the Program.
		const codes = new Map<string, string>();
		const callIds = new Map<string, string>();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				for (const part of entry.message.content) {
					const code = part.type === "toolCall" && part.name === PROGRAM_TOOL_NAME ? (part.arguments as { code?: unknown }).code : undefined;
					if (typeof code === "string") codes.set((part as { id: string }).id, code);
				}
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === PROGRAM_TOOL_NAME) {
				const id = (entry.message.details as { id?: unknown } | undefined)?.id;
				if (typeof id === "string") callIds.set(id, entry.message.toolCallId);
			}
			if (entry.type !== "custom" || entry.customType !== PROGRAM_ENTRY) continue;
			const record = entry.data as ProgramRecord;
			this.programs.set(record.id, { record, waiters: 0 });
		}
		for (const program of this.programs.values()) {
			const callId = callIds.get(program.record.id);
			program.code = callId === undefined ? undefined : codes.get(callId);
		}
		for (const program of this.programs.values()) {
			const { record } = program;
			if (ended(record)) continue;
			record.state = "stopped";
			record.content = [{ type: "text", text: "Script failed\nOutput:\nScript error:\nScript aborted: the caller went offline" }];
			record.isError = true;
			record.notified = true;
			this.persist(record);
		}
	}

	/** Starts a background Program, which `run` executes with its ID and reports its partial results to `update`, and returns its record. */
	start(code: string, run: (id: string, signal: AbortSignal, abort: () => void, update: (result: unknown) => void) => Promise<ProgramRunResult>): ProgramRecord {
		const record: ProgramRecord = { id: randomUUID(), state: "running", startedAt: Date.now(), returned: false, notified: false };
		const controller = new AbortController();
		const program: Running = { record, code, controller, waiters: 0 };
		const update = (result: unknown) => {
			if (ended(record)) return;
			program.result = result as Running["result"];
			this.viewed();
		};
		this.programs.set(record.id, program);
		// The tree stays busy until the Program ends and its notification is delivered.
		const release = program.release = trackTreeWork(this.rootId);
		this.persist(record);
		this.hooks.changed?.();
		program.done = run(record.id, controller.signal, () => controller.abort(new Error("Program stopped")), update).then(
			({ outcome, result, files, abandoned }) => {
				if (abandoned) program.abandoned = true;
				if (!ended(record)) program.result = result;
				this.end(program, outcome, result.content, result.isError === true, files);
			},
			(error: unknown) => this.end(program, "failed", [{ type: "text", text: `Script failed\nOutput:\nScript error:\n${error instanceof Error ? error.message : String(error)}` }], true),
		).finally(release);
		return record;
	}

	/** Resolves an ID or a unique ID prefix. */
	target(id: string): Running {
		const exact = this.programs.get(id);
		if (exact) return exact;
		const matches = [...this.programs.values()].filter(({ record }) => record.id.startsWith(id));
		if (matches.length === 0) throw new Error(`No Program matches "${id}". Use list to find Programs.`);
		if (matches.length > 1) {
			throw new Error(`"${id}" matches several Programs: ${matches.map(({ record }) => this.label(record)).join(", ")}. Retry with a longer ID prefix.`);
		}
		return matches[0]!;
	}

	ids(): string[] {
		return [...this.programs.keys()];
	}

	/** A Program's short ID among this caller's Programs. */
	label(record: ProgramRecord): string {
		return shortId(record.id, this.ids());
	}

	list(): ProgramRecord[] {
		return [...this.programs.values()].map((program) => program.record).sort((a, b) => b.startedAt - a.startedAt);
	}

	view(id: string): ProgramView | undefined {
		const program = this.programs.get(id);
		if (!program) return undefined;
		const { record, code } = program;
		const restored = record.content && { content: record.content, details: record.calls && { calls: record.calls }, isError: record.isError };
		return { record, code, result: program.result ?? restored as ProgramView["result"] };
	}

	/** Calls `listener` when a Program's view changes; returns a function that stops it. */
	onView(listener: () => void): () => void {
		this.viewers.add(listener);
		return () => this.viewers.delete(listener);
	}

	/**
	 * Returns whether the Program was running; it has ended when this resolves. A Program that has
	 * not stopped within the timeout is abandoned and ends as stopped; this throws when some of its
	 * work did not stop.
	 */
	async stop(program: Running, reason = "Program stopped"): Promise<boolean> {
		if (ended(program.record)) return false;
		program.controller?.abort(new Error(reason));
		if (!await settlesBy(program.done!, Date.now() + CLEANUP_TIMEOUT_MS)) {
			program.abandoned = true;
			this.end(program, "stopped", [{ type: "text", text: "Script failed\nOutput:\n" }, { type: "text", text: CLEANUP_ERROR }], true);
			program.release?.();
		}
		if (program.abandoned) throw new Error(`Program ${this.label(program.record)} did not stop within the timeout and may still be running.`);
		return true;
	}

	/** The given Programs, or running Programs and ended ones whose result has not been returned. */
	select(ids: string[] | undefined): Running[] {
		return [...new Set(ids?.map((id) => this.target(id)) ?? [...this.programs.values()].filter(({ record }) => !ended(record) || !record.returned))];
	}

	running(programs: Running[]): boolean {
		return programs.some(({ record }) => !ended(record));
	}

	async wait(unique: Running[], timeoutSeconds: number, signal?: AbortSignal, steered?: () => boolean): Promise<ProgramWaitOutcome> {
		for (const program of unique) program.waiters += 1;
		let returned = false;
		let interrupted = false;
		try {
			const deadline = Date.now() + timeoutSeconds * 1000;
			while (unique.some(({ record }) => !ended(record))) {
				const remaining = deadline - Date.now();
				if (remaining <= 0) break;
				if (steered?.()) {
					interrupted = true;
					break;
				}
				signal?.throwIfAborted();
				await waitForChange(this.change.promise, steered ? Math.min(remaining, STEER_POLL_MS) : remaining, signal);
			}
			signal?.throwIfAborted();
			returned = true;
			return {
				results: unique.filter(({ record }) => ended(record)).map(({ record }) => record),
				running: unique.filter(({ record }) => !ended(record)).map(({ record }) => record),
				...(interrupted && { interrupted }),
			};
		} finally {
			for (const program of unique) {
				program.waiters -= 1;
				const { record } = program;
				if (!ended(record) || record.notified) continue;
				if (returned) {
					record.notified = true;
					this.persist(record);
				} else if (program.waiters === 0) {
					this.notify(record);
				}
			}
		}
	}

	markReturned(records: ProgramRecord[]): void {
		for (const record of records) {
			if (record.returned) continue;
			record.returned = true;
			this.persist(record);
		}
		this.hooks.changed?.();
	}

	async shutdown(): Promise<void> {
		this.closing = true;
		const stopped = await Promise.allSettled([...this.programs.values()].map((program) => this.stop(program, "the caller went offline")));
		const errors = stopped.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
		if (errors.length > 0) throw new Error(errors.map((error) => error instanceof Error ? error.message : String(error)).join("\n"));
	}

	private end(program: Running, outcome: ProgramOutcome, content: Item[], isError: boolean, files?: ProgramFiles): void {
		const { record } = program;
		// An abandoned Program may end later.
		if (ended(record)) return;
		record.state = outcome;
		record.content = content;
		record.isError = isError;
		// Keeps the calls the result's details list, from the result or the last partial one.
		program.result = { content, details: program.result?.details, isError };
		const calls = (program.result.details as { calls?: unknown[] } | undefined)?.calls;
		if (calls?.length) record.calls = calls;
		if (files && (files.read.length > 0 || files.written.length > 0 || files.edited.length > 0)) record.files = files;
		program.controller = undefined;
		this.persist(record);
		if (program.waiters === 0) this.notify(record);
		const previous = this.change;
		this.change = deferred();
		previous.resolve();
		this.hooks.changed?.();
		this.viewed();
	}

	private viewed(): void {
		for (const listener of this.viewers) listener();
	}

	private notify(record: ProgramRecord): void {
		if (this.closing || record.notified) return;
		record.notified = true;
		this.persist(record);
		this.hooks.notify(`Program ${this.label(record)} ${record.state}.`);
	}

	private persist(record: ProgramRecord): void {
		this.hooks.appendEntry(PROGRAM_ENTRY, record);
	}
}

/**
 * Adds the files of the background Programs that ended in the entries compaction summarizes: after
 * the previous compaction's kept entries start and before `firstKeptEntryId`. Pi finds file
 * operations in the nested calls of tool results, which do not hold calls made after `run` returns.
 */
export function addProgramFiles(
	entries: Array<{ id: string; type: string; customType?: string; data?: unknown; firstKeptEntryId?: string }>,
	firstKeptEntryId: string,
	fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> },
): void {
	const end = entries.findIndex((entry) => entry.id === firstKeptEntryId);
	const previous = entries.findLast((entry) => entry.type === "compaction");
	const start = previous ? Math.max(0, entries.findIndex((entry) => entry.id === previous.firstKeptEntryId)) : 0;
	for (const entry of entries.slice(start, end < 0 ? undefined : end)) {
		if (entry.type !== "custom" || entry.customType !== PROGRAM_ENTRY) continue;
		const files = (entry.data as ProgramRecord).files;
		for (const path of files?.read ?? []) fileOps.read.add(path);
		for (const path of files?.written ?? []) fileOps.written.add(path);
		for (const path of files?.edited ?? []) fileOps.edited.add(path);
	}
}

function resultBlock(record: ProgramRecord, ids: string[]): string {
	return `<program-result id="${shortId(record.id, ids)}" status="${record.state}">\n${textOf(record.content)}\n</program-result>`;
}

/** Renders wait results; returns the content and the results the caller has now received. */
export function renderProgramWait({ results, running, interrupted }: ProgramWaitOutcome, ids: string[]): { content: Item[]; returned: ProgramRecord[]; isError?: boolean } {
	const runningLine = running.length > 0 ? `Still running: ${running.map((record) => shortId(record.id, ids)).join(", ")}${interrupted ? `\n${WAIT_INTERRUPTED}` : ""}` : "";
	if (results.length === 0) return { content: [{ type: "text", text: runningLine || "No results." }], returned: [] };
	const images = (shown: ProgramRecord[]) => shown.flatMap((record) => (record.content ?? []).filter((item) => item.type === "image"));
	const only = results[0]!;
	if (results.length === 1 && running.length === 0 && only.state === "completed") {
		const bounded = boundText(textOf(only.content), "pi-agents-program-wait");
		return { content: [{ type: "text", text: bounded.text }, ...images(results)], returned: results };
	}
	const bounded = boundBlocks(results.map((record) => resultBlock(record, ids)), "program-result", "pi-agents-program-wait");
	let text = bounded.text;
	const returned = results.slice(0, bounded.shown);
	const omitted = results.slice(bounded.shown);
	if (omitted.length > 0) text += `\n\n[Results omitted: ${omitted.map((record) => shortId(record.id, ids)).join(", ")}. Use wait with fewer targets.]`;
	if (runningLine) text += `\n\n${runningLine}`;
	return { content: [{ type: "text", text }, ...images(returned)], returned };
}

export function programListLine(record: ProgramRecord, ids: string[]): string {
	return `${shortId(record.id, ids)}  ${record.state}`;
}
