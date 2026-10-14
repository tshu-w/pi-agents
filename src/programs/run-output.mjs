/** The message a `/program` run adds to the Session: `Ran …`, then the Program's result. */
export const PROGRAM_MESSAGE = 'pi-agents-program-run';

const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

/** What `pi -p` prints for a Program result: its text items without codemode's header. */
export function runOutput(content) {
  const [first, ...rest] = content;
  const output = first?.type === 'text' && SCRIPT_HEADER.test(first.text) ? rest : content;
  return output.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n');
}
