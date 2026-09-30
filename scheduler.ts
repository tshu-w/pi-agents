/** Execution slots and outstanding-input permits shared by the owned Agents of each root. */
interface SuspendedOwner {
	count: number;
	resuming: boolean;
}

interface CapacityWaiter {
	id: string;
	resolve(): void;
	reject(error: unknown): void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export class TreeScheduler {
	private runningByRoot = new Map<string, Set<string>>();
	private waitersByRoot = new Map<string, CapacityWaiter[]>();
	private resumeWaitersByRoot = new Map<string, CapacityWaiter[]>();
	private suspendedByRoot = new Map<string, Map<string, SuspendedOwner>>();
	private outstandingByRoot = new Map<string, Set<symbol>>();
	private maximumByRoot = new Map<string, number>();

	hasCapacity(rootId: string, maximum: number): boolean {
		return (this.runningByRoot.get(rootId)?.size ?? 0) < maximum;
	}

	acquire(rootId: string, id: string, maximum: number): boolean {
		this.rememberMaximum(rootId, maximum);
		const running = this.runningByRoot.get(rootId) ?? new Set<string>();
		if (running.has(id)) return true;
		if (running.size >= maximum) return false;
		running.add(id);
		this.runningByRoot.set(rootId, running);
		return true;
	}

	acquireQueued(rootId: string, id: string, maximum: number, signal?: AbortSignal, resume = false): Promise<void> {
		this.rememberMaximum(rootId, maximum);
		return new Promise<void>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new DOMException("Capacity wait aborted", "AbortError"));
				return;
			}
			const queueMap = resume ? this.resumeWaitersByRoot : this.waitersByRoot;
			const queue = queueMap.get(rootId) ?? [];
			const waiter: CapacityWaiter = { id, resolve, reject, signal };
			waiter.onAbort = () => {
				const index = queue.indexOf(waiter);
				if (index >= 0) queue.splice(index, 1);
				if (queue.length === 0) queueMap.delete(rootId);
				reject(new DOMException("Capacity wait aborted", "AbortError"));
				this.drain(rootId, maximum);
			};
			queue.push(waiter);
			queueMap.set(rootId, queue);
			signal?.addEventListener("abort", waiter.onAbort, { once: true });
			this.drain(rootId, maximum);
		});
	}

	release(rootId: string, id: string): void {
		const running = this.runningByRoot.get(rootId);
		if (running?.delete(id) && running.size === 0) this.runningByRoot.delete(rootId);
		const suspended = this.suspendedByRoot.get(rootId);
		if (suspended?.delete(id) && suspended.size === 0) this.suspendedByRoot.delete(rootId);
		this.rejectWaiters(rootId, id);
		this.drain(rootId, this.maximum(rootId));
		this.cleanupRoot(rootId);
	}

	suspend(rootId: string, id: string): boolean {
		const suspended = this.suspendedByRoot.get(rootId) ?? new Map<string, SuspendedOwner>();
		const existing = suspended.get(id);
		if (existing) {
			existing.count += 1;
			return true;
		}
		const running = this.runningByRoot.get(rootId);
		if (!running?.delete(id)) return false;
		if (running.size === 0) this.runningByRoot.delete(rootId);
		suspended.set(id, { count: 1, resuming: false });
		this.suspendedByRoot.set(rootId, suspended);
		this.drain(rootId, this.maximum(rootId));
		return true;
	}

	async resume(rootId: string, id: string, maximum: number, signal?: AbortSignal): Promise<void> {
		const suspended = this.suspendedByRoot.get(rootId);
		const state = suspended?.get(id);
		if (!state) return;
		state.count -= 1;
		if (state.count > 0 || state.resuming) return;
		if (signal?.aborted) {
			suspended!.delete(id);
			if (suspended!.size === 0) this.suspendedByRoot.delete(rootId);
			return;
		}
		state.resuming = true;
		try {
			await this.acquireQueued(rootId, id, maximum, signal, true);
		} catch (error) {
			state.resuming = false;
			if (signal?.aborted || suspended?.get(id) !== state) {
				suspended?.delete(id);
				if (suspended?.size === 0) this.suspendedByRoot.delete(rootId);
				return;
			}
			throw error;
		}
		if (suspended?.get(id) !== state) {
			this.dropRunning(rootId, id);
			this.drain(rootId, maximum);
			return;
		}
		if (state.count === 0) {
			suspended.delete(id);
			if (suspended.size === 0) this.suspendedByRoot.delete(rootId);
			return;
		}
		this.dropRunning(rootId, id);
		state.resuming = false;
		this.drain(rootId, maximum);
	}

	reserveOutstanding(rootId: string, maximum: number): symbol | undefined {
		const outstanding = this.outstandingByRoot.get(rootId) ?? new Set<symbol>();
		if (outstanding.size >= maximum) return undefined;
		const permit = Symbol(rootId);
		outstanding.add(permit);
		this.outstandingByRoot.set(rootId, outstanding);
		return permit;
	}

	outstanding(rootId: string): number {
		return this.outstandingByRoot.get(rootId)?.size ?? 0;
	}

	releaseOutstanding(rootId: string, permit: symbol): void {
		const outstanding = this.outstandingByRoot.get(rootId);
		if (!outstanding?.delete(permit)) return;
		if (outstanding.size === 0) this.outstandingByRoot.delete(rootId);
		this.cleanupRoot(rootId);
	}

	private rememberMaximum(rootId: string, maximum: number): void {
		this.maximumByRoot.set(rootId, maximum);
	}

	private maximum(rootId: string): number {
		return this.maximumByRoot.get(rootId) ?? 0;
	}

	private drain(rootId: string, maximum: number): void {
		const running = this.runningByRoot.get(rootId) ?? new Set<string>();
		while (running.size < maximum) {
			const resumeQueue = this.resumeWaitersByRoot.get(rootId);
			const normalQueue = this.waitersByRoot.get(rootId);
			const queue = resumeQueue?.length ? resumeQueue : normalQueue;
			const waiter = queue?.shift();
			if (!waiter) break;
			if (queue!.length === 0) {
				if (queue === resumeQueue) this.resumeWaitersByRoot.delete(rootId);
				else this.waitersByRoot.delete(rootId);
			}
			waiter.signal?.removeEventListener("abort", waiter.onAbort!);
			if (waiter.signal?.aborted) {
				waiter.reject(new DOMException("Capacity wait aborted", "AbortError"));
				continue;
			}
			running.add(waiter.id);
			this.runningByRoot.set(rootId, running);
			waiter.resolve();
		}
		if (running.size === 0) this.runningByRoot.delete(rootId);
	}

	private dropRunning(rootId: string, id: string): void {
		const running = this.runningByRoot.get(rootId);
		if (!running?.delete(id)) return;
		if (running.size === 0) this.runningByRoot.delete(rootId);
	}

	private cleanupRoot(rootId: string): void {
		if (this.runningByRoot.has(rootId) || this.waitersByRoot.has(rootId) ||
			this.resumeWaitersByRoot.has(rootId) || this.suspendedByRoot.has(rootId) ||
			this.outstandingByRoot.has(rootId)) return;
		this.maximumByRoot.delete(rootId);
	}

	private rejectWaiters(rootId: string, id: string): void {
		for (const queues of [this.waitersByRoot, this.resumeWaitersByRoot]) {
			const queue = queues.get(rootId);
			if (!queue) continue;
			for (let index = queue.length - 1; index >= 0; index -= 1) {
				const waiter = queue[index]!;
				if (waiter.id !== id) continue;
				queue.splice(index, 1);
				waiter.signal?.removeEventListener("abort", waiter.onAbort!);
				waiter.reject(new DOMException("Capacity wait released", "AbortError"));
			}
			if (queue.length === 0) queues.delete(rootId);
		}
	}
}
