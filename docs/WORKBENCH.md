# Pi Agents Workbench

## 1. Overview

The workbench shows the user's root Sessions in one terminal view. From it the
user opens a Session, reads its latest result, or sends it a message. Sessions
started with `pd` keep running after their terminal closes.

Three kinds of process take part:

- **Host**: one per Session. It runs Pi's full TUI in a pseudo-terminal and
  relays it to whichever terminal is attached.
- **Daemon**: one per user. It tracks Sessions, delivers messages, and starts
  hosts.
- **Workbench**: the daemon's terminal view, opened with `pd agents`.

Every running root Session reports its state to the daemon. The daemon starts
when a Session or the workbench first needs it, and exits 30 seconds after its
last connection closes.

Files live in `${XDG_STATE_HOME:-~/.local/state}/pi/agents/`:

- `workbench.json`: seen marks and which Sessions are listed. The file is
  versioned.
- `host.log`, `daemon.log`: logs.

Sockets and Session locks go in `$XDG_RUNTIME_DIR/pi-agents/`. macOS has no
`XDG_RUNTIME_DIR`, so there they go in `runtime/` under the state directory.

## 2. Setup

Install with npm to get the `pd` command, also named `pi-agents`, then have Pi
load the extension from the same copy, so the command and the extension are
always the same version:

    npm install -g @tshu-w/pi-agents
    pi install "$(npm root -g)/@tshu-w/pi-agents"

`pd` runs whichever `pi` is on `PATH`. Sessions started with plain `pi` also
load the extension, but run outside hosts and end with their terminal.

## 3. Commands

- `pd [pi options]` starts Pi interactively in a new host and attaches the
  terminal. If the Session is already running in a host, `pd` attaches to it
  instead.
- `pd agents` opens the workbench.
- `pd attach <session>` attaches to a Session, starting it first if it is not
  running.
- Non-interactive starts (`-p`, `--mode`, piped stdin) and package commands
  (`pd install`, `pd update`, ...) run Pi directly.

A host inherits the environment of the process that asked for it, because Pi
reads terminal features from the environment once, at startup.

A Session running outside a host still appears in the workbench, but can be
attached only after it exits.

## 4. Attach and detach

Only one terminal is attached at a time. A new terminal takes over, and the
previous one is told how to reattach.

On attach, the host restores the screen and the terminal modes Pi has set
(keyboard protocols, bracketed paste, mouse, title, program status). Images
come back when the host then has Pi redraw.

A host started from a terminal waits for that terminal to attach before it
starts Pi, so Pi detects the terminal's colors and keyboard protocol just as it
would without a host. A host started in the background passes the queries Pi
sent at startup to the first terminal that attaches, and Pi finishes detecting
then.

Closing the window, pressing `Ctrl+Z` (the `pi-agents.detach` keybinding), or
running `/detach` detaches. The Session keeps running, and the terminal prints:

    Pi keeps running. To reattach, run pd attach <session>

A host disables suspend, since a suspended Pi would stay stopped; `Ctrl+Z`
detaches in its place.

A detached Session exits once its tree has had no live work for 5 minutes. A
message to a Session that is not running starts it in a host, detached.

## 5. Workbench

The list shows running Sessions, Sessions that ran without a terminal (started
here, woken by a message, or detached), Sessions opened here, and Sessions
with an unseen turn. Older Sessions are reached with `/resume`.

Each row shows a root Session's name and what it did last. The name is the
Session name, or else the first line of its first message. While the Session
works, the row shows the running tool; otherwise, the start of its last reply.
Running owned Agents and Programs are counted, as in `3 agents running`.

Rows are grouped by state, newest first in each group:

- **Needs input**: a dialog waiting for the user, or a finished turn the user
  has not seen. A turn that failed after Pi's retries, or a host that exited
  abnormally, is marked failed.
- **Working**: the Session or its tree has live work.
- **Completed**: everything else.

While a Session works, its icon spins. Otherwise the shape tells whether Pi is
still running (`●`) or has exited (`○`), and the color marks a finished (green)
or failed (red) turn, or a dialog waiting for the user (yellow). The header
shows Pi's logo, the size of each group, and key hints.

A turn counts as seen once it has been shown in an attached terminal. Sessions
from before the workbench start out seen. A Session that holds its lock but is
not reporting to the daemon, as while its Pi exits, shows as unknown (`?`); the
daemon checks it again every second until that changes.

Keys:

- `Enter` attaches; detaching returns here.
- `Space` previews the selected Session below the list: the conversation
  since the last compaction, with thinking left out and each run of tool
  calls folded to one line, such as `... (6 tool calls: bash, read, edit)`.
  The preview follows the Session as it works.
  The input keeps `@<session>` at its start, so a message goes to the
  previewed Session. In the preview:
  - `Enter` sends a typed message; with none typed, it attaches.
  - `Ctrl+O` (`app.tools.expand`) attaches.
  - The page keys of fullscreen mode (`tui.altScreen.pageUp`/`pageDown`)
    scroll; with no message typed, `↑`/`↓` scroll too.
  - `Esc` clears a typed message; with none typed, it closes the preview.
- `Ctrl+X` stops the current turn, as `app.interrupt` does.
- `Ctrl+D` removes the selected Session from the list. Its file stays, and
  `/resume` brings it back. A running Session must quit first.
- `Ctrl+Z` (`pi-agents.detach`) exits the workbench, as detaching leaves a
  Session; every Session keeps running.

The input at the bottom:

- `@` on an empty input opens Pi's session picker. The chosen Session is
  selected in the list, and the input starts with `@<session>`; the text after
  it goes to that Session as a user message. After `/`, Tab completes a
  command.
- `/resume` opens Pi's session picker over all directories, newest first, and
  attaches the chosen Session. `Ctrl+D` in the picker deletes a Session file.
- `/quit` exits the workbench, as do `Esc` and `Ctrl+C` twice on an empty
  input.
- Any other text starts a new Session in the current directory with Pi's
  default settings, detached.

## 6. Upgrades

A host keeps running the version it started with until its Session exits.
When the daemon sees a newer pi-agents version, it restarts once idle, and
Sessions reconnect to the new daemon.

## 7. Platform

macOS and Linux. Every dependency is pure JavaScript or prebuilt: hosts use
`@lydell/node-pty`, and a Session lock is a file that records the process
holding it.

## Not in this version

Attaching several terminals to one Session, Sessions on other machines,
model-written summaries, and a confirmation before quitting while work is
running. Keeping Sessions alive across host crashes and reboots needs a
durable runtime, which [Pi Durable](https://earendil.com/posts/pi-durable/)
explores.
