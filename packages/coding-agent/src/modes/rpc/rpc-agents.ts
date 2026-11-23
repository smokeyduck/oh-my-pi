/**
 * Per-subagent lifecycle RPC actions (TUI Agent Hub `x`/`r` parity,
 * agent-hub.ts #killSelected/#reviveSelected).
 *
 * - abort: USER_INTERRUPT abort of the running session + tombstone release.
 *   Read-only advisor transcripts and the main agent are refused.
 * - revive: AgentLifecycleManager.ensureLive — idempotent for live agents,
 *   revives parked ones; unknown/aborted ids surface as `not_parked`.
 */

import { cfgOffline } from "../../config/auxiliary-model-policy";
import {
	type AgentModelSelection,
	formatModelStringWithRouting,
	previewSubagentModel,
	resolveAgentModelSelection,
	resolveAgentPrewalkPattern,
	resolveModelOverride,
} from "../../config/model-resolver";
import { cfgTaskAgentModelOverrides, cfgTaskAgentPrewalk, cfgTaskPrewalk } from "../../task/settings";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import { discoverAgents } from "../../task/discovery";
import { resolveAgentPrewalkDefault } from "../../task/prewalk";
import type { RpcAgentDefinitionsResult } from "./rpc-types";

export type RpcSubagentActionReason = "advisor_readonly" | "main_agent" | "not_found" | "not_parked" | "abort_failed";

export interface RpcSubagentActionResult {
	ok: boolean;
	reason?: RpcSubagentActionReason;
}

/** Workspace-visible definitions and the same model/prewalk projection as the TUI control center. */
export async function buildRpcAgentDefinitions(session: AgentSession): Promise<RpcAgentDefinitionsResult> {
	const { agents } = await discoverAgents(session.sessionManager.getCwd(), undefined, session.effectiveExtensionRoots);
	const activeModelPattern = session.model ? formatModelStringWithRouting(session.model) : undefined;
	const defaultModelPattern = session.settings.getModelRole("default");
	const modelOverrides = cfgTaskAgentModelOverrides.get(session.settings);
	const prewalkOverrides = cfgTaskAgentPrewalk.get(session.settings);
	const taskPrewalk = cfgTaskPrewalk.get(session.settings);
	const models = session.modelRegistry.getAvailable();
	const registry = {
		getAvailable: () => models,
		isSelectorSuppressed: (selector: string) => session.modelRegistry.isSelectorSuppressed(selector),
	};
	const allowedProvider = cfgOffline.get(session.settings) ? (session.model?.provider ?? null) : undefined;
	const preview = ({ patterns, source }: AgentModelSelection) =>
		previewSubagentModel(patterns, activeModelPattern, registry, session.settings, {
			allowedProvider,
			preferHealthy: source === "catalogRole",
		});

	return {
		agents: agents.map(agent => {
			const base = {
				agentModel: agent.model,
				settings: session.settings,
				activeModelPattern,
				fallbackModelPattern: defaultModelPattern,
			};
			const defaults = resolveAgentModelSelection(base);
			const override = modelOverrides[agent.name];
			const effective = override ? resolveAgentModelSelection({ ...base, settingsOverride: override }) : defaults;
			const defaultResolution = preview(defaults);
			const effectiveResolution = effective === defaults ? defaultResolution : preview(effective);
			const prewalkPattern = resolveAgentPrewalkPattern({
				settingsOverride: prewalkOverrides[agent.name],
				agentPrewalk: resolveAgentPrewalkDefault(agent, taskPrewalk),
			});
			const prewalkModel = prewalkPattern
				? resolveModelOverride([prewalkPattern], registry, session.settings).model
				: undefined;
			return {
				name: agent.name,
				description: agent.description,
				source: agent.source,
				filePath: agent.filePath,
				model: agent.model,
				thinkingLevel: agent.thinkingLevel,
				tools: agent.tools,
				spawns: agent.spawns,
				autoloadSkills: agent.autoloadSkills,
				output: agent.output,
				blocking: agent.blocking,
				readSummarize: agent.readSummarize,
				prewalk: agent.prewalk,
				defaultPatterns: defaults.patterns,
				defaultResolved: defaultResolution.model && formatModelStringWithRouting(defaultResolution.model),
				effectivePatterns: effective.patterns,
				effectiveResolved: effectiveResolution.model && formatModelStringWithRouting(effectiveResolution.model),
				effectiveThinkingLevel: effectiveResolution.thinkingLevel,
				modelSelection: {
					source: effective.source,
					role: effective.role,
					provider: effectiveResolution.model?.provider,
					usesParentFallback: effectiveResolution.usesParentFallback,
				},
				prewalkPattern,
				prewalkResolved: prewalkModel && formatModelStringWithRouting(prewalkModel),
			};
		}),
	};
}

export async function applyRpcAbortSubagent(agentId: string): Promise<RpcSubagentActionResult> {
	if (agentId === MAIN_AGENT_ID) return { ok: false, reason: "main_agent" };
	const ref = AgentRegistry.global().get(agentId);
	if (!ref) return { ok: false, reason: "not_found" };
	if (ref.kind === "advisor") return { ok: false, reason: "advisor_readonly" };
	try {
		if (ref.status === "running" && ref.session) {
			await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
		}
		await AgentLifecycleManager.global().release(ref.id, ref, { tombstone: true });
		return { ok: true };
	} catch {
		return { ok: false, reason: "abort_failed" };
	}
}

export async function applyRpcReviveSubagent(agentId: string): Promise<RpcSubagentActionResult> {
	if (agentId === MAIN_AGENT_ID) return { ok: false, reason: "main_agent" };
	const ref = AgentRegistry.global().get(agentId);
	if (!ref) return { ok: false, reason: "not_found" };
	if (ref.kind === "advisor") return { ok: false, reason: "advisor_readonly" };
	try {
		// Idempotent for live agents (returns the live session); revives parked
		// ones. Throws for unknown ids (pre-checked above) and for refs with no
		// reviver (aborted/tombstoned or never adopted).
		await AgentLifecycleManager.global().ensureLive(agentId);
		return { ok: true };
	} catch {
		return { ok: false, reason: "not_parked" };
	}
}
