# pi-agents

Multi-agent runtime for [Pi](https://pi.dev): hand work to other agents and keep going while they run.

https://github.com/user-attachments/assets/c1d48bc4-3b36-438e-976b-f76ae586ffdd

<details>
<summary>Play by play</summary>

1. Ask for three background reviews. Three Agents start, and the task panel lists them.
2. Ask about `res.redirect` while they run. The first review finishes, and its notification arrives.
3. `/agents` opens `review-application` to watch it work; `Ctrl+C` returns.
4. The other notifications arrive, and the main Agent reports each review.
5. Ask for a summary of each file in `lib/`. A background Program starts one Agent per file; the panel shows three running and the rest queued.
6. `Ctrl+Z` detaches and leaves the Session running. `pd agents` opens the workbench, and `Space` previews the Session.
7. Type a message in the preview to send it to the Session.
8. `Enter` attaches to the Session with the reply.

</details>

- **Async agents**: Agents run in parallel in the background and notify their parent when done.
- **Programmatic delegation**: Split long-horizon tasks in code into [calls the model handles well](https://alexzhang13.github.io/blog/2026/harness/), as in [RLM](https://alexzhang13.github.io/blog/2025/rlm/).
- **Inter-agent messaging**: Agents message each other, even in other Pi instances.
- **Workbench**: All your Sessions in one view; keep them running after the terminal closes.

## Install

```sh
npm install -g @tshu-w/pi-agents
pi install "$(npm root -g)/@tshu-w/pi-agents"
```

Requires Pi 1.0.0 or later. Start Pi with `pd` (or `pi-agents`) in place of `pi`, and enable `program` with `{ "defaultTools": ["+program"] }` in `settings.json`.

To use only the extension, without the workbench:

```sh
pi install npm:@tshu-w/pi-agents
```

## Usage

| Command | Does |
|---|---|
| `agent` tool | Starts, messages, and waits for Agents |
| `program` tool | Runs JavaScript that calls tools and Agents |
| `/agents` | Opens an Agent in the tree to watch and talk to it |
| `/tasks` | Hides or shows the task panel |
| `Ctrl+Z`, `/detach` | Leaves a Session running and returns to the shell |
| `pd agents` | Opens the workbench |
| `pd attach <session>` | Attaches to a Session, starting it if needed |

## Limitations

- Each Agent is one Pi Session; branches are not separate Agents. Use fork/clone to create independent Agents.
- A Session can be open in only one Pi instance at a time; quit the other or `pd attach` to it.

## Configuration

```json
"pi-agents": {
  "maxConcurrent": 3,
  "maxOutstanding": 8,
  "extensions": []
}
```

Concurrency limits per root, and extensions loaded by child Agents.

## Docs

- [SPEC.md](docs/SPEC.md): Agents, messages, and limits
- [PROGRAM.md](docs/PROGRAM.md): Programs and their API
- [WORKBENCH.md](docs/WORKBENCH.md): the workbench, hosts, and the daemon

## Evaluation

On [BrowseComp](https://arxiv.org/abs/2504.12516), async agents improved 7 of 8 models by up to 9 points; programmatic delegation kept accuracy with 20%+ fewer tokens.

## License

[AGPL-3.0](LICENSE)
