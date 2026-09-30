import { randomBytes } from "node:crypto";
import type { ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { deferred, type Deferred } from "./agents.ts";
import { boundBlocks, boundText } from "./output.ts";
import { executeProgram, type ProgramOutcome, type ProgramRunOptions, type ProgramRunResult } from "./program-execute.ts";

const PROGRAM_ENTRY = "pi-agents-program";
const CLEANUP_TIMEOUT_MS = 10_000;

type Item = ProgramRunResult["result"]["content"][number];

export type ProgramState = "running" | ProgramOutcome;

export interface ProgramRecord {
	id: string;
	state: ProgramState;
	startedAt: number;
	content?: Item[];
	isError?: boolean;
	/** Whether `wait` has returned the result. */
	returned: boolean;
	notified: boolean;
}

interface Running {
	record: ProgramRecord;
	controller?: AbortController;
	done?: Promise<void>;
	waiters: number;
}

export interface ProgramWaitOutcome {
	results: ProgramRecord[];
	running: ProgramRecord[];
}

/** UUIDv7, like Pi's Session IDs. */
function uuidv7(): string {
	const bytes = randomBytes(16);
	const time = BigInt(Date.now());
	for (let i = 0; i < 6; i++) bytes[i] = Number((time >> BigInt(8 * (5 - i))) & 0xffn);
	bytes[6] = 0x70 | (bytes[6]! & 0x0f);
	bytes[8] = 0x80 | (bytes[8]! & 0x3f);
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

	constructor(
		private hooks: {
			appendEntry(customType: string, data: unknown): void;
			notify(text: string): void;
		},
	) {}

	restore(ctx: ExtensionContext): void {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== PROGRAM_ENTRY) continue;
			const record = entry.data as ProgramRecord;
			this.programs.set(record.id, { record, waiters: 0 });
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

	/** Starts a background Program and returns its ID. */
	start(toolCallId: string, code: string, ctx: ExtensionToolContext, options: Omit<ProgramRunOptions, "onUpdate">): ProgramRecord {
		const record: ProgramRecord = { id: uuidv7(), state: "running", startedAt: Date.now(), returned: false, notified: false };
		const controller = new AbortController();
		const program: Running = { record, controller, waiters: 0 };
		this.programs.set(record.id, program);
		this.persist(record);
		program.done = executeProgram(toolCallId, code, controller.signal, ctx, options).then(
			({ outcome, result }) => this.end(program, outcome, result.content, result.isError === true),
			(error: unknown) => this.end(program, "failed", [{ type: "text", text: `Script failed\nOutput:\nScript error:\n${error instanceof Error ? error.message : String(error)}` }], true),
		);
		return record;
	}

	target(id: string): Running {
		const program = this.programs.get(id);
		if (!program) throw new Error(`No Program matches "${id}". Use list to find Programs.`);
		return program;
	}

	list(): ProgramRecord[] {
		return [...this.programs.values()].map((program) => program.record).sort((a, b) => b.startedAt - a.startedAt);
	}

	summary(): { running: number; unreturned: number } {
		let running = 0, unreturned = 0;
		for (const { record } of this.programs.values()) {
			if (!ended(record)) running += 1;
			else if (!record.returned) unreturned += 1;
		}
		return { running, unreturned };
	}

	/** Returns whether the Program was running; it has ended when this resolves. */
	async stop(program: Running, reason = "Program stopped"): Promise<boolean> {
		if (ended(program.record)) return false;
		program.controller?.abort(new Error(reason));
		await this.settle(program);
		return true;
	}

	/** The given Programs, or running Programs and ended ones whose result has not been returned. */
	select(ids: string[] | undefined): Running[] {
		return [...new Set(ids?.map((id) => this.target(id)) ?? [...this.programs.values()].filter(({ record }) => !ended(record) || !record.returned))];
	}

	running(programs: Running[]): boolean {
		return programs.some(({ record }) => !ended(record));
	}

	async wait(unique: Running[], timeoutSeconds: number, signal?: AbortSignal): Promise<ProgramWaitOutcome> {
		for (const program of unique) program.waiters += 1;
		let returned = false;
		try {
			const deadline = Date.now() + timeoutSeconds * 1000;
			while (unique.some(({ record }) => !ended(record))) {
				const remaining = deadline - Date.now();
				if (remaining <= 0) break;
				signal?.throwIfAborted();
				let timer: ReturnType<typeof setTimeout> | undefined;
				let onAbort: (() => void) | undefined;
				try {
					await Promise.race([
						this.change.promise,
						new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); }),
						new Promise<void>((resolve) => {
							onAbort = resolve;
							signal?.addEventListener("abort", onAbort, { once: true });
						}),
					]);
				} finally {
					clearTimeout(timer);
					if (onAbort) signal?.removeEventListener("abort", onAbort);
				}
			}
			signal?.throwIfAborted();
			returned = true;
			return {
				results: unique.filter(({ record }) => ended(record)).map(({ record }) => record),
				running: unique.filter(({ record }) => !ended(record)).map(({ record }) => record),
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
	}

	async shutdown(): Promise<void> {
		this.closing = true;
		await Promise.allSettled([...this.programs.values()].map((program) => this.stop(program, "the caller went offline")));
	}

	private async settle(program: Running): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([program.done, new Promise((resolve) => { timer = setTimeout(resolve, CLEANUP_TIMEOUT_MS); })]);
		} finally {
			clearTimeout(timer);
		}
	}

	private end(program: Running, outcome: ProgramOutcome, content: Item[], isError: boolean): void {
		const { record } = program;
		record.state = outcome;
		record.content = content;
		record.isError = isError;
		program.controller = undefined;
		this.persist(record);
		if (program.waiters === 0) this.notify(record);
		const previous = this.change;
		this.change = deferred();
		previous.resolve();
	}

	private notify(record: ProgramRecord): void {
		if (this.closing || record.notified) return;
		record.notified = true;
		this.persist(record);
		this.hooks.notify(`Program ${record.id} ${record.state}.`);
	}

	private persist(record: ProgramRecord): void {
		this.hooks.appendEntry(PROGRAM_ENTRY, record);
	}
}

function resultBlock(record: ProgramRecord): string {
	return `<program-result id="${record.id}" status="${record.state}">\n${textOf(record.content)}\n</program-result>`;
}

/** Renders wait results; returns the content and the results the caller has now received. */
export function renderProgramWait({ results, running }: ProgramWaitOutcome): { content: Item[]; returned: ProgramRecord[]; isError?: boolean } {
	const runningLine = running.length > 0 ? `Still running: ${running.map((record) => record.id).join(", ")}` : "";
	if (results.length === 0) return { content: [{ type: "text", text: runningLine || "No results." }], returned: [] };
	const images = (shown: ProgramRecord[]) => shown.flatMap((record) => (record.content ?? []).filter((item) => item.type === "image"));
	const only = results[0]!;
	if (results.length === 1 && running.length === 0 && only.state === "completed") {
		const bounded = boundText(textOf(only.content), "pi-agents-program-wait");
		return { content: [{ type: "text", text: bounded.text }, ...images(results)], returned: results };
	}
	const bounded = boundBlocks(results.map(resultBlock), "program-result", "pi-agents-program-wait");
	let text = bounded.text;
	const returned = results.slice(0, bounded.shown);
	const omitted = results.slice(bounded.shown);
	if (omitted.length > 0) text += `\n\n[Results omitted: ${omitted.map((record) => record.id).join(", ")}. Use wait with fewer targets.]`;
	if (runningLine) text += `\n\n${runningLine}`;
	return { content: [{ type: "text", text }, ...images(returned)], returned };
}

function formatTime(time: number): string {
	const date = new Date(time);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function programListLine(record: ProgramRecord): string {
	return `${record.id}  ${record.state}  ${formatTime(record.startedAt)}`;
}
