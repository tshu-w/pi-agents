import { constants } from 'node:fs';
import { open, readFile, realpath, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';
import { discoverRoots } from '../roots/discovery.mjs';
import { isLocked } from '../roots/locks.mjs';

const MARKS_VERSION = 1;

async function readMarks(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (value?.version === MARKS_VERSION && value.sessions && typeof value.sessions === 'object') return value.sessions;
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  return {};
}

/** Session files outside the session directory that the daemon has seen running. */
export async function markedFiles(paths) {
  return Object.values(await readMarks(paths.workbench)).flatMap(mark => mark.sessionFile ?? []);
}

/**
 * The daemon's view of root Sessions: live state reported by running Sessions, and per Session
 * its last finished turn, the last turn the user has seen, and whether the workbench lists it,
 * and where its file is when outside `sessionDir`, kept in `paths.workbench`. A Session with no
 * marks counts as seen.
 */
export async function createSessions(paths, sessionDir) {
  const marks = await readMarks(paths.workbench);
  const live = new Map();
  let saving = Promise.resolve();

  function save() {
    const data = JSON.stringify({ version: MARKS_VERSION, sessions: marks });
    saving = saving.then(async () => {
      const temporary = `${paths.workbench}.${randomUUID()}.tmp`;
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { await file.writeFile(data); } finally { await file.close(); }
      await rename(temporary, paths.workbench);
    }).catch(error => console.error(`[pi-agents] Saving seen marks failed: ${error.message}`));
    return saving;
  }

  function files() {
    return Object.values(marks).flatMap(mark => mark.sessionFile ?? []);
  }

  function finished(id, turn) {
    const mark = marks[id] ??= {};
    if (mark.last && mark.last.at >= turn.at) return false;
    mark.last = { at: turn.at, failed: turn.failed === true };
    return true;
  }

  return {
    /**
     * Records the state a running Session reports; a turn that ends while attached is seen.
     * A Session that runs without a terminal, as the workbench and wakes start it or after a detach, stays listed.
     */
    update(state) {
      // Pi saves a new Session only after its first reply; until then the first report dates it.
      live.set(state.id, { ...state, since: live.get(state.id)?.since ?? new Date().toISOString() });
      let changed = state.turn ? finished(state.id, state.turn) : false;
      if (state.sessionFile && relative(sessionDir, state.sessionFile).startsWith('..') && marks[state.id]?.sessionFile !== state.sessionFile) {
        (marks[state.id] ??= {}).sessionFile = state.sessionFile;
        changed = true;
      }
      if (!state.attached && !marks[state.id]?.listed) {
        (marks[state.id] ??= {}).listed = true;
        changed = true;
      }
      const mark = marks[state.id];
      if (state.attached && mark?.last && (mark.seen ?? 0) < mark.last.at) {
        mark.seen = mark.last.at;
        changed = true;
      }
      if (changed) save();
    },
    /** Forgets a Session that stopped; one that stopped without saying so has failed. */
    end(id, { abnormal = false } = {}) {
      live.delete(id);
      if (abnormal && finished(id, { at: Date.now(), failed: true })) save();
    },
    /** Lists a Session in the workbench, as when the user opens it there. */
    show(id) {
      (marks[id] ??= {}).listed = true;
      save();
    },
    /** Marks a Session's last turn seen, as when the user previews it. */
    see(id) {
      const mark = marks[id];
      if (!mark?.last || (mark.seen ?? 0) >= mark.last.at) return;
      mark.seen = mark.last.at;
      save();
    },
    /** Removes a Session from the workbench list and clears its unseen turn; its file stays. */
    hide(id) {
      const mark = marks[id];
      if (!mark) return;
      delete mark.listed;
      if (mark.last) mark.seen = mark.last.at;
      else delete marks[id];
      save();
    },
    files,
    /** Root Sessions the workbench lists: running ones, listed ones, and ones with an unseen turn. */
    async list({ signal } = {}) {
      const ids = new Set(live.keys());
      for (const [id, mark] of Object.entries(marks)) {
        if (mark.listed || (mark.last && (mark.seen ?? 0) < mark.last.at)) ids.add(id);
      }
      const records = await discoverRoots(sessionDir, { extraFiles: files(), ids, signal });
      const rows = new Map();
      for (const record of records) {
        let status = 'idle';
        if (!live.has(record.id)) {
          try { if (isLocked(paths.locks, await realpath(record.sessionFile), record.id)) status = 'unknown'; }
          catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        }
        rows.set(record.id, { id: record.id, name: record.name, title: record.title, reply: record.reply, cwd: record.cwd, sessionFile: record.sessionFile, updatedAt: record.updatedAt, status });
      }
      for (const state of live.values()) {
        const saved = rows.get(state.id);
        rows.set(state.id, { ...saved, ...state, title: state.title ?? saved?.title, reply: state.reply ?? saved?.reply,
          status: state.blocked ? 'blocked' : state.working ? 'working' : 'idle', running: true, updatedAt: saved?.updatedAt ?? state.since });
      }
      return [...rows.values()].map(row => {
        const mark = marks[row.id];
        const attention = mark?.last && (mark.seen ?? 0) < mark.last.at ? (mark.last.failed ? 'failed' : 'done') : undefined;
        return { ...row, ...(attention ? { attention } : {}), ...(mark?.last ? { finishedAt: mark.last.at } : {}) };
      });
    },
    saved: () => saving,
  };
}
