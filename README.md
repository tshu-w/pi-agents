# pi-agents

A [Pi](https://github.com/earendil-works/pi) extension that lets Agents run
in the background, be composed in JavaScript Programs, and work together by
messaging each other.

```sh
pi install git:github.com/tshu-w/pi-agents
```

Tested with Pi 0.99.2.

## Async Agents

The `agent` tool spawns owned Agents that work in the background while their
owner keeps going. When an Agent finishes an input, its owner gets a
notification; `wait` returns the result. Each Agent is a persistent Pi
Session, so it can be messaged again later. `/tasks` shows what is running.
On [BrowseComp](https://arxiv.org/abs/2504.12516), async Agents improved 7 of
the 8 models we tested by up to 9 points (13%), among them GPT 5.6 Luna,
Claude Sonnet 5, Gemini 3.8 Flash, and GLM 5.3.

## Program

The `program` tool runs JavaScript that calls tools and Agents. It builds on
Pi's `codemode` and keeps its script API, tool list, and result format, and
adds Agents to it:

```js
const files = ["a.ts", "b.ts"];
const reviews = await Promise.all(files.map((file) => agent().send(`Review ${file}`)));
return reviews.join("\n\n");
```

A Program can create Agents with `agent()`, and those Agents can run
Programs of their own, so a model can split a large task, delegate the parts
recursively, and keep the intermediate results out of its own context, as in
[Recursive Language Models](https://alexzhang13.github.io/blog/2025/rlm/).
With a `schema`, `send()` returns a structured value instead of text.

`program` is inactive by default. Enable it in `settings.json`:

```json
{ "defaultTools": ["+program"] }
```

## Collaboration

Agents work together by messaging each other, addressed by ID or name.
`send` delivers an input, which asks the recipient to act, or a write, which
only adds to its conversation.

Root Agents, the Sessions you open, can find and message each other with
`list` and `send`, including Sessions in other Pi processes. An input to an
offline Session loads it in the background; it answers and exits.

## Configuration

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

- `maxConcurrent`: execution slots shared by the owned Agents under a root.
- `maxOutstanding`: unfinished inputs allowed under a root; it cannot be less
  than `maxConcurrent`.
- `extensions`: extension paths loaded by owned Agents, relative to Pi's
  agent directory.

## Specifications

- [SPEC.md](SPEC.md): Agents, messages, visibility, and limits.
- [PROGRAM.md](PROGRAM.md): Programs and the `agent()` API.
