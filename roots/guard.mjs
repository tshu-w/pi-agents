import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireOwnership, canonicalPath, SessionOccupiedError } from './ownership.mjs';

// Pi does not export its resolvePath; session paths only need ~ and file:// handling.
function resolvePath(input) {
  const path = input.startsWith('file://') ? fileURLToPath(input) : input;
  return resolve(path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
}

const installed = Symbol.for('pi-agents.guard');

/** Patches Pi's Session classes so every persisted Session holds its ownership locks. Idempotent across /reload. */
export function installGuard({ SessionManager, AgentSession, AgentSessionRuntime, parseSessionEntries, stateDir }) {
  const p = SessionManager.prototype;
  if (Object.hasOwn(p, installed)) return p[installed];
  const states = new WeakMap();
  const operations = new AsyncLocalStorage();

  function state(sm) {
    let value = states.get(sm);
    if (!value) {
      value = { held: new Map(), depth: 0, disposed: false };
      states.set(sm, value);
      const scope = operations.getStore();
      if (scope?.collect) scope.managers.add(sm);
    }
    if (value.disposed) throw new Error('Session ownership has been released');
    return value;
  }
  function drop(resource) {
    if (--resource.refs === 0) resource.lease.release();
  }
  function reserve(held, key, file) {
    if (held.has(key)) return;
    const scope = operations.getStore();
    const borrowed = scope?.borrow?.get(key) ?? scope?.reserved?.get(key);
    const resource = borrowed ?? { lease: acquireOwnership({ stateDir, sessionId: key, sessionFile: file }), refs: 0 };
    resource.refs++;
    held.set(key, resource);
  }
  function reserveFile(held, file) {
    reserve(held, `path:${canonicalPath(file)}`, file);
    if (!existsSync(file)) return;
    const entries = parseSessionEntries(readFileSync(file, 'utf8')).filter(Boolean);
    const header = entries[0];
    if (header?.type === 'session' && typeof header.id === 'string') reserve(held, `id:${header.id}`, file);
  }
  function keys(sm) {
    return [`path:${canonicalPath(sm.getSessionFile())}`, `id:${sm.getSessionId()}`];
  }
  function ensure(sm) {
    if (!sm.isPersisted()) return;
    const s = state(sm);
    for (const key of keys(sm)) reserve(s.held, key, sm.getSessionFile());
  }
  function release(sm) {
    if (!sm.isPersisted()) return;
    const s = states.get(sm);
    if (!s || s.disposed) return;
    s.disposed = true;
    for (const resource of s.held.values()) drop(resource);
    s.held.clear();
  }
  for (const name of ['_setSessionFile', 'newSession', '_loadEntries', 'createBranchedSession']) {
    const original = p[name];
    p[name] = function (...args) {
      if (!this.isPersisted()) return original.apply(this, args);
      const s = state(this);
      if (s.depth) return original.apply(this, args);
      const snapshot = Object.fromEntries(Object.entries(this).map(([key, value]) => [key, value instanceof Map ? new Map(value) : value]));
      const oldKeys = new Set(s.held.keys());
      s.depth++;
      try {
        if (name === '_setSessionFile') {
          const file = resolvePath(args[0]);
          // Native loading can repair trailing newlines before migration.
          reserveFile(s.held, file);
        }
        const result = original.apply(this, args);
        ensure(this);
        const keep = new Set(keys(this));
        for (const [key, resource] of s.held) {
          if (!keep.has(key)) { drop(resource); s.held.delete(key); }
        }
        return result;
      } catch (error) {
        Object.assign(this, snapshot);
        for (const [key, resource] of s.held) {
          if (!oldKeys.has(key)) { drop(resource); s.held.delete(key); }
        }
        throw error;
      } finally {
        s.depth--;
        if (name === '_setSessionFile' && operations.getStore()) operations.getStore().borrow = undefined;
      }
    };
  }
  for (const name of ['_persist', '_rewriteFile']) {
    const original = p[name];
    p[name] = function (...args) { ensure(this); return original.apply(this, args); };
  }
  const open = SessionManager.open;
  SessionManager.open = function (file, ...args) {
    const parent = operations.getStore();
    const scope = { managers: parent?.managers ?? new Set(), reserved: new Map(parent?.reserved), borrow: parent?.borrow, collect: parent?.collect ?? true };
    for (const resource of scope.reserved.values()) resource.refs++;
    return operations.run(scope, () => {
      let result;
      try {
        reserveFile(scope.reserved, resolvePath(file));
        result = open.call(this, file, ...args);
        return result;
      } finally {
        if (parent) {
          parent.borrow = undefined;
          // Import reservations protect the copy; the opened manager now owns it.
          for (const resource of parent.reserved.values()) drop(resource);
          parent.reserved.clear();
        }
        for (const resource of scope.reserved.values()) drop(resource);
        if (!parent) for (const sm of scope.managers) if (sm !== result) release(sm);
      }
    });
  };
  SessionManager.forkFrom = function (source, cwd, dir, options) {
    const scope = { managers: new Set(), reserved: new Map(), collect: true };
    return operations.run(scope, () => {
      let result;
      try {
        const sourcePath = resolvePath(source);
        // Fork history is a read-only snapshot; the source runtime may stay open.
        const entries = parseSessionEntries(readFileSync(sourcePath, 'utf8')).filter(Boolean);
        if (entries[0]?.type !== 'session' || typeof entries[0].id !== 'string') throw new Error(`Cannot fork: invalid session: ${sourcePath}`);
        // Native forkFrom writes before constructing its manager. Create the native
        // manager first so both its generated path and ID are reserved before IO.
        const manager = SessionManager.create(cwd, dir, options);
        const header = { ...manager.getHeader(), parentSession: sourcePath };
        const content = [header, ...entries.filter(entry => entry.type !== 'session')];
        writeFileSync(manager.getSessionFile(), `${content.map(entry => JSON.stringify(entry)).join('\n')}\n`, { flag: 'wx' });
        manager.setSessionFile(manager.getSessionFile());
        result = manager;
        return result;
      } finally {
        for (const resource of scope.reserved.values()) drop(resource);
        for (const sm of scope.managers) if (sm !== result) release(sm);
      }
    });
  };
  const dispose = AgentSession.prototype.dispose;
  AgentSession.prototype.dispose = function (...args) {
    const result = dispose.apply(this, args);
    release(this.sessionManager);
    return result;
  };
  const rp = AgentSessionRuntime.prototype;
  const teardown = rp.teardownCurrent;
  rp.teardownCurrent = function (...args) {
    const scope = operations.getStore();
    if (scope) scope.collect = false;
    return teardown.apply(this, args);
  };
  const beforeFork = rp.emitBeforeFork;
  rp.emitBeforeFork = async function (...args) {
    const result = await beforeFork.apply(this, args);
    const scope = operations.getStore();
    if (!result.cancelled && scope?.kind === 'fork') {
      scope.collect = true;
      scope.borrow = state(this.session.sessionManager).held;
    }
    return result;
  };
  const beforeSwitch = rp.emitBeforeSwitch;
  rp.emitBeforeSwitch = async function (...args) {
    const result = await beforeSwitch.apply(this, args);
    const scope = operations.getStore();
    if (!result.cancelled && scope) scope.collect = true;
    if (!result.cancelled && scope?.kind === 'importFromJsonl') {
      const file = resolvePath(scope.input);
      reserveFile(scope.reserved, file);
      reserve(scope.reserved, `path:${canonicalPath(resolvePath(args[1]))}`, resolvePath(args[1]));
    }
    return result;
  };
  for (const kind of ['switchSession', 'newSession', 'fork', 'importFromJsonl']) {
    const original = rp[kind];
    rp[kind] = async function (...args) {
      const previous = this.session;
      const scope = { kind, input: args[0], managers: new Set(), reserved: new Map(), collect: false };
      return operations.run(scope, async () => {
        try { return await original.apply(this, args); }
        catch (error) {
          if (error instanceof SessionOccupiedError && this.session === previous && !states.get(previous.sessionManager)?.disposed) {
            previous.extensionRunner.createContext().ui.notify(error.message, 'warning');
            return { cancelled: true };
          }
          throw error;
        } finally {
          scope.borrow = undefined;
          for (const resource of scope.reserved.values()) drop(resource);
          scope.reserved.clear();
          for (const sm of scope.managers) if (sm !== this.session.sessionManager) release(sm);
        }
      });
    };
  }
  const guard = { release };
  Object.defineProperty(p, installed, { value: guard });
  return guard;
}
