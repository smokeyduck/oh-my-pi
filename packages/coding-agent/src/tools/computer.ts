import { type Type, type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { classifyModel } from "@oh-my-pi/pi-catalog/identity";
import type { DesktopCapabilities } from "@oh-my-pi/pi-natives";
import { once } from "@oh-my-pi/pi-utils";
import * as prompt from "@oh-my-pi/pi-utils/prompt";
import { callSessionTool } from "../eval/js/tool-bridge";
import type { EvalPreludeContext, HostEvalPreludeDefinition } from "../eval/preludes";
import computerUsePrompt from "../prompts/system/computer-use.md" with { type: "text" };
import { enforceInlineByteCap } from "@oh-my-pi/pi-tui/tools/streaming-output";
import {
	type ComputerCallStep,
	DESKTOP_METHODS,
	DISPLAY_METHODS,
	ELEMENT_METHODS,
	isReadOnlyComputerCall,
	renderComputerCall,
	WINDOW_METHODS,
} from "./computer/call";
import {
	type ComputerScreenshot,
	type ComputerSessionSnapshot,
	modelChoosesTakeover,
	type RunErrorPayload,
	screenStateNotice,
	secureInputNotice,
} from "./computer/protocol";
import {
	type ComputerController,
	ComputerSupervisor,
	computerTurnInFlight,
	registerComputerController,
} from "./computer/supervisor";
import type { ToolSession } from "./index";
import { renderFunctionRun, renderStatusCallChain } from "./run-code";
import { throwIfAborted } from "./tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { clampTimeout } from "./tool-timeouts";

import {
	cfgComputerTakeover,
	cfgComputerDisplay,
	cfgComputerEnabled,
	cfgComputerMaxHeight,
	cfgComputerMaxWidth,
	cfgToolsMaxTimeout,
} from "./settings";

// Image transports that cannot preserve native screenshot detail resize frames
// without returning transformed dimensions. Keep their native coordinate frames
// below the empirically verified threshold so pointer actions match what the
// model sees. Claude paths predate the resolved transport capability and retain
// their established model-family fallback.
const COORDINATE_SAFE_MAX_CAPTURE_WIDTH = 1280;
const COORDINATE_SAFE_MAX_CAPTURE_HEIGHT = 896;

function usesCoordinateSafeImageSizing(model: Model | undefined): boolean {
	if (!model) return false;
	const compat = model.compat;
	return (
		(!!compat && "supportsImageDetailOriginal" in compat && compat.supportsImageDetailOriginal === false) ||
		model.identity.class === "anthropic" ||
		(model.requestModelId !== undefined &&
			classifyModel(model.provider, model.requestModelId, { lenient: true }).class === "anthropic")
	);
}

interface ComputerRunParams {
	action: "run";
	code?: string;
	fn?: string;
	args?: unknown[];
	read_only?: boolean;
	timeout?: number;
}

interface ComputerCallParams {
	action: "call";
	chain: ComputerCallStep[];
	timeout?: number;
}

type ComputerToolParams = ComputerCallParams | { action: "capabilities" } | { action: "close" };
type ComputerParams = ComputerRunParams | ComputerToolParams;
type ComputerParamsSchema = Type<ComputerParams>;
const getComputerToolSchema: () => Type<ComputerToolParams> = once(() =>
	type({
		action: "'call'",
		chain: type({ method: "string", args: "unknown[]" })
			.array()
			.describe(
				"One desktop helper; window, display and ref can be followed by one handle method. Arguments are JSON data.",
			),
		"timeout?": type("number").describe("Call budget in seconds"),
		"+": "reject",
	})
		.or({ action: "'capabilities'", "+": "reject" })
		.or({ action: "'close'", "+": "reject" }),
);

const getComputerParamsSchema: () => ComputerParamsSchema = once(() =>
	type({
		action: "'run'",
		"code?": type("string").describe(
			"JavaScript executed in the persistent computer session; top-level await allowed; `desktop`, `wait`, `assert` in scope",
		),
		"fn?": type("string").describe("serialized function receiving the computer run scope and positional args"),
		"args?": type("unknown[]").describe("positional function arguments"),
		"read_only?": type("boolean").describe(
			"true = desktop inspection only: screenshots and ax reads allowed, desktop input/mutation blocked",
		),
		"timeout?": type("number").describe("run budget in seconds"),
		"+": "reject",
	}).or(getComputerToolSchema()),
);

interface ComputerPreludeDetails {
	code?: string;
	readOnly?: boolean;
	screenshots: ComputerScreenshot[];
	error?: RunErrorPayload;
	value?: unknown;
	backend?: string;
	capturePermission?: string;
	inputPermission?: string;
	axPermission?: string;
}

/** Creates the session-scoped controller used by the computer prelude. */
export type ComputerControllerFactory = (session: ToolSession) => ComputerController;

/** Capability inspection, explicitly read-only runs, and inspection-only direct calls use read approval. */
export function computerApproval(args: unknown): ToolApprovalDecision {
	if (args === null || typeof args !== "object" || Array.isArray(args) || !("action" in args)) return "exec";
	if (args.action === "capabilities") return "read";
	if (args.action === "call") {
		// Malformed chains fall to exec here and fail schema validation at invoke time.
		try {
			return "chain" in args && Array.isArray(args.chain) && isReadOnlyComputerCall(args.chain) ? "read" : "exec";
		} catch {
			return "exec";
		}
	}
	return args.action === "run" && "read_only" in args && args.read_only === true ? "read" : "exec";
}

// Each template has two takeover variants, with separate standalone and eval guidance.
const computerPromptRenders = {
	eval: [new Map<string, string>(), new Map<string, string>()],
	standalone: [new Map<string, string>(), new Map<string, string>()],
} as const;

function renderComputerPrompt(template: string, mode: ComputerSessionSnapshot["takeover"], standalone = false): string {
	const ompTakeover = !modelChoosesTakeover(mode);
	const renders = computerPromptRenders[standalone ? "standalone" : "eval"][ompTakeover ? 1 : 0];
	let rendered = renders.get(template);
	if (rendered === undefined) {
		rendered = prompt.render(template, { ompTakeover, standalone });
		renders.set(template, rendered);
	}
	return rendered;
}

function ownComputerController(session: ToolSession, controller: ComputerController): () => void {
	const unregister = registerComputerController(session.getEvalKernelOwnerId?.() ?? undefined, controller);
	return () => {
		unregister();
		void controller.close();
	};
}

const directComputerDescription = [
	"Inspect and operate the real host desktop. `capabilities` reports support; `close` releases the desktop session.",
	'Example: {"action":"call","chain":[{"method":"window","args":[{"app":"Notepad"}]},{"method":"ax","args":[]}]}',
	`Desktop methods: ${Object.keys(DESKTOP_METHODS).join(", ")}.`,
	`After window(id or filter): ${Object.keys(WINDOW_METHODS).join(", ")}.`,
	`After display(id): ${Object.keys(DISPLAY_METHODS).join(", ")}.`,
	`After ref(accessibility ref): ${Object.keys(ELEMENT_METHODS).join(", ")}.`,
	'Use window(id).click(x, y, options), window(id).type(text), window(id).press("ctrl+a"), or ref("e5").press().',
	"Coordinates come from the latest full screenshot of that target; zoom does not change that frame. Ref IDs come from a fresh accessibility tree.",
].join("\n");

/** Native desktop helpers without a general-purpose scripting backend. */
export function createComputerTool(session: ToolSession): AgentTool<Type<ComputerToolParams>, unknown> {
	let controller: ComputerController | undefined;
	const getController = () => {
		if (!controller) {
			controller = new ComputerSupervisor(session);
			const dispose = ownComputerController(session, controller);
			const cleanup = () => {
				unlisten();
				unregisterDispose?.();
				controller = undefined;
				dispose();
			};
			const unlisten = cfgComputerEnabled.listen(session.settings, enabled => {
				if (!enabled) cleanup();
			});
			const unregisterDispose = session.registerDisposeCallback?.(cleanup);
		}
		return controller;
	};
	return {
		name: "computer",
		label: "Computer",
		loadMode: "essential",
		concurrency: "exclusive",
		get description() {
			return `${directComputerDescription}\n\n${renderComputerPrompt(computerUsePrompt, cfgComputerTakeover.get(session.settings), true)}`;
		},
		parameters: getComputerToolSchema(),
		approval: args => {
			const tier = computerApproval(args);
			return tier === "read" || (args && typeof args === "object" && "action" in args && args.action === "close")
				? "read"
				: { tier: "exec", policy: "prompt", reason: "Desktop input or mutation" };
		},
		execute: async (_id, params, signal, _onUpdate, context) => {
			if (!cfgComputerEnabled.get(session.settings)) throw new ToolError("Computer use is disabled.");
			if (params.action === "close" && !controller)
				return { content: [{ type: "text", text: "No computer session open" }] };
			return await invokeComputer(session, getController(), params, { signal, context }, true);
		},
	};
}

/** Create the enabled-only computer host prelude for one tool session. */
export function createComputerPrelude(
	session: ToolSession,
	createController: ComputerControllerFactory = currentSession =>
		new ComputerSupervisor(currentSession, undefined, undefined, callSessionTool),
): HostEvalPreludeDefinition {
	const controller = createController(session);
	// Eval-first-use boundary: source/declaration assets stay unloaded until a
	// JavaScript or Python kernel actually asks for its enabled preludes.
	const { computerPreludeAssets } = require("./computer/prelude-definition");
	const dispose = ownComputerController(session, controller);
	session.registerDisposeCallback?.(dispose);

	return {
		name: "computer",
		// Read when the prompt is built, so a changed computer.takeover re-announces the prelude with the new text.
		get documentation() {
			return renderComputerPrompt(computerPreludeAssets.documentation, cfgComputerTakeover.get(session.settings));
		},
		inlineDocumentation: true,
		javascript: computerPreludeAssets.javascript,
		python: computerPreludeAssets.python,
		exports: ["computer"],
		get guidance() {
			return renderComputerPrompt(computerUsePrompt, cfgComputerTakeover.get(session.settings));
		},
		approval: computerApproval,
		enabled: () => cfgComputerEnabled.get(session.settings) === true,
		invoke: async (parameters, context) => {
			const parsed = getComputerParamsSchema()(parameters);
			if (parsed instanceof type.errors) {
				throw new ToolError(`computer received invalid arguments: ${parsed.summary}`);
			}
			return await invokeComputer(session, controller, parsed, context);
		},
		status: describeComputerCall,
	};
}

/** Status-tree line for a completed computer call: `desktop.window(3).focus()`, `run(fn)`, `close`. */
function describeComputerCall(parameters: unknown): string | undefined {
	const parsed = getComputerParamsSchema()(parameters);
	if (parsed instanceof type.errors) return undefined;
	switch (parsed.action) {
		case "call":
			// Text `type`, `setValue` and `clipboard.write` enter is their first argument.
			return `desktop.${renderStatusCallChain(parsed.chain, step =>
				step.method === "type" || step.method === "setValue" || step.method === "clipboard.write" ? 0 : undefined,
			)}`;
		case "run":
			return `run(${parsed.fn !== undefined ? "fn" : (parsed.code?.trim().split("\n", 1)[0] ?? "")})`;
		case "capabilities":
		case "close":
			return parsed.action;
	}
}

async function invokeComputer(
	session: ToolSession,
	controller: ComputerController,
	params: ComputerParams,
	context: Pick<EvalPreludeContext, "signal" | "context">,
	standalone = false,
): Promise<AgentToolResult<unknown>> {
	throwIfAborted(context.signal);

	switch (params.action) {
		case "run":
		case "call":
			return await runComputer(session, controller, params, context, standalone);
		case "capabilities": {
			const capabilities = await controller.capabilities(buildComputerSnapshot(session, true), context.signal);
			throwIfAborted(context.signal);
			return {
				content: [
					{
						type: "text",
						text: capabilities ? stringifyReturnValue(capabilities) : "Computer capabilities unavailable",
					},
				],
				details: capabilities,
			};
		}
		case "close":
			await controller.reset();
			throwIfAborted(context.signal);
			return { content: [{ type: "text", text: "Closed computer session" }] };
	}
}

const COMPUTER_RUN_SCOPE: readonly string[] = ["desktop", "wait", "assert"];

function resolveComputerRunCode(params: ComputerRunParams | ComputerCallParams, standalone: boolean): string {
	if (params.action === "call") return renderComputerCall(params.chain, standalone);
	const code = params.code?.trim();
	const fn = params.fn?.trim();
	const hasCode = code !== undefined && code.length > 0;
	const hasFunction = fn !== undefined && fn.length > 0;
	if (hasCode === hasFunction) {
		throw new ToolError("Action 'run' requires exactly one of 'code' or 'fn'.");
	}
	if (hasFunction && fn !== undefined) {
		return renderFunctionRun(fn, COMPUTER_RUN_SCOPE, params.args ?? []);
	}
	if (hasCode && code !== undefined) return code;
	throw new ToolError("Action 'run' requires exactly one of 'code' or 'fn'.");
}

/** Freezes the current session settings into the snapshot every worker command carries. */
function buildComputerSnapshot(session: ToolSession, readOnly: boolean): ComputerSessionSnapshot {
	const coordinateSafe = usesCoordinateSafeImageSizing(session.getActiveModel?.());
	const configuredMaxWidth = cfgComputerMaxWidth.get(session.settings);
	const configuredMaxHeight = cfgComputerMaxHeight.get(session.settings);
	return {
		cwd: session.cwd,
		sessionId: session.getEvalSessionId?.() ?? session.getSessionId?.() ?? "computer",
		agentId: session.getAgentId?.() ?? undefined,
		captureMaxWidth: coordinateSafe
			? Math.min(configuredMaxWidth, COORDINATE_SAFE_MAX_CAPTURE_WIDTH)
			: configuredMaxWidth,
		captureMaxHeight: coordinateSafe
			? Math.min(configuredMaxHeight, COORDINATE_SAFE_MAX_CAPTURE_HEIGHT)
			: configuredMaxHeight,
		display: cfgComputerDisplay.get(session.settings),
		readOnly,
		takeover: cfgComputerTakeover.get(session.settings),
		displayTurn: computerTurnInFlight(session.getEvalKernelOwnerId?.() ?? undefined),
	};
}

async function runComputer(
	session: ToolSession,
	controller: ComputerController,
	params: ComputerRunParams | ComputerCallParams,
	context: Pick<EvalPreludeContext, "signal" | "context">,
	standalone: boolean,
): Promise<AgentToolResult<unknown>> {
	const signal = context.signal;
	const code = resolveComputerRunCode(params, standalone);
	// Direct inspection calls run read-only so the desktop guard backs the read approval tier.
	const readOnly = params.action === "call" ? isReadOnlyComputerCall(params.chain) : (params.read_only ?? false);
	const timeoutSeconds = clampTimeout("computer", params.timeout, cfgToolsMaxTimeout.get(session.settings));
	const snapshot = buildComputerSnapshot(session, readOnly);
	const run = await controller.run(code, timeoutSeconds * 1000, snapshot, signal, context.context);
	throwIfAborted(signal);

	const details: ComputerPreludeDetails = {
		code,
		readOnly: snapshot.readOnly,
		screenshots: run.screenshots,
		error: run.error,
	};
	if (run.returnValue !== undefined) details.value = run.returnValue;
	populateCapabilityDetails(details, run.capabilities);

	const textParts = run.displays
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map(content => content.text);
	if (standalone && run.returnValue !== undefined) textParts.push(stringifyReturnValue(run.returnValue));
	const text = textParts.join("\n");
	const cappedText = await enforceInlineByteCap(text, {
		saveArtifact: full => saveComputerOutputArtifact(session, full),
	});
	const content: AgentToolResult<ComputerPreludeDetails>["content"] = [];
	const notice = screenStateNotice(run.capabilities);
	if (notice) content.push({ type: "text", text: notice });
	const secure = secureInputNotice(run.capabilities);
	if (secure) content.push({ type: "text", text: secure });
	if (cappedText) content.push({ type: "text", text: cappedText });
	for (const image of run.displays) {
		if (image.type === "image") content.push({ ...image, detail: "original" });
	}
	if (run.error) content.push({ type: "text", text: `${run.error.name}: ${run.error.message}` });
	return { content, details, ...(run.error ? { isError: true } : {}) };
}

function stringifyReturnValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function populateCapabilityDetails(
	details: ComputerPreludeDetails,
	capabilities: DesktopCapabilities | undefined,
): void {
	if (!capabilities) return;
	details.backend = capabilities.backend;
	details.capturePermission = capabilities.capturePermission;
	details.inputPermission = capabilities.inputPermission;
	details.axPermission = capabilities.axPermission;
}

/** Persist over-cap computer run output as a session artifact; mirrors the browser run save path. */
async function saveComputerOutputArtifact(session: ToolSession, fullText: string): Promise<string | undefined> {
	try {
		const alloc = await session.allocateOutputArtifact?.();
		if (!alloc?.path || !alloc.id) return undefined;
		await Bun.write(alloc.path, fullText);
		return alloc.id;
	} catch {
		return undefined;
	}
}
