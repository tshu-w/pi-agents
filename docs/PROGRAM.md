# Pi Agents Program Specification

A Program is JavaScript that calls tools and Agents. Agents are defined in
SPEC.md.

The `program` tool replaces Pi's `codemode` tool and keeps its script API,
tool list, result format, and truncation. This document describes what
Programs add.

## 1. Semantic model

An Agent runs a **Program** with the `program` tool. That Agent is the
Program's **caller**. The Program can call the caller's tools and create
Agents.

A Program runs in the **foreground** or the **background**. In the
foreground, the tool call returns the Program's result. In the background,
the tool call returns the Program's ID, and the caller gets the result with
`wait`.

A Program is shown by its short ID: the shortest prefix of its ID, at least
8 characters, that none of the caller's other Programs' IDs starts with. A
target is an ID or a unique ID prefix.

Agents created with `agent()` belong to the Program: it gets their results
from `send()`, without `wait` or notifications, and only it can abort
them. Each of these Agents and the Agents under it see only one another,
and no other Agent sees them. When the Program ends, their unfinished
inputs end as `aborted`, and the Agents go offline for good.

A Program is `running` until it ends in one of three ways:

- `completed`: it returned.
- `failed`: it threw an error.
- `stopped`: it was stopped or timed out.

## 2. Operations

- `run` runs a Program in the foreground or background, with an optional
  timeout.
- `wait` waits for background Programs and returns their results.
- `list` lists the caller's background Programs.
- `stop` stops a running Program.

When a background Program ends and its caller is not waiting for it, the
caller gets a notification, as in SPEC §5.

## 3. Program API

`tools` holds the caller's tools, except `program`; which tools the caller
can use is checked at each call. If a Program fails or is stopped, the
error or stop reason follows its output. Its `store()` writes are kept
only if it completes.

A Program also creates Agents with `agent()`:

```ts
agent(options?: {
  name?: string;
  cwd?: string;
  context?: "fresh" | "fork";
  model?: string;
  thinkingLevel?: string;
}): AgentHandle

interface AgentHandle {
  readonly id: string;
  readonly name: string;
  send(message: string, options?: {
    deliverAs?: "followUp" | "steer" | "write";
    schema?: JsonSchema;
  }): Promise<unknown>;
  abort(): Promise<void>;
}
```

`agent()` creates an idle Agent. Options work like `agent` `spawn`; an
omitted name is generated, unique within the Program. `send()` sends a
message and returns its result. `abort()` works like `agent` `abort`.
It gets its tools as if the caller had spawned it.

A result is the Agent's answer. If the input fails or is aborted, the
result throws an Error. A write returns `undefined` once accepted.

With `schema`, the Agent must call `submit_result` with a value that
matches the schema, and the result is that value. If it does not, the
input fails. `send()` throws if `schema` is used without `followUp`.

## 4. Lifecycle

When a Program ends, it cancels its unfinished tool calls and aborts its
Agents' unfinished inputs. It returns its result after cleanup, or after a
cleanup timeout if some work does not stop. Stopping a Program does not
undo completed tool calls.

When the caller goes offline, its running Programs stop. Their results
remain available when the caller is loaded again.

## 5. Limits

A Program's Agents and the Agents under them count toward the caller's
tree: they share its slots and `maxOutstanding` limit, as in SPEC §4, and
the task panel's usage includes them. At `maxOutstanding`, `send()` throws.

An owned caller gives up its slot while a foreground Program runs or while
it waits for background Programs, and takes one again before continuing.

## 6. Model-facing tool

### `program`

description:

Run JavaScript that composes tool calls and Agents; only its output and
return value reach the caller. `run` runs a Program in the foreground, or
in the background with `background`; `wait` waits for background Programs
and returns their results; `list` lists background Programs; `stop` stops
a running Program. When a background Program ends while its caller is not
waiting for it, the caller receives a notification; `wait` returns the
result.

Program code is the body of an async function. It calls the caller's tools
through `tools.*`, which excludes `program`, and creates Agents through
`agent()`. These Agents belong to the Program, are isolated from other
Agents, and go offline when it ends.

`program` replaces the `codemode` tool; wherever `codemode` is mentioned,
use `program`.

[the script API of `codemode`, without its Model API]

Agent API:
```ts
type JsonSchema = boolean | Record<string, unknown>;
interface AgentOptions {
  /** Default: generated, unique within the Program. */
  name?: string;
  /** Default: the caller's cwd. */
  cwd?: string;
  /** `fresh` starts without the caller's conversation; `fork` snapshots it. Default: `fresh`. */
  context?: "fresh" | "fork";
  /** provider/modelId. Default: the caller's model. */
  model?: string;
  /** Default: the caller's level. */
  thinkingLevel?: string;
}
interface SendOptions {
  /** Default: `followUp`. */
  deliverAs?: "followUp" | "steer" | "write";
  /** `followUp` only. The Agent must submit a value matching it. */
  schema?: JsonSchema;
}
interface AgentHandle {
  readonly id: string;
  readonly name: string;
  /** Resolves with the answer, or with the submitted value when `schema` is set; a write resolves with undefined once accepted. Throws if the input fails or is aborted. */
  send(message: string, options?: SendOptions): Promise<unknown>;
  /** Aborts the Agent's current turn and queued inputs; the Agent stays usable. */
  abort(): Promise<void>;
}

/** Creates an idle Agent that belongs to the Program. */
declare function agent(options?: AgentOptions): AgentHandle;
```

[the Model API of `codemode`]

[the tool list, as set by `codemode.mode`]

promptSnippet:

Run JavaScript that composes tool calls and Agents

promptGuidelines:

- Use `program(action='run', code=...)` to call tools or Agents several
  times without a model turn between the calls, for example to read many
  files, filter large tool output, fan out Agents, or loop until a
  condition holds.
- Use `Promise.allSettled` for independent calls. Return only what the
  caller needs; use `text()` for progress worth reading.
- Use `background=true` for long Programs, and `program(action='wait', ...)`
  when the next step depends on their results.

parameters:

- `action`: Operation and applicable parameters: `run(code, background?, timeout?)`, `wait(target?, timeout?)`, `list(limit?, offset?)`, or `stop(target)`.
- `code`: JavaScript async-function body for `run`.
- `background`: Whether `run` returns the Program ID at once (default: false).
- `timeout`: Maximum seconds. For `run` (default: none), expiry stops the Program. For `wait` (default: 30, min: 10, max: 3600), expiry does not stop Programs.
- `target`: Program ID or unique ID prefix for `wait` or `stop`. `wait` also accepts an array. When omitted for `wait`, selects running Programs and ended Programs whose result has not been returned.
- `limit`: Maximum Programs returned by `list` (default: 20, max: 200).
- `offset`: Number of Programs to skip for `list` (default: 0).

results:

In these formats, `<id>` is the Program's short ID.

`run` in the foreground returns the Program result, as an error if the
Program failed or was stopped.

`run` in the background:

```text
Program <id> started.
```

`wait` returns one block per result, followed by running Programs on
timeout:

```text
<program-result id="<id>" status="<outcome>">
<result>
</program-result>

Still running: <id>, ...
```

A single completed result, with nothing running, is returned alone. When
there are no results or running Programs:

```text
No results.
```

`list` returns one entry per background Program, newest first:

```text
<id>  <state>  YYYY-MM-DD HH:MM
```

When more entries remain:

```text
[N more results. Use offset=X to continue.]
```

When there are no background Programs:

```text
No Programs.
```

`stop`:

```text
Program <id> stopped.
Program <id> has already ended.
```

errors:

Invalid calls fail with an error. Errors that need a follow-up say what to
do:

```text
No Program matches "<target>". Use list to find Programs.
```

```text
"<target>" matches several Programs: <id>, ... Retry with a longer ID prefix.
```

truncation:

`wait` text beyond Pi's output limits is truncated as in SPEC §6. `wait`
adds results in order; the result that crosses the limit is truncated but keeps
its closing tag, and later results are omitted. A truncated result counts
as returned. Omitted results stay unreturned, and the text ends with:

```text
[Results omitted: <id>, ... Use wait with fewer targets.]
```

messages:

A notification to the caller:

```text
Program <id> <outcome>.
```

## 7. Human interface

The task panel lists the current Agent's background Programs after its
Agents, newest first, while they run or have unreturned results:

    Programs: <running> running · <unreturned> unreturned results
      <id>  <state>  YYYY-MM-DD HH:MM

Only nonzero counts are shown; the section is omitted when both are zero.

## 8. Configuration

`program` is inactive by default, like `codemode`; enable it with `"defaultTools": ["+program"]` or `--tools`.
MCP treats `program` as `codemode`: it activates `program` when its servers need a script tool and neither is active, unless `autoEnableCodemode` is false, and a Program waits for the MCP servers its code names.
When both `program` and `codemode` are active, Pi warns once per Session, since they do a similar job.
`codemode.mode` decides how the tool list is presented, as for `codemode`.
`--program-only` activates `program` and uses `only` for the process, including its owned Agents.
