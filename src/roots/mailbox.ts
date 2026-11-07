import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { statePaths } from "./paths.mjs";
import type { RootMessage } from "./runtime.ts";

/**
 * What a Session has not settled yet, kept across the exit of its process: its inbox holds the messages it
 * accepted that are not in the Session yet, its outbox the inputs it sent to owned Agents that have not ended.
 */
export interface Mailbox {
	inbox: RootMessage[];
	outbox: Array<{ id: string; agentId: string; name: string }>;
}

const mailboxFile = (id: string) => join(statePaths().state, "mailboxes", `${id}.json`);

export function readMailbox(id: string): Mailbox {
	try {
		return { inbox: [], outbox: [], ...JSON.parse(readFileSync(mailboxFile(id), "utf8")) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { inbox: [], outbox: [] };
		throw error;
	}
}

/** Changes a Session's mailbox; `update` returns false when it changed nothing. The file is replaced atomically, and deleted once the mailbox is empty. */
export function updateMailbox(id: string, update: (mailbox: Mailbox) => boolean | void): void {
	const file = mailboxFile(id);
	const mailbox = readMailbox(id);
	if (update(mailbox) === false) return;
	if (mailbox.inbox.length === 0 && mailbox.outbox.length === 0) return rmSync(file, { force: true });
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(mailbox), { mode: 0o600 });
	renameSync(temporary, file);
}
