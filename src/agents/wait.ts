/** Waiting for owned Agents or Programs to end, with the notifications a wait holds until it ends. */
import type { Notice, NotifiedResult } from "./registry.ts";

// Pi does not report steers queued by extensions, so a wait checks the queue this often.
const STEER_POLL_MS = 250;

/** How a wait ended: what it waited for ended, its timeout expired, another message ended it, or it had nothing to wait for. */
export type WaitEnd = "completed" | "timedOut" | "interrupted" | "nothing";

/** The text `wait` returns, naming what it still waits for as `still` does. */
export function waitText(end: WaitEnd, still: string): string {
	if (end === "nothing") return "Nothing to wait for.";
	if (end === "completed") return "Wait completed.";
	return `${end === "timedOut" ? "Wait timed out." : "Wait interrupted by a new message."} ${still}`;
}

export interface Deferred {
	promise: Promise<void>;
	resolve(): void;
}

export function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

/** Resolves when `change` resolves, `ms` pass, or `signal` aborts. */
async function waitForChange(change: Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		await Promise.race([
			change,
			new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
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

/** Whether `work` settles by `deadline`; a rejection passes through. */
export async function settlesBy(work: Promise<unknown>, deadline: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const settled = work.then(() => true);
		// A rejection after the deadline has no one to report to.
		settled.catch(() => {});
		return await Promise.race([
			settled,
			new Promise<boolean>((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now()), false); }),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** A notification a wait holds; every wait for its Agent or Program holds it, and the first to end delivers it. */
interface HeldNotice {
	text: string;
	result: NotifiedResult;
	images?: NonNullable<Notice["images"]>;
	delivered?: boolean;
	/** Called once a wait has delivered it. */
	settle?: () => void;
}

/** A wait in progress: the IDs of the Agents or Programs it waits for, and their notifications it holds. */
export interface Held {
	ids: Set<string>;
	notices: HeldNotice[];
}

/** Has the waits in progress for `id` hold a notification; returns whether any does. */
export function hold(waits: Held[], id: string, notice: HeldNotice): boolean {
	const holding = waits.filter(({ ids }) => ids.has(id));
	for (const wait of holding) wait.notices.push(notice);
	return holding.length > 0;
}

/** The notifications a wait holds that no other wait has delivered, as one notification, or undefined if none. */
function release(wait: Held): { text: string; notice: Notice; settles: Array<() => void> } | undefined {
	const notices = wait.notices.filter(({ delivered }) => !delivered);
	if (notices.length === 0) return undefined;
	for (const notice of notices) notice.delivered = true;
	const images = notices.flatMap((notice) => notice.images ?? []);
	return {
		text: notices.map(({ text }) => text).join("\n\n"),
		notice: { results: notices.map(({ result }) => result), ...(images.length ? { images } : {}) },
		settles: notices.flatMap(({ settle }) => settle ?? []),
	};
}

/** The Agents or Programs of one caller that its waits wait for. */
export interface Waitable {
	/** The waits in progress, which hold the notifications of what they wait for. */
	waits: Held[];
	/** Resolves when what the waits wait for may have changed. */
	change(): Promise<void>;
	/** Whether the caller is going offline, so a wait that ends delivers nothing. */
	closing(): boolean;
	/** Delivers a notification; returns false when it was not delivered. */
	notify(text: string, notice: Notice): boolean | void;
}

/**
 * Waits until `pending` lists nothing `ids` names, the timeout expires, or `steered` reports a steer, and returns how
 * it ended with what `pending` lists then. The notifications of `ids` are held until it ends, then delivered as one.
 */
export async function waitFor<T>(
	waitable: Waitable,
	ids: string[],
	pending: () => T[],
	timeoutSeconds: number,
	signal?: AbortSignal,
	steered?: () => boolean,
): Promise<{ end: Exclude<WaitEnd, "nothing">; pending: T[] }> {
	const held: Held = { ids: new Set(ids), notices: [] };
	waitable.waits.push(held);
	try {
		let interrupted = false;
		const deadline = Date.now() + timeoutSeconds * 1000;
		while (pending().length > 0) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			if (steered?.()) {
				interrupted = true;
				break;
			}
			signal?.throwIfAborted();
			await waitForChange(waitable.change(), steered ? Math.min(remaining, STEER_POLL_MS) : remaining, signal);
		}
		signal?.throwIfAborted();
		const still = pending();
		return { end: still.length === 0 ? "completed" : interrupted ? "interrupted" : "timedOut", pending: still };
	} finally {
		waitable.waits.splice(waitable.waits.indexOf(held), 1);
		const released = waitable.closing() ? undefined : release(held);
		if (released && waitable.notify(released.text, released.notice) !== false) for (const settle of released.settles) settle();
	}
}
