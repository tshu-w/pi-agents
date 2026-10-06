import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { nodes, SUBMIT_RESULT_TOOL_NAME, type AgentNode, type Limits } from "../agents/agents.ts";
import { rejectFields } from "../params.ts";
import { programScope } from "./agents.ts";
import type { PiCodemode } from "./codemode.ts";
import { executeProgram, PROGRAM_TOOL_NAME, type ProgramRunOptions } from "./execute.ts";
import { programDescription, programLoadout, programRenderers } from "./loadout.ts";
import { randomUUID } from "node:crypto";
import { programListLine, Programs, renderProgramWait } from "./programs.ts";
import { agentGlobals, withAgentPrefix } from "./sandbox.ts";

const PROGRAM_DESCRIPTION = `Run JavaScript that composes tool calls and Agents; only its output and return value reach the caller. \`run\` runs a Program in the foreground, or in the background with \`background\`; \`wait\` waits for background Programs and returns their results; \`list\` lists background Programs; \`stop\` stops a running Program. When a background Program ends while its caller is not waiting for it, the caller receives a notification; \`wait\` returns the result.

Program code is the body of an async function. It calls the caller's tools through \`tools.*\`, which excludes \`program\`, and creates Agents through \`agent()\`. These Agents belong to the Program, are isolated from other Agents, and go offline when it ends.

\`program\` replaces the \`codemode\` tool; wherever \`codemode\` is mentioned, use \`program\`.`;

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
}
interface AgentHandle {
  readonly id: string;
  readonly name: string;
  /** Resolves with the answer, or with the submitted value when \`schema\` is set; a write resolves with undefined once accepted. Throws if the input fails or is aborted. */
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
	/** Runs a Program whose Agents go offline when it ends. */
	const runProgram = async (
		id: string,
		caller: AgentNode,
		toolCallId: string,
		code: string,
		signal: AbortSignal,
		current: Parameters<typeof executeProgram>[3],
		options: Pick<ProgramRunOptions, "timeout" | "onUpdate" | "background" | "abort">,
	) => {
		const scope = programScope(id, caller, pi, current, { agentDir, limits: settings, extensions: settings.extensions });
		try {
			return await executeProgram(toolCallId, code, signal, current, {
				...options,
				globals: agentGlobals(scope.host),
				prepare: withAgentPrefix,
				appendEntry: (customType, data) => pi.appendEntry(customType, data),
				getToolNamespace: (name) => pi.getAllTools().find((tool) => tool.name === name)?.namespace,
			});
		} finally {
			await scope.close();
		}
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

	pi.registerTool({
		name: PROGRAM_TOOL_NAME,
		label: "Program",
		// Programs must not start Programs.
		exposure: "model-only",
		defaultActive: false,
		prepareLoadout: programLoadout(pi, piCodemode, PROGRAM_DESCRIPTION, AGENT_API),
		...programRenderers(piCodemode),
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
						const record = programs.start((id, programSignal, abort) => runProgram(id, self, toolCallId, code, programSignal, current, { timeout: params.timeout, background: true, abort }));
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
					const waitFor = () => programs!.wait(selected, timeout, signal);
					const outcome = programs.running(selected) ? await self.agents.whileSuspended(waitFor, signal) : await waitFor();
					const rendered = renderProgramWait(outcome, programs.ids());
					programs.markReturned(rendered.returned);
					return { content: rendered.content, details: { running: outcome.running.map((record) => record.id) } };
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
}
