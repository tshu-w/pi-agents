# Pi Agents Specification

Pi Agents lets Agents in Pi discover, message, and wait for each other. Programs built on these operations are specified in PROGRAM.md.

Terms follow Pi's [Pi Durable specification](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md).

## 1. Semantic model

An **Agent** is an addressable conversation with a stable identity. The Agent that spawns another Agent is its **owner**, unless it disowns it (§2.1). A root Agent has no owner. Ownership forms trees.

An Agent is shown by its name and **short ID**: the shortest prefix of its ID, at least 8 characters, that no other Agent visible to the reader has. An address is an ID, a name, or a unique ID prefix, tried in that order.

A **message** carries text from one Agent to another. An **input** asks the recipient to act. A **write** only adds to the recipient's conversation.

A **turn** is one continuous run of an Agent's model and tools. Its final assistant message is the **answer** to the inputs it handled.

An owner can **wait** for answers to the inputs it sends to its owned Agents.

**Visibility** determines which Agents an Agent can discover and message.

## 2. Operations

### 2.1 spawn

`spawn` creates a named, owned Agent and sends it a first input. It accepts an optional working directory, model, thinking level, and forked context, and returns the Agent's ID. Names are unique among siblings.

With `disown`, a root Agent's `spawn` starts a root Agent instead, detached in a host (HOSTS §4).

### 2.2 send

`send` sends a message to a visible Agent by address. An ambiguous or unknown address is rejected.

An input to an Agent with a turn in progress is either answered by the current turn (`steer`) or by a new turn after it (`followUp`, the default).

A write is added at the recipient's next tool boundary, or at once if it is idle. A write can go to several Agents at once.

When the user of a root Agent clears its queued messages, messages from other Agents stay queued. After an Agent's turn is stopped, messages from other Agents, notifications included, become writes until its next input from its user or owner. A message from its user while the turn is stopping waits for that input.

### 2.3 wait

`wait` waits until owned Agents have finished the inputs sent to them. It can target specific Agents and take a timeout.

### 2.4 list

`list` returns visible Agents with their ID, name, state, model, working directory, and a preview: an idle Agent's latest answer, otherwise its latest request, the last user message or input it received.

### 2.5 abort

`abort` stops an owned Agent's current turn and withdraws its queued inputs. The Agent stays available.

## 3. Lifecycle

An Agent is `running` while a turn is in progress, `waiting` while its turn waits in `wait` (§4), `queued` while its next turn waits for a slot (§4), and `idle` otherwise. An Agent goes offline when its runtime unloads it; it stays `idle`.

`send` returns once the recipient's runtime accepts the message, waking it if needed. Acceptance does not mean the recipient has handled it (§9).

An input to an offline Agent wakes it; a write to one is rejected.

Owned Agents run independently of their owner's turns. When an owner goes offline, its owned Agents go offline too, from the bottom of the tree up, and their unfinished inputs end as `aborted`, as do inputs unfinished when a process exits. They return as `idle` when their owner is loaded again.

On abort or when going offline, work that has not stopped within a timeout is abandoned: it no longer counts as live work and may keep running until the process exits; the timeout is reported.

A root Agent is `running` while it has a turn in progress or pending messages, or while its tree has live work (§7 Task panel); otherwise it is `idle`.

## 4. Visibility and limits

An Agent sees every Agent in its own tree. A root Agent also sees other root Agents.

Limits apply to owned Agents in each tree.

An owned Agent needs a slot to run a turn. `maxConcurrent` (default 3) is the number of slots. An input that would start a turn waits for a free slot, and `spawn` or `send` reports that it is queued. A `steer` input to an Agent with a turn in progress joins it and needs no new slot. An Agent gives up its slot while it waits in `wait`, and takes one again before continuing, ahead of inputs that have not started.

An input is outstanding from acceptance until its turn ends or it is withdrawn. `maxOutstanding` (default 8) limits outstanding inputs; an input beyond it is rejected. Notifications (§5) do not count.

## 5. Results and notifications

An input sent to an owned Agent ends as `completed` when its turn answers it, `failed` when its turn fails, or `aborted` when it is aborted or withdrawn. Its result is the answer or the error. Only inputs from the owner have results; the recipient replies to other senders with `send`.

When an input ends, its owner receives a notification carrying the result, unless the owner aborted it or is going offline. Inputs that a turn ends with the same outcome and result share one notification. The notification is an input delivered as `steer` (a write after the owner's turn is stopped, §2.2).

Inputs that ended because their owner went offline are reported in one notification when the owner is loaded again, delivered as a write.

`wait` ends when the Agents it waits for have no pending inputs, when its timeout expires, or when a steer input arrives; a write does not end it. Their notifications are held until it ends, then delivered as one.

A recipient sees each message with its sender's name and ID.

## 6. Model-facing tool

### `agent`

description:

Create, message, and coordinate Agents. `spawn` creates an Agent and sends its first input; `send` sends an input or a write to a visible Agent; `wait` waits for owned Agents to finish; `list` finds visible Agents; `abort` stops an owned Agent's current turn and queued inputs while keeping it available. An Agent is owned by its spawner unless spawned with `disown`. When an owned Agent finishes an input, its owner receives a notification with the result; the Agent goes offline when its owner does. A disowned Agent is an independent root Agent that replies to its spawner with `send`. Owned Agents under the same root share `${maxConcurrent}` execution slots and a limit of `${maxOutstanding}` inputs that have not ended. Inputs that start a new turn queue when all slots are busy; new inputs are rejected at the input limit.

promptSnippet:

Create, message, and coordinate Agents

promptGuidelines:

- Use `agent(action='spawn', name=..., message=...)` for concrete, bounded work with a clear expected result. Keep the first message self-contained; use `context='fork'` only when the Agent needs the caller's conversation.
- For independent work, start the Agents before waiting and partition tasks into non-overlapping responsibilities.
- Use `agent(action='wait', ...)` when your next step or answer depends on Agent results. Prefer one longer wait over repeated short polling.
- Keep Agents owned for bounded work; use `disown` for lasting work that should continue after you go offline.

parameters:

- `action`: Operation and applicable parameters: `spawn(name, message, cwd?, context?, model?, thinkingLevel?, disown?)`, `send(target, message, deliverAs?)`, `wait(target?, timeout?)`, `list(query?, state?, limit?, offset?)`, or `abort(target)`.
- `name`: Name of the new Agent for `spawn`; unique among the caller's Agents.
- `message`: Non-empty text for `spawn` or `send`.
- `cwd`: Working directory for `spawn` (default: the caller's current working directory).
- `context`: Context for `spawn` (default: fresh). fresh starts without the caller's conversation; fork snapshots it.
- `model`: Model for `spawn` as provider/modelId (default: the caller's model).
- `thinkingLevel`: Thinking level for `spawn`: off, minimal, low, medium, high, xhigh, or max (default: the caller's level).
- `disown`: For `spawn`, start a root Agent the caller does not own (default: false).
- `target`: Agent ID, name, or unique ID prefix for `send`, `wait`, or `abort`. `wait` and `send` with `deliverAs='write'` also accept an array. When omitted for `wait`, selects all owned Agents with pending inputs.
- `deliverAs`: Delivery for `send` (default: followUp). followUp waits until the recipient's current turn ends; steer delivers after its current tool calls, before the next model call; write delivers like steer but does not wake an idle recipient and has no result.
- `timeout`: Maximum seconds for `wait` (default: 30, min: 10, max: 3600). Timeout does not abort Agents.
- `query`: Search query for `list`, matching ID, name, cwd, summaries, and user messages. Case-insensitive; spaces mean AND; `|` means OR.
- `state`: State for `list`: running, waiting, queued, or idle.
- `limit`: Maximum Agents returned by `list` (default: 20, max: 200).
- `offset`: Number of Agents to skip for `list` (default: 0).

results:

In these formats, `<id>` is the Agent's short ID. Details use full IDs; arrays remain present when empty.

`spawn`:

```text
Agent <name> (<id>) started.
Agent <name> (<id>) queued: all <N> slots are busy.
```

Details:

```text
{ id, name, queued }
```

`send` returns acceptance, not completion:

```text
Input accepted by <name> (<id>).
Input accepted by <name> (<id>), queued: all <N> slots are busy.
Write accepted by <name> (<id>), ...
```

Details:

```text
followUp / steer: { id, queued }
write:           { ids }
```

`wait` returns how it ended; results arrive as notifications:

```text
Wait completed.
Wait timed out. Still pending: <name> (<id>), ...
Wait interrupted by a new message. Still pending: <name> (<id>), ...
```

When none of the selected Agents has pending inputs:

```text
Nothing to wait for.
```

Details:

```text
{ pending: [{ id, name }], timedOut?, interrupted? }
```

`list` returns one entry per Agent, followed by its preview, prefixed `answer:` or `input:`, if any, and its time. With a query, entries are ordered by their most recent match, and a matching summary or user message shows its latest excerpt instead:

```text
<name> (<id>)  <state>  <provider>/<modelId>[:<thinkingLevel>]  <cwd>
  YYYY-MM-DD HH:MM  <preview or matching excerpt>
```

When more entries remain:

```text
[N more results. Use offset=X to continue.]
```

When no Agents match:

```text
No matching Agents.
```

Details:

```text
{ total, agents: [{ id, name?, ownerId?, state }] }
```

`agents` is the current page; `total` counts all matches. `state` is the Agent's current state (§3).

`abort`:

```text
Agent <name> (<id>) aborted.
Agent <name> (<id>) has no turn or queued inputs.
```

Details:

```text
{ id, aborted }
```

For unnamed root Agents, show the ID without a name or parentheses.

errors:

Invalid calls fail with an error. Errors that need a follow-up say what to do:

```text
No visible Agent matches "<target>". Use list to find Agents.
```

```text
"<target>" matches several Agents:
<name> (<id>)  <state>  <cwd>
...

Retry with a longer ID prefix.
```

```text
Name "<name>" is already used by <id>.
```

```text
Input rejected: <N> inputs have not ended. Wait for results or abort an Agent.
```

```text
<name> (<id>) is not owned by the caller.
```

When an aborted turn does not stop within the timeout (§3), `abort` fails with the following; only restarting Pi stops it.

```text
Agent <name> (<id>) did not stop within the timeout and may still be running.
```

truncation:

Text beyond Pi's output limits is truncated with Pi's native notice, and the full text is saved to a file whose path appears in the notice. A notification's result is truncated the same way and keeps its closing tag. Details retain metadata, `truncation`, and `fullOutputPath`.

messages:

A notification to the owner:

```text
<agent-result name="<name>" id="<id>" status="<outcome>">
<answer or error>
</agent-result>
```

A notification that a `wait` held holds one such block per result, separated by blank lines.

A recipient sees each message in an `agent-message` element naming the sender. An input from a sender other than the owner also carries a note asking for a reply:

```text
<agent-message name="<name>" id="<id>">
<body>
</agent-message>
```

```text
<agent-message name="<name>" id="<id>" note="Reply with send">
<body>
</agent-message>
```

## 7. Human interface

### Task panel

A panel above the editor shows the current Agent's live work:

```text
Tasks (<N> live, /tasks to view)
  Agent <name> (<id>)  <state>  <time>  <cost>  <N> pending
    Agent <name> (<id>)  <state>  <time>  <cost>
  Program <id>  running  <time>  <cost>
    Agent <name> (<id>)  <state>  <time>  <cost>
  +<N> more
```

The live work is the Agents under the current Agent that are not `idle`, including Programs' Agents, and the running background Programs. The rows list them as a tree in the order they started, each under its owner and each Program under its caller, with the owners needed to keep the tree. Rows that do not fit are counted in the last row. The time is how long the Agent's current turn or the Program has run, and the cost what the replies in that turn have cost, or for a Program, those of all the Agents under it, once there is any. When a reply has no price, the cost is the input and output tokens instead, like `7.3M tok`.

The panel updates as states change, and its times each second. It is shown while it has a row. `/tasks panel` hides or shows it.

### Queued messages

Messages from other Agents that wait in the Session's queue, as during a turn, are listed above the editor, below the user's queued messages, until the Session takes them in:

```text
Steering: [<sender>] <body>
Write: [<sender>] <body>
Follow-up: [<sender>] <body>
```

### Messages and results

A message from another Agent shows its sender after the label:

```text
[pi-agents] from <name> (<id>)

<body>
```

The user's input from the task viewer shows as a user message. Notifications show each result with the first lines of its body; a Program's body starts at its output:

```text
<name> (<id>)  <state>
  <body>
Program <id>  <state>  <time>
  <body>
```

Expanding (`app.tools.expand`) shows them as Pi shows them by default.

### Task viewer

`/tasks` lists the Agents under the current Agent, including Programs' Agents, its background Programs, and the running ones of those Agents, live ones first and newest first, with their state and latest activity, and opens the selected one in a viewer. A foreground Program is watched in its caller's conversation. An Agent or Program not owned by the current Agent is named with its owners, as `<name> ‹ <owner> ‹ …`, where a Program is `Program <id>`. The viewer follows an Agent's conversation as Pi's chat shows it, or a Program as it shows in the foreground, while the current Session keeps running.

Text entered in an Agent's viewer is the user's input to it, sent as in Pi's editor; a Program takes no input.

Keys act as in Pi's editor, on the viewed Agent or Program; on an empty input, `Ctrl+C` (`app.clear`) closes the viewer. The viewer scrolls as fullscreen mode does.

### Workbench

`pd agents` opens the workbench, which lists every root Session on this machine and lets the user open and message them. Sessions started with `pd` keep running after their terminal closes. See [HOSTS.md](HOSTS.md).

## 8. Configuration

Settings live under `"pi-agents"` in the global `settings.json`:

```json
{
  "pi-agents": {
    "maxConcurrent": 3,
    "maxOutstanding": 8,
    "extensions": []
  }
}
```

- `maxConcurrent`, `maxOutstanding`: limits from §4. Both are positive integers with `maxConcurrent <= maxOutstanding`.
- `extensions`: extension paths loaded by owned Agents, relative to Pi's agent directory. An owned Agent can use only tools its owner can use.

Invalid settings produce a startup warning, and the defaults are used.

## 9. Runtime

Each Agent is a persistent Pi Session. A root Agent is an ordinary Session. An owned Agent is a child Session that records its owner and root, and runs in its owner's process.

A delivered message enters the recipient's current branch. An offline root Agent is started in a host, detached, with its saved working directory and model and the current configuration (HOSTS §4). If a root process cannot finish cleanup within a grace period on exit, it is forcibly terminated. Before shutting down an idle Session, an extension can emit `session:busy` on `pi.events` with `{ busy: false }`; any extension with work in progress sets `busy` to `true`, as pi-agents does while the tree has live work. One runtime uses a Session at a time. If a Session is occupied at startup, Pi reports it and exits.

An accepted message is kept until it enters the recipient's Session. A message that may not have arrived is sent again; it enters the Session once.
