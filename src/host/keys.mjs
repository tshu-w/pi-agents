import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_DETACH_KEY = 'ctrl+z';

/** The `pi-agents.detach` keybinding in `keybindings.json`, or its default. */
export function detachKey(agentDir) {
  try {
    const value = JSON.parse(readFileSync(join(agentDir, 'keybindings.json'), 'utf8'))['pi-agents.detach'];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  } catch { /* missing keybindings use the default */ }
  return DEFAULT_DETACH_KEY;
}

/** Whether a key sequence presses the detach key; `tui` is Pi's pi-tui, which parses keys. */
export function detachMatcher(tui, key) {
  return sequence => !tui.isKeyRelease(sequence) && tui.matchesKey(sequence, key);
}
