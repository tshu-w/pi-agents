# Changelog

## [Unreleased]

### Added

- `list` shows each Agent's model as `--model` takes it, such as `anthropic/claude-opus-5-5:high`.

### Changed

- A foreground Program still running after 120 seconds moves to the background, and its caller gets a notification when it ends.

### Fixed

- A message to a Session that is not running no longer fails when its Pi takes more than 10 seconds to start.
- A turn that answered another Agent's message with `send` stays out of Needs attention.
- A Session that quits normally is no longer marked failed in the workbench because its exit message was lost.
- The workbench, its preview, and `/tasks` stay responsive with large Session files.
- Connecting to a Session or daemon just as it starts no longer fails with `SOCKET_MODE`.
- A Program started right after others ended waits up to 5 seconds for their workers to exit, instead of failing at once.
- A message sent in `/tasks` while an Agent stops stays queued and goes with its next turn, as in Pi, instead of ending with the stopped turn.

### Removed

- `pd main` no longer reads the `main.json` that 0.4.0 wrote and starts a new main Agent instead; to keep the old one, change the file to `{"main": "<Session file>"}`.

## [0.4.1] - 2026-11-04

### Added

- `pd main --name <name>` opens a main Agent per name, so that each channel can have its own.

### Changed

- Inputs answered by the same turn share one notification.

## [0.4.0] - 2026-11-04

### Added

- `spawn` takes `disown`: a root Agent starts another root Agent it does not own, which replies with `send`.
- A Program's notification carries the result's images.

### Changed

- **Breaking:** `wait` only waits, for Agents and background Programs, and returns how it ended; results always arrive as notifications, also while waiting. The `history` parameter is removed.
- The notifications of what a `wait` waits for arrive together when it ends.
- `pd main` opens the main Agent from any directory, and starts one in `~` if there is none; `/new` in it starts a new main Agent.

## [0.3.0] - 2026-11-02

### Added

- `pd main` opens the main Agent: one Session you talk to, which hands your work to other Agents and reports back.

### Changed

- The task panel and `/tasks` show the same tree, including the Agents that Programs start.
- `/tasks` lists only the running background Programs of other Agents.
- The task panel shows a task's cost only once there is any.

### Fixed

- Under Pi 1.4.0, a Program starts at once even while background Programs wait on Agents.
- The task viewer scrolls, and renders only what changed.
- Terminal input that arrives just before detaching no longer leaks into the shell.
- The workbench preview labels custom messages by their type.

## [0.2.0] - 2026-10-15

### Added

- `pd -p`, `--mode json`, and `--mode rpc` run on the Session in its host, so several clients and an attached terminal can use one Session at once.
- `/program <file>` runs a saved Program; `/tasks` opens background Programs.
- `agent().send()` in Programs accepts a `timeout`.
- Program results list Agents' `send()` calls and name the calls still running when the script returned.
- `list` shows each Agent's latest request.
- The panel shows how long each task has run and what its replies cost.
- Agent messages queued in a Session are shown and kept; queued writes are labeled apart from steers.

### Changed

- `pd` and `pd --session-id` attach to a Session already running in a host and send it their messages.
- After a turn is stopped, messages from other Agents are held as writes until the next input from its user or owner.
- `wait` ends early when a steer arrives.
- Stopping a Program no longer notifies its caller.
- A detached Session exits after 10 idle minutes instead of 5.
- The workbench has clearer session groups, better preview scrolling and layout, and a configurable detach key.

### Fixed

- Compatibility with Pi 1.2, including `program` reaching MCP tools without the `codemode` extension.
- Hosted `pd -p` prints `/program` results and exits with 1 on a failed `/program` or a truncated reply, as Pi does.
- Shutdown no longer waits indefinitely for Agents still loading, and Program cleanup waits for tool calls left running.
- Messages to a Program's Agents go through their owner.
- Timers, connections, and signal handlers no longer leak in the viewer and the host extension.
- `pd` waits for a starting or exiting Pi instead of reporting the Session in use.

## [0.1.1] - 2026-10-10

### Fixed

- Removing an idle Session that runs in a detached host quits it instead of refusing.
- Previewing a Session in the workbench marks its latest turn as seen.

## [0.1.0] - 2026-10-10

Initial release.

### Added

- `agent` tool: start, message, wait for, list, and abort Agents that run in parallel in the background and notify their owner when done.
- `program` tool: run JavaScript that composes tool calls and Agents, in the foreground or in the background.
- Messaging between Agents, including root Agents in other Pi instances.
- Task panel showing each Agent's and Program's live work; `/tasks` hides or shows it.
- `/agents` opens an Agent in the tree to watch and talk to it.
- `pd`: start Pi in a host that keeps the Session running after the terminal detaches (`Ctrl+Z`, `/detach`); `pd attach <session>` attaches again.
- `pd agents` opens the workbench, which lists all Sessions with previews.
