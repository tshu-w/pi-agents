# Pi Agents Specification

Pi Agents lets Agents in Pi discover, message, and wait for each other.
Programs built on these operations are specified in PROGRAM.md.

Terms follow Pi's
[Pico5 specification](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/pico-v5.md).

## 1. Semantic model

An **Agent** is an addressable conversation with a stable identity. The Agent
that spawns another Agent is its **owner**. A root Agent has no owner and is
usually opened by a user. Ownership forms trees.

An Agent is shown by its name and **short ID**: the shortest prefix of its
ID, at least 8 characters, that no other Agent visible to the reader has.
An address is an ID, a name, or a unique ID prefix, tried in that order.

A **message** carries text from one Agent to another. An **input** asks the
recipient to act. A **write** only adds to the recipient's conversation.

A **turn** is one continuous run of an Agent's model and tools. Its final
assistant message is the **answer** to the inputs it handled.

An owner can **wait** for answers to the inputs it sends to its owned Agents.

**Visibility** determines which Agents an Agent can discover and message.

## 2. Operations

### 2.1 spawn

`spawn` creates a named, owned Agent and sends it a first input. It
accepts an optional working directory, model, thinking level, and forked
context, and returns the Agent's ID. Names are unique among siblings.

### 2.2 send

`send` sends a message to a visible Agent by address. An ambiguous or
unknown address is rejected.

An input to a busy Agent is either answered by the current turn
(`steer`) or by a new turn after it (`followUp`, the default).

A write is added at the recipient's next tool boundary, or at once if it is
idle. A write can go to several Agents at once.

### 2.3 wait

`wait` returns results of inputs sent to owned Agents. It can target
specific Agents and take a timeout.

### 2.4 list

`list` returns visible Agents with their ID, name, working directory, and
state.

### 2.5 abort

`abort` stops an owned Agent's current turn and withdraws its queued
inputs. The Agent stays available.

## 3. Lifecycle

An Agent is `busy` while a turn is in progress, `idle` when loaded without
one, and `offline` when not loaded.

`send` returns once the recipient's runtime accepts the message, waking it
if needed. Acceptance does not mean the recipient has handled it; a message
not yet handled is lost if the recipient exits.

An input to an offline Agent wakes it. A write never wakes an Agent.

Owned Agents run independently of their owner's turns. When their owner
goes offline, they go offline too and their unfinished inputs end as
`aborted`. They return as `idle` when their owner is loaded again.

## 4. Visibility and limits

An Agent sees every Agent in its own tree. A root Agent also sees other root
Agents.

Limits apply to owned Agents in each tree.

An owned Agent needs a slot to run a turn. `maxConcurrent` (default 3) is
the number of slots. An input that would start a turn waits for a free
slot, and `spawn` or `send` reports that it is queued. A `steer` input to
a busy Agent joins its current turn and needs no new slot. An Agent gives
up its slot while it waits in `wait`, and takes one again before
continuing, ahead of inputs that have not started.

An input is outstanding from acceptance until its turn ends or it is
withdrawn. `maxOutstanding` (default 8) limits outstanding inputs; an input
beyond it is rejected. `maxConcurrent` cannot exceed `maxOutstanding`.

## 5. Results and notifications

An input sent to an owned Agent ends as `completed` when its turn answers
it, `failed` when its turn fails, or `aborted` when it is aborted or
withdrawn. Its result is the answer or the error. Only inputs from the
owner have results; the recipient replies to other senders with `send`.

`wait` returns unread results in order and marks them read. On timeout, it
returns the results so far and names the Agents still pending. It can also
return read results again.

When an input ends and its owner is not waiting for that Agent, the owner
receives a notification. The notification is an input delivered as `steer`,
and it names the Agent and how the input ended. It does not include the
result; the owner reads the result with `wait`.

A recipient sees each message with its sender's name and ID.

## 6. Model-facing tool

### `agent`

description:

Create, message, and coordinate Agents. `spawn` creates an owned Agent and
sends its first input; `send` sends an input or a write to a visible Agent;
`wait` waits for owned Agents and returns unread results; `list` finds
visible Agents; `abort` stops an owned Agent's current turn and queued
inputs while keeping it available. When an owned Agent finishes an input
while its owner is not waiting for it, the owner receives a notification
naming the Agent and outcome; `wait` returns the result. Owned Agents under
the same root share `${maxConcurrent}` execution slots and a limit of
`${maxOutstanding}` inputs that have not ended. Inputs that start a new
turn queue when all slots are busy; new inputs are rejected at the input
limit.

promptSnippet:

Create, message, and coordinate Agents

promptGuidelines:

- Use `agent(action='spawn', name=..., message=...)` for concrete, bounded
  work with a clear expected result. Keep the first message self-contained;
  use `context='fork'` only when the Agent needs the caller's conversation.
- For independent work, start the Agents before waiting and partition tasks
  into non-overlapping responsibilities.
- Use `agent(action='wait', ...)` when the next step depends on Agent
  results. Prefer one longer wait over repeated short polling.

parameters:

- `action`: Operation and applicable parameters: `spawn(name, message, cwd?, context?, model?, thinkingLevel?)`, `send(target, message, deliverAs?)`, `wait(target?, history?, timeout?)`, `list(query?, state?, limit?, offset?)`, or `abort(target)`.
- `name`: Name of the new Agent for `spawn`; unique among the caller's Agents.
- `message`: Non-empty text for `spawn` or `send`.
- `cwd`: Working directory for `spawn` (default: the caller's current working directory).
- `context`: Context for `spawn` (default: fresh). fresh starts without the caller's conversation; fork snapshots it.
- `model`: Model for `spawn` as provider/modelId (default: the caller's model).
- `thinkingLevel`: Thinking level for `spawn`: off, minimal, low, medium, high, or xhigh (default: the caller's level).
- `target`: Agent ID, name, or unique ID prefix for `send`, `wait`, or `abort`. `wait` and `send` with `deliverAs='write'` also accept an array. When omitted for `wait`, selects all owned Agents with pending or unread results.
- `deliverAs`: Delivery for `send` (default: followUp). followUp waits until the recipient's current turn ends; steer delivers after its current tool calls, before the next model call; write delivers like steer but never starts a turn and has no result.
- `history`: Number of most recent read results to return again per selected Agent for `wait` (default: 0).
- `timeout`: Maximum seconds for `wait` (default: 30, min: 10, max: 3600). Timeout does not abort Agents.
- `query`: Search query for `list`, matching ID, name, cwd, summaries, and user messages. Case-insensitive; spaces mean AND; `|` means OR.
- `state`: State for `list`: busy, idle, or offline.
- `limit`: Maximum Agents returned by `list` (default: 20, max: 200).
- `offset`: Number of Agents to skip for `list` (default: 0).

results:

In these formats, `<id>` is the Agent's short ID. Details use full IDs;
arrays remain present when empty.

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

`wait` returns one block per result, followed by pending Agents on timeout:

```text
<agent-result name="<name>" id="<id>" status="<outcome>">
<answer or error>
</agent-result>

Still pending: <name> (<id>), ...
```

A result returned again through `history` adds `history="true"`. A single
unread completed result, with nothing pending, is returned as the answer
alone. When there are no results or pending inputs:

```text
No results.
```

Details:

```text
{ results: [{ id, name, state, history, result? }], pending: [id] }
```

`state` is the input outcome (§5); `history` marks a previously read result.

`list` returns one entry per Agent. With a query, entries are ordered by
their most recent match. When a summary or user message matches, the entry
shows the latest matching excerpt and its time:

```text
<name> (<id>)  <state>  <cwd>
  YYYY-MM-DD HH:MM  …<matching excerpt>…
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

`agents` is the current page; `total` counts all matches. `state` is the
Agent's current state (§3).

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

Invalid calls fail with an error. Errors that need a follow-up say what to
do:

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

truncation:

Text beyond Pi's output limits is truncated with Pi's native notice, and
the full text is saved to a file whose path appears in the notice. `wait`
adds results in order; the result that crosses the limit is truncated but
keeps its closing tag, and later results are omitted. A truncated result
counts as read. Omitted results stay unread, and the text ends with:

```text
[Results omitted: <name> (<id>), ... Use wait with fewer targets.]
```

Details retain metadata, `truncation`, and `fullOutputPath`.
`wait.results[].result` contains only retained text and is absent for
omitted results.

messages:

A notification to the owner:

```text
Agent <name> (<id>) <outcome>.
```

A recipient sees each message in an `agent-message` element naming the
sender. An input from a sender other than the owner also carries a note
asking for a reply:

```text
<agent-message from="<name>" id="<id>">
<body>
</agent-message>
```

```text
<agent-message from="<name>" id="<id>" note="Reply with send">
<body>
</agent-message>
```

## 7. Human interface

### Task panel

A panel above the editor shows the current Agent's live work:

    Tasks (<N> live, /tasks to hide)
      Agent <name> (<id>)  <state>  <N> queued
        Agent <name> (<id>)  <state>
      Program <id>  running
      +<N> more

The live work is the owned Agents that are busy or have queued inputs and
the running background Programs. The rows list those Agents as a tree in
the order they were spawned, each under its owner, with the owners needed to
keep the tree; then running background Programs, newest first. Rows that do
not fit are counted in the last row.

The panel updates as states change and is shown while it has a row.
`/tasks` hides or shows it.

### Agent viewer

`/agents` lists the current Agent's owned Agents, busy ones first and newest
first within each group, with their state and first input, and opens the
selected one in a viewer. An Agent not owned by the current Agent is named
with its owners up to it, as `<name> ‹ <owner> ‹ …`. The viewer shows the
Agent's conversation and updates while it works; the current Session keeps
running behind it.

Text entered in the viewer is the user's input to that Agent and is sent as
in Pi's editor.

`app.interrupt` stops the Agent's current turn, as `abort` does.
`app.clear` clears the input, and closes the viewer when the input is empty.

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

- `maxConcurrent`, `maxOutstanding`: limits from §4. Both are positive
  integers with `maxConcurrent <= maxOutstanding`.
- `extensions`: extension paths loaded by owned Agents, relative to Pi's
  agent directory. An owned Agent can use only tools its owner can use.

Invalid settings produce a startup warning, and the defaults are used.

## 9. Runtime

Each Agent is a persistent Pi Session. A root Agent is an ordinary Session.
An owned Agent is a child Session that records its owner and root, and runs
in its owner's process.

A delivered message enters the recipient's current branch. An offline root
Agent is loaded in the background with its saved working directory and
model and the current configuration, and exits after handling its inputs.
One runtime uses a Session at a time.
