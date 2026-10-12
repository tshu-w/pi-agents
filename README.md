# pi-agents

Multi-agent runtime for [Pi](https://pi.dev): hand work to other agents and keep going while they run.

https://github.com/user-attachments/assets/52dd1de6-bf26-45ea-8775-2b1a1a187f4f

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
- **Dynamic workflows**: Extends Pi's [codemode](https://pi.dev/docs/latest/codemode) to recursively split long-horizon tasks into calls the model handles well, as in [RLM](https://alexzhang13.github.io/blog/2026/harness/).
- **Inter-agent messaging**: Agents message each other, even in other Pi instances.
- **Persistent agents**: Agents keep running after the terminal closes, with a workbench to manage them.

## Install

```sh
npm install -g @tshu-w/pi-agents
pi install "$(npm root -g)/@tshu-w/pi-agents"
```

Requires Pi 1.0.0 or later. Start Pi with `pd` (or `pi-agents`) in place of `pi`, and enable `program`, which replaces Pi's `codemode`, with `{ "defaultTools": ["+program"] }` in `settings.json`.

To use only the extension, without the workbench:

```sh
pi install npm:@tshu-w/pi-agents
```

## Usage

Ask Pi in plain words; it starts Agents and Programs when the work calls for them.

| Term | Meaning |
|---|---|
| Agent | A Pi conversation: yours, or one started with the `agent` tool |
| Program | JavaScript the model runs with the `program` tool to call tools and Agents |
| Workbench | `pd agents`: your recent Sessions, running or not, grouped by what they need from you |

| Command | Does |
|---|---|
| `/agents` | Opens an Agent in the tree to watch and talk to it |
| `/tasks` | Hides or shows the task panel |
| `Ctrl+Z`, `/detach` | Leaves a Session running and returns to the shell |
| `pd agents` | Opens the workbench |
| `pd attach <session>` | Attaches to a Session, starting it if needed |

## Configuration

```json
"pi-agents": {
  "maxConcurrent": 3,
  "maxOutstanding": 8,
  "extensions": []
}
```

Each tree runs at most `maxConcurrent` child Agents at once and accepts at most `maxOutstanding` unfinished inputs. `extensions` lists extensions loaded by child Agents.

## Limitations

- Each Agent is one Pi Session, so branches within it are not separate Agents; use `/fork` or `/clone` to make one.
- A Session can be open in only one Pi instance at a time; quit the other or `pd attach` to it.

## Evaluation

On [BrowseComp](https://arxiv.org/abs/2504.12516), async agents improved 7 of 8 models by up to 9 points; dynamic workflows kept accuracy with 20%+ fewer tokens.

## Docs

- [SPEC.md](docs/SPEC.md): Agents, messages, and limits
- [PROGRAM.md](docs/PROGRAM.md): Programs and their API
- [HOSTS.md](docs/HOSTS.md): hosted Sessions, the daemon, and the workbench

## License

[AGPL-3.0](LICENSE)
