import { readFileSync } from 'node:fs';

/**
 * The main Agents' Session files by entry name, as `main.json` at `path` maps them; none when it is missing.
 * @param {string} path
 * @returns {Record<string, string>}
 */
export function readMains(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
