// The workbench: lists root Sessions from the daemon, attaches to them, and sends them messages.
// It runs outside Pi, so it loads pi-tui and Pi's theme from the package of the `pi` it wraps.
import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { alive, attach, listHosts, startHost } from './host/client.mjs';
import { detachKey, detachMatcher } from './host/keys.mjs';
import { piPackage } from './pi.mjs';
import { ensureDaemon, sendViaDaemon } from './daemon/client.mjs';
import { openStream } from './roots/transport.mjs';

const ALT_SCREEN = '\x1b[?1049h\x1b[H\x1b[2J';
const MAIN_SCREEN = '\x1b[?1049l';

async function loadPi(executable) {
  const root = piPackage(executable);
  const load = path => import(pathToFileURL(path).href);
  // Internal modules are the same files Pi's index loads, so their state is shared with it.
  const [tui, pi, themes, themeController, keys, logo, hints] = await Promise.all([
    load(createRequire(join(root, 'package.json')).resolve('@earendil-works/pi-tui')),
    load(join(root, 'dist/index.js')),
    load(join(root, 'dist/modes/interactive/theme/theme.js')),
    load(join(root, 'dist/modes/interactive/theme/theme-controller.js')),
    load(join(root, 'dist/core/keybindings.js')),
    load(join(root, 'dist/modes/interactive/components/pi-logo.js')),
    load(join(root, 'dist/modes/interactive/components/keybinding-hints.js')),
  ]);
  return { tui, pi, themes, themeController, keys, logo, hints };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).join('\n') : '';
}

/** The messages on the Session's active branch since its last compaction, oldest first. */
async function branchMessages(file) {
  const entries = new Map();
  let leaf;
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry?.id !== 'string' || entry.type === 'session') continue;
    entries.set(entry.id, entry);
    leaf = entry;
  }
  const messages = [];
  for (let entry = leaf; entry && entry.type !== 'compaction'; entry = entries.get(entry.parentId)) {
    if (entry.type === 'message' && entry.message) messages.push(entry.message);
    else if (entry.type === 'custom_message') messages.push({ role: 'custom', ...entry });
  }
  return messages.reverse();
}

function age(ms) {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

const time = session => Math.max(session.finishedAt ?? 0, Date.parse(session.updatedAt ?? '') || 0);
const label = session => session.name || session.title || session.id.slice(0, 8);
// Notices quote the label, since a title can read as part of the notice.
const named = session => `"${label(session)}"`;
const COMMANDS = [
  { value: '/resume', label: 'resume', description: 'Open a past Session' },
  { value: '/quit', label: 'quit', description: 'Exit the workbench' },
];
// Pi's working spinner.
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const GROUPS = [
  ['attention', 'Needs input', 'Sessions waiting on you or with a finished turn you have not seen land here'],
  ['working', 'Working', 'Sessions Pi is working on; they keep running after you leave'],
  ['completed', 'Completed', 'Sessions you have seen wait here'],
];

function stateOf(session) {
  if (session.attention || session.status === 'blocked') return 'attention';
  return session.status === 'working' || session.agents > 0 ? 'working' : 'completed';
}

/**
 * Runs the workbench until the user quits.
 * @param {{ pi: string, paths: ReturnType<typeof import('./roots/paths.mjs').statePaths>, sessionDir: string }} options
 */
export async function workbench({ pi: executable, paths, sessionDir }) {
  const { tui: T, pi, themes, themeController, keys, logo, hints } = await loadPi(executable);
  const { theme } = themes;
  const agentDir = pi.getAgentDir();
  const settings = pi.SettingsManager.create(process.cwd(), agentDir);
  themes.initTheme(settings.getTheme());
  T.setCapabilityOverrides(settings.getTerminalCapabilityOverrides());
  const keybindings = keys.KeybindingsManager.create(agentDir);
  const detach = detachKey(agentDir), isDetach = detachMatcher(T, detach);
  T.setKeybindings(keybindings);

  const terminal = new T.ProcessTerminal();
  const ui = new T.TuiMainScreen(terminal);
  // Resolves theme pairs such as `light/dark` from the terminal's colors, as Pi does.
  const themeSync = new themeController.InteractiveThemeController(ui, {
    getSettingsManager: () => settings,
    showError: message => say(message, 'error'),
    onChanged: () => ui.requestRender(true),
  });
  const env = Object.fromEntries(Object.entries(process.env).filter(entry => entry[1] !== undefined));
  let sessions = [], stream, connected = false, quitting = false;
  // `picked` is the Session last chosen with `@` and its mention; a message starting with the mention goes to it.
  let selectedKey, top = 0, notice, modal, pane, picked, lastCtrlC = 0, finish;
  // Messages in flight by Session ID; each settles once the daemon has delivered it, waking the Session if needed.
  const sending = new Map();

  /** How `@` refers to a Session: its name when that is one word, otherwise the shortest unique ID prefix. */
  function mention(session) {
    if (session.name && !/\s/.test(session.name)) return session.name;
    for (let length = 8; length < session.id.length; length++) {
      const prefix = session.id.slice(0, length);
      if (!sessions.some(other => other.id !== session.id && other.id.startsWith(prefix))) return prefix;
    }
    return session.id;
  }

  // Notices read as Pi's: statuses are dim, and warnings and errors carry their prefix.
  const PREFIXES = { warning: 'Warning: ', error: 'Error: ' };
  function say(text, color = 'dim') {
    notice = text && theme.fg(color, `${PREFIXES[color] ?? ''}${text}`);
    ui.requestRender();
  }

  /**
   * Rows in display order: gaps, group headers, notes for empty groups, and Sessions; `choices` are the Sessions.
   * Rebuilt only when the daemon sends new Sessions, since a key press reads them several times.
   */
  let layout;
  function rows() {
    if (layout?.sessions === sessions) return layout;
    const list = [];
    const sorted = sessions.map(session => ({ session, time: time(session) })).sort((a, b) => b.time - a.time).map(entry => entry.session);
    for (const [state, title, note] of GROUPS) {
      const members = sorted.filter(session => stateOf(session) === state);
      if (list.length) list.push({ gap: true });
      list.push({ header: title });
      if (!members.length) list.push({ note });
      for (const session of members) list.push({ key: session.id, session });
    }
    layout = { sessions, list, choices: list.filter(row => row.key) };
    return layout;
  }

  const selectable = () => rows().choices;
  function selected() {
    const choices = selectable();
    return choices.find(row => row.key === selectedKey) ?? choices[0];
  }

  function move(step) {
    const choices = selectable();
    if (!choices.length) return;
    const index = Math.max(0, choices.findIndex(row => row.key === selected()?.key));
    selectedKey = choices[Math.min(choices.length - 1, Math.max(0, index + step))].key;
    ui.requestRender();
  }

  // The shape shows whether the process is alive, the color the Session's state.
  function icon(session) {
    if (session.status === 'working') return theme.fg('accent', SPINNER[Math.floor(Date.now() / 80) % SPINNER.length]);
    if (session.status === 'unknown') return theme.fg('dim', '?');
    if (session.status === 'blocked') return theme.fg('warning', '●');
    const shape = session.running ? '●' : '○';
    if (session.attention === 'failed') return theme.fg('error', shape);
    if (session.attention === 'done') return theme.fg('success', shape);
    return theme.fg('dim', shape);
  }

  function activity(session) {
    let text = session.status === 'working' ? (session.tool ? `running ${session.tool}` : 'working')
      : session.status === 'blocked' ? 'waiting for your answer'
      : session.status === 'unknown' ? 'running outside the workbench' : session.reply ?? '';
    if (session.agents > 0) text += `${text ? ' · ' : ''}${session.agents} ${session.agents === 1 ? 'agent' : 'agents'} running`;
    return theme.fg('muted', text);
  }

  function renderRow(row, isSelected, width) {
    const pointer = isSelected ? theme.fg('accent', theme.bold('❯ ')) : '  ';
    const { session } = row;
    const nameWidth = Math.min(32, Math.max(12, Math.floor(width * 0.3)));
    const name = T.truncateToWidth(label(session), nameWidth, '…', true);
    const right = theme.fg('dim', `  ${age(time(session)).padStart(3)}`);
    const room = width - 4 - nameWidth - 2 - T.visibleWidth(right);
    const middle = room > 0 ? T.truncateToWidth(activity(session), room, '…', true) : '';
    return truncate(`${pointer}${icon(session)} ${isSelected ? theme.bold(name) : name}  ${middle}${right}`, width);
  }

  /** Pi's startup header: the logo, then the title and counts, then key hints. */
  function header(width) {
    const counts = GROUPS.map(([state, title]) => `${sessions.filter(session => stateOf(session) === state).length} ${title.toLowerCase()}`).join(' · ');
    const title = `${theme.bold('Pi Agents')}${theme.fg('dim', ` · ${connected ? counts : 'connecting…'}`)}`;
    // While the preview is open, the keys are its own: Enter may send a message, so `app.tools.expand` attaches.
    const keys = pane ? [
      hints.keyHint('app.tools.expand', 'attach'),
      hints.rawKeyHint(`${hints.keyText('tui.altScreen.pageUp')}/${hints.keyText('tui.altScreen.pageDown')}`, 'scroll'),
      hints.rawKeyHint('esc', 'close'),
    ].join(theme.fg('muted', ' · ')) : [
      hints.rawKeyHint('enter', 'attach'),
      hints.rawKeyHint(detach, 'quit'),
      hints.rawKeyHint('space', 'preview'),
      hints.rawKeyHint('ctrl+x', 'stop'),
      hints.rawKeyHint('ctrl+d', 'remove'),
      hints.rawKeyHint('@', 'message'),
      hints.rawKeyHint('/', 'commands'),
    ].join(theme.fg('muted', ' · '));
    const [first, second] = logo.supportsPiLogo() ? logo.piLogoLines().map(line => `${line} `) : [`${logo.piWordmark()} `, ''];
    return [truncate(` ${first}${title}`, width), truncate(` ${second}${keys}`, width)];
  }

  const truncate = (line, width) => T.truncateToWidth(line, width);

  const editor = new T.Editor(ui, themes.getEditorTheme());
  editor.focused = true;
  editor.onSubmit = text => {
    void submit(text.trim());
    // The preview stays open, ready for another message to its Session.
    if (pane) editor.setText(pane.mention);
  };
  // Completes commands after `/` at the start of the input; `@` opens Pi's session picker instead.
  editor.setAutocompleteProvider({
    async getSuggestions(lines, cursorLine, cursorCol) {
      const before = cursorLine === 0 ? lines[0].slice(0, cursorCol) : '';
      if (!/^\/\S*$/.test(before)) return null;
      const items = COMMANDS.filter(item => item.value.startsWith(before));
      return items.length ? { items, prefix: before } : null;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const start = cursorCol - prefix.length;
      const text = `${item.value} `;
      return { lines: lines.with(cursorLine, lines[cursorLine].slice(0, start) + text + lines[cursorLine].slice(cursorCol)), cursorLine, cursorCol: start + text.length };
    },
  });

  const root = {
    invalidate() {
      editor.invalidate();
      pane?.invalidate();
    },
    render(width) {
      if (modal) return modal.render(width);
      const lines = ['', ...header(width), ''];
      const input = ['', notice ? truncate(` ${notice}`, width) : '', ...editor.render(width)];
      const { list } = rows();
      // The preview sits between the list and the input. It may take all the space the list leaves, and the
      // list keeps at least a third of it.
      const space = terminal.rows - lines.length - input.length;
      const preview = pane?.render(width, Math.max(5, space - Math.min(list.length, Math.floor(space / 3)))) ?? [];
      const current = selected()?.key;
      // The selected row, and its group header when it fits, stay on screen. When the selection leaves the
      // screen, the list scrolls by half a screen, so most key presses redraw two rows rather than the whole list.
      const height = Math.max(3, terminal.rows - lines.length - preview.length - input.length);
      const index = Math.max(0, list.findIndex(row => row.key === current));
      const anchor = list[index - 1]?.header ? index - 1 : index;
      if (anchor < top || index >= top + height) top = anchor - Math.floor(height / 2);
      top = Math.max(0, Math.min(top, list.length - height));
      const visible = list.slice(top, top + height);
      for (const row of visible) {
        lines.push(row.gap ? '' : row.header ? truncate(theme.bold(row.header), width)
          : row.note ? truncate(theme.fg('dim', `  ${row.note}`), width)
            : renderRow(row, row.key === current, width));
      }
      // The input stays at the bottom of the screen, as in Pi's fullscreen mode.
      lines.push(...preview, ...Array(height - visible.length).fill(''), ...input);
      return lines;
    },
    handleInput(data) {
      // Holding only the preview's mention, the input counts as empty.
      const empty = ['', pane?.mention].includes(editor.getText());
      // As in a Session, the detach key leaves and everything keeps running.
      if (isDetach(data)) return void quit();
      if (pane?.handleInput(data, empty)) return;
      if (T.matchesKey(data, 'ctrl+c')) {
        if (!empty) return editor.setText(pane?.mention ?? '');
        if (Date.now() - lastCtrlC < 1000) return void quit();
        lastCtrlC = Date.now();
        return say('Press Ctrl+C again to quit');
      }
      if (T.matchesKey(data, 'ctrl+x')) return interrupt();
      if (empty && keybindings.matches(data, 'app.session.delete')) return void remove(selected()?.session);
      // The preview's mention stays: an edit that would remove or change it is undone.
      if (pane) {
        const before = editor.getText();
        editor.handleInput(data);
        if (pane && !editor.getText().startsWith(pane.mention)) editor.setText(before);
        return;
      }
      if (empty && T.matchesKey(data, 'escape')) return void quit();
      if (empty && T.matchesKey(data, 'up')) return move(-1);
      if (empty && T.matchesKey(data, 'down')) return move(1);
      if (empty && T.matchesKey(data, 'enter')) return void open(selected());
      if (empty && T.matchesKey(data, 'space')) return void preview(selected()?.session);
      if (empty && data === '@') return pick(session => {
        picked = { session, mention: `@${mention(session)} ` };
        if (sessions.some(other => other.id === session.id)) selectedKey = session.id;
        editor.setText(picked.mention);
      });
      editor.handleInput(data);
    },
  };

  function showModal(component) {
    modal = component;
    ui.setFocus(component);
    ui.requestRender(true);
  }
  function closeModal() {
    modal = undefined;
    ui.setFocus(root);
    ui.requestRender(true);
  }

  async function connect() {
    while (!quitting) {
      try {
        await ensureDaemon(paths, { sessionDir });
        stream = await openStream(paths.daemon, { action: 'stream', role: 'workbench' }, {
          onMessage(message) {
            if (message?.type !== 'sessions' || !Array.isArray(message.sessions)) return;
            sessions = message.sessions;
            ui.requestRender();
          },
          onClose() {
            stream = undefined;
            connected = false;
            ui.requestRender();
            // A daemon that retires for an update hands over to the next one.
            if (!quitting) void connect();
          },
        });
        connected = true;
        ui.requestRender();
        return;
      } catch (error) {
        say(`Cannot reach the daemon: ${error.message}`, 'error');
        await delay(1000);
      }
    }
  }

  async function attachTo(socket) {
    ui.stop();
    let result;
    try { result = await attach(socket, { isDetach }); }
    finally {
      process.stdout.write(ALT_SCREEN);
      ui.start();
      ui.requestRender(true);
    }
    if (result.reason === 'exited') say('Pi exited.');
    else if (result.reason === 'closed') say(`The host stopped unexpectedly. See ${paths.hostLog}`, 'error');
    else if (result.reason === 'takeover') say('Attached in another terminal.');
    else say('');
  }

  /** The host running a Session; a host whose Pi has not reported its Session yet may be starting it, so wait for that. */
  async function findHost(id) {
    const deadline = performance.now() + 10000;
    for (;;) {
      const hosts = await listHosts(paths);
      const hosted = hosts.find(host => host.session?.id === id);
      if (hosted || !hosts.some(host => !host.session) || performance.now() > deadline) return hosted;
      await delay(100);
    }
  }

  /** Attaches to a Session, starting it in a host when it is not running. */
  async function openSession(session) {
    stream?.send({ type: 'show', id: session.id });
    try {
      // A message just sent may be waking the Session in a host.
      await sending.get(session.id);
      const hosted = await findHost(session.id);
      if (hosted) return await attachTo(hosted.socket);
      if (session.running || session.status === 'unknown') {
        return say(`${named(session)} runs outside a host; attach it after it exits.`, 'warning');
      }
      say(`Starting ${named(session)}…`);
      const socket = await startHost(paths, {
        pi: executable, args: ['--session', session.sessionFile], cwd: session.cwd,
        cols: process.stdout.columns, rows: process.stdout.rows, waitForTerminal: true,
      });
      await attachTo(socket);
    } catch (error) { say(error.message, 'error'); }
  }

  async function open(row) {
    if (row) await openSession(row.session);
  }

  function interrupt() {
    const session = selected()?.session;
    if (!['working', 'blocked'].includes(session?.status) || !stream) return say('The selected Session is not working.', 'warning');
    stream.send({ type: 'interrupt', id: session.id });
    say(`Stopping ${named(session)}…`);
  }

  /**
   * Removes a Session from the list; `/resume` brings it back. An idle Session in a host no terminal
   * is attached to quits first, as Pi does on SIGTERM; any other running Session always stays listed.
   */
  async function remove(session) {
    if (!session || !stream) return;
    if (session.running) {
      const host = session.status === 'idle' && (await listHosts(paths)).find(host => host.session?.id === session.id);
      if (!host || host.attached) return say(`Quit ${named(session)} before removing it.`, 'warning');
      say(`Quitting ${named(session)}…`);
      process.kill(host.pid, 'SIGTERM');
      for (let wait = 0; alive(host.pid); wait += 100) {
        if (wait >= 5000) return say(`${named(session)} did not quit; attach it to see why.`, 'warning');
        await delay(100);
      }
    } else if (session.status !== 'idle') return say(`Quit ${named(session)} before removing it.`, 'warning');
    stream.send({ type: 'hide', id: session.id });
    if (pane?.session.id === session.id) pane.close();
    const choices = selectable();
    const index = choices.findIndex(row => row.key === session.id);
    selectedKey = (choices[index + 1] ?? choices[index - 1])?.key;
    sessions = sessions.filter(other => other.id !== session.id);
    say(`Removed ${named(session)}; /resume brings it back.`);
  }

  async function preview(session) {
    if (!session?.sessionFile) return;
    let messages;
    try { messages = await branchMessages(session.sessionFile); }
    catch (error) { return say(error.message, 'error'); }
    let body = conversation(messages);
    const border = themes.getEditorTheme().borderColor;
    let scroll = 0, page = 1, timer;
    // A turn the preview shows counts as seen.
    const see = () => stream?.send({ type: 'see', id: session.id });
    see();
    // Pi appends each finished message to the file, so the preview follows the Session as it works.
    const watcher = watch(session.sessionFile, () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try { body = conversation(await branchMessages(session.sessionFile)); }
        catch (error) { return say(error.message, 'error'); }
        see();
        ui.requestRender();
      }, 100);
    });
    const close = () => {
      watcher.close();
      see();
      clearTimeout(timer);
      // A draft stays, still addressed to the Session.
      if (editor.getText() === pane?.mention) editor.setText('');
      pane = undefined;
      ui.requestRender(true);
    };
    // The input starts with a mention of the Session, so typed text goes to it as `@` messages do.
    // While the input holds nothing else, the preview takes the list's keys too.
    pane = {
      session,
      mention: `@${mention(session)} `,
      close,
      invalidate() { body.invalidate(); },
      /** A short conversation takes only its own height; a longer one takes `max` lines and scrolls. */
      render(width, max) {
        const current = sessions.find(other => other.id === session.id) ?? session;
        const live = ['working', 'blocked', 'unknown'].includes(current.status) ? `  ${icon(current)} ${activity(current)}` : '';
        const head = truncate(` ${theme.bold(label(session))}  ${theme.fg('dim', session.cwd ?? '')}${live}`, width);
        const lines = body.render(width);
        page = Math.max(1, max - 2);
        scroll = Math.min(scroll, Math.max(0, lines.length - page));
        const end = lines.length - scroll;
        return [border('─'.repeat(width)), head, ...lines.slice(Math.max(0, end - page), end)];
      },
      /** Enter, `↑`/`↓`, and Space act on the preview only while no message is typed. */
      handleInput(data, empty) {
        if (keybindings.matches(data, 'app.tools.expand') || (empty && T.matchesKey(data, 'enter'))) {
          close();
          void openSession(session);
          return true;
        }
        if (!empty && T.matchesKey(data, 'escape')) {
          editor.setText(pane.mention);
          return true;
        }
        if (T.matchesKey(data, 'escape') || (empty && (T.matchesKey(data, 'space') || T.matchesKey(data, 'ctrl+c')))) {
          close();
          return true;
        }
        const step = empty && T.matchesKey(data, 'up') ? 1 : empty && T.matchesKey(data, 'down') ? -1
          : keybindings.matches(data, 'tui.altScreen.pageUp') ? page - 1 : keybindings.matches(data, 'tui.altScreen.pageDown') ? 1 - page : 0;
        if (!step) return false;
        scroll = Math.max(0, scroll + step);
        ui.requestRender();
        return true;
      },
    };
    editor.setText(pane.mention);
    ui.requestRender(true);
  }

  /** Messages and replies as Pi shows them; thinking is left out and each run of tool calls folds to one line. */
  function conversation(messages) {
    const markdown = themes.getMarkdownTheme();
    const view = new T.Container();
    let tools = [];
    const fold = () => {
      if (!tools.length) return;
      // Pi's hint for folded output: "... (36 more lines, …)".
      const names = [...new Set(tools)].join(', ');
      view.addChild(new T.Spacer(1));
      view.addChild(new T.Text(theme.fg('muted', `... (${tools.length} tool call${tools.length > 1 ? 's' : ''}: ${names})`), 1, 0));
      tools = [];
    };
    for (const message of messages) {
      const user = message.role === 'user' || (message.role === 'custom' && message.customType === 'pi-agents' && message.details?.user);
      if (user) {
        const text = textOf(message.content).trim();
        if (!text) continue;
        fold();
        view.addChild(new T.Spacer(1));
        view.addChild(new pi.UserMessageComponent(text, markdown));
      } else if (message.role === 'assistant') {
        const content = message.content.filter(part => part.type === 'text' && part.text.trim());
        if (content.length || ['error', 'aborted', 'length'].includes(message.stopReason)) {
          fold();
          view.addChild(new pi.AssistantMessageComponent({ ...message, content }, true, markdown));
        }
        tools.push(...message.content.flatMap(part => part.type === 'toolCall' ? [part.name] : []));
      }
    }
    fold();
    if (!view.children.length) view.addChild(new T.Text(theme.fg('dim', 'No messages yet.'), 1, 1));
    return view;
  }

  async function send(session, body) {
    say(`Sending to ${named(session)}…`);
    const message = { id: randomUUID(), user: true, recipient: session.id, body };
    const pending = sendViaDaemon(paths, message, { sessionDir, launch: { command: executable, args: [], env } });
    const settled = pending.then(() => {}, () => {});
    sending.set(session.id, settled);
    void settled.then(() => { if (sending.get(session.id) === settled) sending.delete(session.id); });
    try {
      const receipt = await pending;
      if (receipt?.accepted !== true || receipt.messageId !== message.id) throw new Error(`Invalid acknowledgement from ${named(session)}; it may have received the message.`);
      say(`Sent to ${named(session)}.`);
    } catch (error) { say(error.message, 'error'); }
  }

  /** Opens Pi's session picker over all directories, newest first. */
  function pick(onPick) {
    const { SessionManager, SessionSelectorComponent } = pi;
    // Pi lists its default directory by cwd, and a configured one as a whole.
    const configured = sessionDir === join(agentDir, 'sessions') ? undefined : sessionDir;
    const selector = new SessionSelectorComponent(
      (onProgress, signal) => SessionManager.list(process.cwd(), configured, onProgress, signal),
      (onProgress, signal) => configured ? SessionManager.listAll(configured, onProgress, signal) : SessionManager.listAll(onProgress, signal),
      async file => {
        closeModal();
        const known = sessions.find(session => session.sessionFile === file);
        if (known) return onPick(known);
        try {
          const header = JSON.parse((await readFile(file, 'utf8')).split('\n', 1)[0]);
          onPick({ id: header.id, cwd: header.cwd, sessionFile: file });
        } catch (error) { say(error.message, 'error'); }
      },
      closeModal, quit, () => ui.requestRender(), { keybindings },
    );
    // Past Sessions of every directory, newest first, as Tab and the sort key would switch to.
    selector.getSessionList().onToggleScope?.();
    selector.getSessionList().onToggleSort?.();
    showModal(selector);
  }

  async function submit(text) {
    if (!text) return;
    editor.addToHistory(text);
    if (text === '/quit') return quit();
    if (text === '/resume') return pick(session => void openSession(session));
    // A message goes to the previewed Session, or else to the one chosen with `@`; names are not looked up.
    if (text.startsWith('@')) {
      const target = pane ?? picked;
      if (!target || !`${text} `.startsWith(target.mention)) return say('Press @ on an empty input to choose a Session.', 'warning');
      const body = text.slice(target.mention.length).trim();
      if (body) await send(target.session, body);
      return;
    }
    try {
      await startHost(paths, { pi: executable, args: [text], cwd: process.cwd(), cols: process.stdout.columns, rows: process.stdout.rows });
      say('Started a new Session.');
    } catch (error) { say(error.message, 'error'); }
  }

  async function quit() {
    if (quitting) return;
    quitting = true;
    stream?.close();
    // Late key releases would otherwise leak into the shell, as Pi avoids on exit.
    themeSync.disableAutoSync();
    await terminal.drainInput(1000);
    ui.stop();
    process.stdout.write(`${MAIN_SCREEN}Sessions keep running. To reopen, run pd agents\n`);
    finish();
  }

  ui.addChild(root);
  ui.setFocus(root);
  process.stdout.write(ALT_SCREEN);
  ui.start();
  themeSync.applyFromSettings();
  // Ages in rows move on, and working Sessions spin.
  let tick = 0;
  setInterval(() => {
    if (++tick % 125 === 0 || sessions.some(session => session.status === 'working')) ui.requestRender();
  }, 80).unref();
  void connect();
  await new Promise(resolve => { finish = resolve; });
}
