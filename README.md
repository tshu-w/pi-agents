# pi-agents

A multi-agent runtime for [Pi](https://pi.dev): async agents, programmatic delegation, and inter-agent messaging.

- **Async agents**: the `agent` tool spawns Agents that work in the background and notify you when they finish.
- **Programmatic delegation**: the `program` tool runs JavaScript that calls tools and Agents, keeping intermediate results out of context, as in [RLM](https://alexzhang13.github.io/blog/2025/rlm/). Built on Pi's `codemode`.

  ```js
  const reviews = await Promise.all(files.map((file) => agent().send(`Review ${file}`)));
  ```

- **Inter-agent messaging**: Agents message each other to coordinate work, even across Pi processes.

On [BrowseComp](https://arxiv.org/abs/2504.12516), async agents improved 7 of 8 models by up to 9 points; programmatic delegation kept accuracy with 20%+ fewer tokens.

## Install

```sh
pi install git:github.com/tshu-w/pi-agents
```

Requires Pi 1.0.0 or later. Enable `program` with `{ "defaultTools": ["+program"] }` in `settings.json`.

## Configuration

```json
{ "pi-agents": { "maxConcurrent": 3, "maxOutstanding": 8, "extensions": [] } }
```

Concurrency limits per root, and extensions loaded by owned Agents. See [SPEC.md](docs/SPEC.md) and [PROGRAM.md](docs/PROGRAM.md) for details.
