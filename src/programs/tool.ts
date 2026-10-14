import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Box } from "@earendil-works/pi-tui";
import { writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
import { steerQueued, SUBMIT_RESULT_TOOL_NAME, type Limits } from "../agents/agents.ts";
import { nodes, trackTreeWork, type AgentNode } from "../agents/registry.ts";
import { rejectFields } from "../params.ts";
import { agentSession } from "../roots/rpc.ts";
import { programScope } from "./scope.ts";
import type { PiCodemode } from "./codemode.ts";
import { executeProgram, PROGRAM_TOOL_NAME, type ProgramRunOptions } from "./execute.ts";
import { commandSession, runDetached } from "./host-patches.ts";
import { programDescription, programLoadout, programRenderers } from "./loadout.ts";
import { randomUUID } from "node:crypto";
import { CLEANUP_ERROR, programListLine, Programs, renderProgramWait } from "./programs.ts";
import { agentGlobals, withAgentPrefix } from "./sandbox.ts";

const PROGRAM_DESCRIPTION = `Run JavaScript that composes tool calls and Agents; only its output and return value reach the caller. \`run\` runs a Program in the foreground, or in the background with \`background\`; \`wait\` waits for background Programs and returns their results; \`list\` lists background Programs; \`stop\` stops a running Program. When a background Program ends while its caller is not waiting for it, the caller receives a notification; \`wait\` returns the result.

Program code is the body of an async function. It calls the caller's tools through \`tools.*\`, which excludes \`program\`, and creates Agents through \`agent()\`. These Agents belong to the Program, are isolated from other Agents, and go offline when it ends.

\`program\` replaces the \`codemode\` tool; wherever \`codemode\` is mentioned, use \`program\`.`;

const PROGRAM_MESSAGE = "pi-agents-program-run";
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

interface ProgramCall {
	path: string;
	args?: string;
	code: string;
}

interface ProgramMessageDetails {
	call: ProgramCall;
	calls?: unknown[];
	isError: boolean;
}

const AGENT_API = `Agent API:
\`\`\`ts
type JsonSchema = boolean | Record<string, unknown>;
interface AgentOptions {
  /** Default: generated, unique within the Program. */
  name?: string;
  /** Default: the caller's cwd. */
  cwd?: string;
  /** \`fresh\` starts without the caller's conversation; \`fork\` snapshots it. Default: \`fresh\`. */
  context?: "fresh" | "fork";
  /** provider/modelId. Default: the caller's model. */
  model?: string;
  /** Default: the caller's level. */
  thinkingLevel?: string;
}
interface SendOptions {
  /** Default: \`followUp\`. */
  deliverAs?: "followUp" | "steer" | "write";
  /** \`followUp\` only. The Agent must submit a value matching it. */
  schema?: JsonSchema;
  /** \`followUp\` only. Seconds before the input is aborted. Default: none. */
  timeout?: number;
}
interface AgentHandle {
  readonly id: string;
  readonly name: string;
  /** Resolves with the answer, or with the submitted value when \`schema\` is set; a write resolves with undefined once accepted. Throws if the input fails, is aborted, or times out. */
  send(message: string, options?: SendOptions): Promise<unknown>;
  /** Aborts the Agent's current turn and queued inputs; the Agent stays usable. */
  abort(): Promise<void>;
}

/** Creates an idle Agent that belongs to the Program. */
declare function agent(options?: AgentOptions): AgentHandle;
\`\`\``;

/** Registers the `program` tool and `submit_result`, which Agents of Programs use. */
export function registerProgramTools(
	pi: ExtensionAPI,
	{ agentDir, settings, piCodemode, requireNode, programs: getPrograms }: {
		agentDir: string;
		settings: Limits & { extensions: string[] };
		piCodemode: PiCodemode;
		requireNode: (current: ExtensionContext) => AgentNode;
		programs: () => Programs | undefined;
	},
): void {
	const renderers = programRenderers(piCodemode);

	/** Runs a Program whose Agents go offline when it ends. */
	const runProgram = async (
		id: string,
		caller: AgentNode,
		toolCallId: string,
		code: string,
		signal: AbortSignal,
		current: Parameters<typeof executeProgram>[3],
		{ background, args, ...options }: Pick<ProgramRunOptions, "timeout" | "onUpdate" | "detached" | "abort"> & { background?: boolean; args?: string },
	) => {
		const scope = programScope(id, caller, pi, current, { agentDir, limits: settings, extensions: settings.extensions, background: background === true });
		let run: Awaited<ReturnType<typeof executeProgram>> | undefined;
		try {
			run = await executeProgram(toolCallId, code, signal, current, {
				...options,
				globals: (track) => agentGlobals(scope.host, track),
				// On the first line, so line numbers in errors match the script as written.
				prepare: (source) => withAgentPrefix(args === undefined ? source : `const args = ${JSON.stringify(args)};${source}`),
				appendEntry: (customType, data) => pi.appendEntry(customType, data),
				getToolNamespace: (name) => pi.getAllTools().find((tool) => tool.name === name)?.namespace,
			});
		} finally {
			// A cleanup failure ends the result, which keeps the Program's output and calls.
			await scope.close().catch(() => {
				if (!run) return;
				run.result.content.push({ type: "text", text: CLEANUP_ERROR });
				run.result.isError = true;
				run.abandoned = true;
			});
		}
		return run;
	};

	pi.registerTool({
		name: SUBMIT_RESULT_TOOL_NAME,
		label: "Submit Result",
		description: "Submit the result that the current input asks for. `value` must match the JSON Schema given in the input; an invalid value is rejected with the reasons.",
		promptSnippet: "Submit the result that the current input asks for",
		exposure: "model-only",
		defaultActive: false,
		parameters: Type.Object({
			value: Type.Unknown({ description: "The result, matching the JSON Schema given in the input." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, current) {
			const self = requireNode(current);
			const owner = self.ownerId === undefined ? undefined : nodes.get(self.ownerId);
			if (!owner) throw new Error("No current input asks for a result.");
			owner.agents.submit(self.id, params.value);
			return { content: [{ type: "text", text: "Result submitted." }], details: {} };
		},
	});

	const codemodeReach = piCodemode.createCodemodeToolDefinition({}).reachesTools;
	pi.registerTool({
		name: PROGRAM_TOOL_NAME,
		label: "Program",
		// Programs must not start Programs.
		exposure: "model-only",
		defaultActive: false,
		prepareLoadout: programLoadout(pi, piCodemode, PROGRAM_DESCRIPTION, AGENT_API),
		// Only `run` reaches tools, as a `codemode` script does; extensions that register tools late wait on it.
		// MCP sees a run as a `codemode` call, without `action`.
		...(codemodeReach && { reachesTools: (input: { action?: string; code?: unknown }) => (input.action ?? "run") === "run" ? codemodeReach({ code: input.code }) : [] }),
		...renderers,
		description: programDescription(piCodemode, PROGRAM_DESCRIPTION, AGENT_API),
		promptSnippet: "Run JavaScript that composes tool calls and Agents",
		promptGuidelines: [
			"Use `program(action='run', code=...)` to call tools or Agents several times without a model turn between the calls, for example to read many files, filter large tool output, fan out Agents, or loop until a condition holds.",
			"Use `Promise.allSettled` for independent calls. Return only what the caller needs; use `text()` for progress worth reading.",
			"Use `background=true` for long Programs, and `program(action='wait', ...)` when the next step depends on their results.",
		],
		parameters: Type.Object({
			action: StringEnum(["run", "wait", "list", "stop"] as const, { description: "Operation and applicable parameters: `run(code, background?, timeout?)`, `wait(target?, timeout?)`, `list(limit?, offset?)`, or `stop(target)`." }),
			code: Type.Optional(Type.String({ description: "JavaScript async-function body for `run`." })),
			background: Type.Optional(Type.Boolean({ description: "Whether `run` returns the Program ID at once (default: false)." })),
			timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Maximum seconds. For `run` (default: none), expiry stops the Program. For `wait` (default: 30, min: 10, max: 3600), expiry does not stop Programs." })),
			target: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Program ID or unique ID prefix for `wait` or `stop`. `wait` also accepts an array. When omitted for `wait`, selects running Programs and ended Programs whose result has not been returned." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Maximum Programs returned by `list` (default: 20, max: 200)." })),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Number of Programs to skip for `list` (default: 0)." })),
		}),
		async execute(toolCallId, params, signal, onUpdate, current) {
			const self = requireNode(current);
			const programs = getPrograms();
			if (!programs) throw new Error("pi-agents is not initialized");
			const targets = params.target === undefined ? undefined : Array.isArray(params.target) ? params.target : [params.target];
			switch (params.action) {
				case "run": {
					rejectFields(params, "run", ["target", "limit", "offset"]);
					if (!params.code?.trim()) throw new Error("run requires code");
					const code = params.code;
					if (params.background) {
						const record = programs.start(code, (id, programSignal, abort, update) => runProgram(id, self, toolCallId, code, programSignal, current, { timeout: params.timeout, background: true, detached: true, abort, onUpdate: update }));
						return { content: [{ type: "text", text: `Program ${programs.label(record)} started.` }], details: { id: record.id } };
					}
					const { result } = await self.agents.whileSuspended(() => runProgram(randomUUID(), self, toolCallId, code, signal ?? new AbortController().signal, current, {
						timeout: params.timeout,
						onUpdate,
					}), signal);
					return result;
				}
				case "wait": {
					rejectFields(params, "wait", ["code", "background", "limit", "offset"]);
					const timeout = params.timeout ?? 30;
					if (timeout < 10 || timeout > 3600) throw new Error("wait timeout must be between 10 and 3600 seconds");
					const selected = programs.select(targets);
					onUpdate?.({ content: [], details: undefined });
					const session = agentSession(current.sessionManager);
					const waitFor = () => programs!.wait(selected, timeout, signal, () => steerQueued(session?.agent));
					const outcome = programs.running(selected) ? await self.agents.whileSuspended(waitFor, signal, true) : await waitFor();
					const rendered = renderProgramWait(outcome, programs.ids());
					programs.markReturned(rendered.returned);
					return { content: rendered.content, details: { running: outcome.running.map((record) => record.id), ...(outcome.interrupted && { interrupted: true }) } };
				}
				case "list": {
					rejectFields(params, "list", ["code", "background", "timeout", "target"]);
					const offset = params.offset ?? 0;
					const limit = params.limit ?? 20;
					const records = programs.list();
					if (records.length === 0) return { content: [{ type: "text", text: "No Programs." }], details: { total: 0 } };
					const page = records.slice(offset, offset + limit);
					const lines = page.map((record) => programListLine(record, programs!.ids()));
					const remaining = records.length - offset - page.length;
					if (remaining > 0) lines.push(`[${remaining} more results. Use offset=${offset + page.length} to continue.]`);
					return { content: [{ type: "text", text: lines.join("\n") }], details: { total: records.length } };
				}
				case "stop": {
					rejectFields(params, "stop", ["code", "background", "timeout", "limit", "offset"]);
					if (targets?.length !== 1) throw new Error("stop requires one target");
					const program = programs.target(targets[0]!);
					const stopped = await programs.stop(program);
					return {
						content: [{ type: "text", text: `Program ${programs.label(program.record)} ${stopped ? "stopped" : "has already ended"}.` }],
						details: { id: program.record.id, stopped },
					};
				}
			}
		},
	});

	/** A run as Pi shows a `run` call: the script, then its calls and output. */
	const renderRun = (call: ProgramCall, result: { content: unknown[]; details?: unknown }, isPartial: boolean, isError: boolean, expanded: boolean, outputPad: number, theme: Theme) => {
		const component = new Box(outputPad, 1, (text) => theme.bg(isPartial ? "toolPendingBg" : isError ? "toolErrorBg" : "toolSuccessBg", text));
		const context = { args: call, state: {}, executionStarted: true, expanded, isError, showImages: false, isPartial } as never;
		component.addChild(renderers.renderCall!(call, theme, context));
		component.addChild(renderers.renderResult!(result as never, { expanded, isPartial }, theme, context));
		return component;
	};

	/** Runs `/program <path> [args]` in the foreground: shown above the editor while it runs, and added to the context like a `!` command. */
	const runCommand = async (text: string, current: ExtensionCommandContext) => {
		const self = requireNode(current);
		const session = commandSession()!;
		const [, file, args = ""] = /^(\S+)\s*([\s\S]*)$/.exec(text.trim()) ?? [];
		if (!file) throw new Error("Usage: /program <path> [args]");
		const code = await readFile(path.resolve(current.cwd, file), "utf8");
		const toolCallId = `program-command-${randomUUID()}`;
		const call: ProgramCall = { path: file, ...(args ? { args } : {}), code };
		const controller = new AbortController();
		// Pi's Esc cancels running `!` commands while no reply is streaming; it stops the Program likewise.
		const stop = { abort: () => controller.abort(new Error("Program stopped")) };
		session._bashAbortControllers.add(stop);
		const release = trackTreeWork(self.rootId);
		const widget = `${PROGRAM_MESSAGE}:${toolCallId}`;
		const shown = current.mode === "tui";
		let partial: { content: unknown[]; details?: unknown; isError?: boolean } = { content: [] };
		let ended = false;
		let tui: { requestRender(): void } | undefined;
		if (shown) {
			current.ui.setWidget(widget, (ui, theme) => {
				tui = ui;
				const outputPad = pi.getSettings().outputPad === 0 ? 0 : 1;
				return { render: (width: number) => renderRun(call, partial, !ended, partial.isError === true, current.ui.getToolsExpanded(), outputPad, theme).render(width), invalidate() {} };
			});
		}
		let run: Awaited<ReturnType<typeof runProgram>>;
		try {
			// Hooks see the run as a `run` call, so MCP waits for the servers the script names.
			const blocked = await runDetached<{ block?: boolean; reason?: string } | undefined>(session, controller.signal, stop.abort, () => session._beforeToolCall({ toolCall: { name: PROGRAM_TOOL_NAME, id: toolCallId }, args: { action: "run", code } }));
			if (blocked?.block) throw new Error(blocked.reason || "Tool execution was blocked");
			const ctx = session._extensionRunner.createToolContext(toolCallId, controller.signal);
			run = await runProgram(randomUUID(), self, toolCallId, code, controller.signal, ctx, {
				detached: true,
				abort: stop.abort,
				args,
				onUpdate: (partialResult) => {
					partial = partialResult;
					tui?.requestRender();
				},
			});
		} catch (error) {
			if (shown) current.ui.setWidget(widget, undefined);
			throw error;
		} finally {
			session._bashAbortControllers.delete(stop);
			release();
		}
		const { result } = run;
		const details: ProgramMessageDetails = { call, calls: (result.details as { calls?: unknown[] } | undefined)?.calls, isError: result.isError === true };
		if (shown) {
			// During a reply, the message comes after the reply; until then the widget shows the result.
			partial = result;
			ended = true;
			tui?.requestRender();
			const unsubscribe = session.subscribe((event: { type: string; message?: { details?: unknown } }) => {
				if (event.type !== "message_start" || event.message?.details !== details) return;
				unsubscribe();
				current.ui.setWidget(widget, undefined);
			});
		}
		const send = () => pi.sendMessage({ customType: PROGRAM_MESSAGE, content: [{ type: "text", text: `Ran \`/program ${text.trim()}\`\n` }, ...result.content], display: true, details }, { triggerTurn: false });
		// Like a `!` command that ends during a reply, the run joins the context once the reply has ended.
		if (session.isStreaming) {
			const unsubscribe = session.subscribe((event: { type: string }) => {
				if (event.type !== "agent_settled") return;
				unsubscribe();
				send();
			});
		} else send();
		if (current.mode !== "print") return;
		const [first, ...rest] = result.content;
		const output = first?.type === "text" && SCRIPT_HEADER.test(first.text) ? rest : result.content;
		const body = output.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
		if (result.isError) {
			process.stderr.write(`${body}\n`);
			process.exitCode = 1;
		} else await writeStdout(`${body}\n`);
	};

	pi.registerCommand(PROGRAM_TOOL_NAME, {
		description: "Run the Program script in a file, with the text after the path as `args`",
		handler: async (text, current) => {
			try {
				await runCommand(text, current);
			} catch (error) {
				// Pi reports the error; `pi -p` also exits with status 1.
				if (current.mode === "print") process.exitCode = 1;
				throw error;
			}
		},
	});

	pi.registerMessageRenderer<ProgramMessageDetails>(PROGRAM_MESSAGE, (message, { expanded, outputPad }, theme) => {
		const { details } = message;
		if (!details) return undefined;
		const content = (message.content as unknown[]).slice(1);
		return renderRun(details.call, { content, details: { calls: details.calls } }, false, details.isError, expanded, outputPad, theme);
	});
}

/** Writes all of `text` to stdout, which print mode sends to stderr and Pi makes non-blocking. */
async function writeStdout(text: string): Promise<void> {
	let rest = Buffer.from(text);
	while (rest.length > 0) {
		try {
			rest = rest.subarray(writeSync(1, rest));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
}
