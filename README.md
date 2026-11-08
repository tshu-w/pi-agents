# pi-agents

Multi-agent runtime for [Pi](https://pi.dev): hand work to agents that run in the background, persist past your terminal, and report back.

Built on it is a personal agent that delegates and stays free to talk.

- **Async agents**: Agents run in parallel and report back when done.
- **Persistent agents**: Agents keep running after the terminal closes; check on and attach to them from the workbench.
- **Inter-agent messaging**: Agents message each other, across Pi instances too.
- **Dynamic workflows**: Programs extend Pi's [codemode](https://pi.dev/docs/latest/codemode): the model writes JavaScript that calls tools and Agents to split long tasks recursively.

## Install

```sh
npm install -g @tshu-w/pi-agents
pi install "$(npm root -g)/@tshu-w/pi-agents"
```

Requires Pi 1.2.0 or later. Enable `program`, which replaces Pi's `codemode`, with `{ "defaultTools": ["+program"] }` in `settings.json`.

To use only the extension, without the workbench, run `pi install npm:@tshu-w/pi-agents`.

## Quick start

```sh
pd main      # talk to your personal agent
pd agents    # the workbench: all your Agents, grouped by what they need from you
```

Ask it in plain words, such as "review each package in the background". It starts Agents for the work and passes their results back to you.

| Key or command | Does |
|---|---|
| `Ctrl+Z`, `/detach` | Leaves the Agent running and returns to the shell |
| `pd attach <session>` | Attaches to an Agent, starting it if needed |
| `/tasks` | Opens an Agent or background Program to watch or talk to it |

Plain `pd` starts Pi as an Agent that can delegate the same way. Limits and the extensions child Agents load are set under `"pi-agents"` in `settings.json` ([SPEC §8](docs/SPEC.md#8-configuration)).

## Limitations

- An Agent can be open in only one Pi instance at a time; quit the other or `pd attach` to it.

## Evaluation

On [BrowseComp](https://arxiv.org/abs/2504.12516) and [ProgramBench](https://programbench.com/), pi-agents improved most models we tested by up to 10 points; its dynamic workflows can also cut tokens by 20% or more.

## Docs

- [SPEC.md](docs/SPEC.md): Agents, messages, and limits
- [HOSTS.md](docs/HOSTS.md): persistent Agents, `pd` commands, and the workbench
- [PROGRAM.md](docs/PROGRAM.md): Programs and their API

## License

[AGPL-3.0](LICENSE)
