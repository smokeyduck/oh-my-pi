import type { Model } from "@oh-my-pi/pi-ai";
import { cfgNoJudge, cfgOffline } from "../config/auxiliary-model-policy";
import type { ModelRegistry } from "../config/model-registry";
import {
	disabledProviderIds,
	getModelMatchPreferences,
	resolveModelOverride,
} from "../config/model-resolver";
import { hasNativeJudge, journalJudgmentUsage, judgeNatively } from "../judgment";
import question from "../prompts/judge/subagent-routing.json" with { type: "json" };
import type { ToolSession } from "../tools";
import {
	assertPerCallModelApproved,
	getPerCallModelAdvertisement,
	parentModelGrantPattern,
	PerCallModelError,
	type PerCallModelGrants,
} from "./model-approval";
import { isTaskJudgeRoutingEnabled } from "./settings";
import type { AgentDefinition } from "./types";

const TIMEOUT_MS = 1_500;
const MAX_ASSIGNMENT_CHARS = 8_000;
const MAX_CHOICES = 8;

/** A selection is an exact identity and the same grant snapshot that produced the choice list. */
export interface JudgedModelRoute {
	selector: string;
	modelId: string;
	provider: string;
	grants: PerCallModelGrants;
	parentProvider?: string;
}

function modelPermitted(
	model: Model,
	selector: string,
	grants: PerCallModelGrants,
	registry: ModelRegistry,
	parentProvider: string | undefined,
): boolean {
	const { settings } = grants;
	const authority = settings.grantAuthority();
	if (
		((cfgOffline.get(settings) || cfgOffline.get(authority)) && model.provider !== parentProvider) ||
		disabledProviderIds(settings).has(model.provider) ||
		disabledProviderIds(authority).has(model.provider) ||
		registry.isSelectorSuppressed(selector)
	) {
		return false;
	}
	try {
		assertPerCallModelApproved(model, grants, registry);
		return true;
	} catch (error) {
		if (error instanceof PerCallModelError) return false;
		throw error;
	}
}

/** Revalidate the exact approved route against current availability and settings before it is used. */
export function resolveJudgedModelRoute(route: JudgedModelRoute, registry: ModelRegistry): Model | undefined {
	if (!isTaskJudgeRoutingEnabled(route.grants.settings)) return undefined;
	const model = resolveModelOverride([route.selector], registry, undefined, { exactOnly: true }).model;
	if (
		model &&
		model.id === route.modelId &&
		model.provider === route.provider &&
		parentModelGrantPattern(model) === route.selector &&
		modelPermitted(model, route.selector, route.grants, registry, route.parentProvider)
	) {
		return model;
	}
}

export async function judgeSubagentModelRoute(
	request: { session: ToolSession; assignment: string; signal?: AbortSignal },
	agent: AgentDefinition,
	modelRole: string | undefined,
): Promise<JudgedModelRoute | undefined> {
	const { session, signal } = request;
	const { modelRegistry: registry, settings } = session;
	const assignment = request.assignment.trim().slice(0, MAX_ASSIGNMENT_CHARS);
	if (!registry || !assignment || signal?.aborted) return undefined;
	const sessionModel = session.getActiveModel?.();
	try {
		const authority = settings.grantAuthority();
		const liveDisabled = disabledProviderIds(settings);
		for (const provider of disabledProviderIds(authority)) {
			if (!liveDisabled.has(provider)) return undefined;
		}
		// A project cannot redirect the opted-in data to a different judge chain or relax a restriction.
		const moreRestricted = cfgNoJudge.get(settings) || cfgOffline.get(settings);
		const judgeSettings =
			moreRestricted && !cfgNoJudge.get(authority) && !cfgOffline.get(authority)
				? authority.overlay({ "models.noJudge": true })
				: authority;
		if (!hasNativeJudge(judgeSettings, registry, sessionModel)) return undefined;
		const parentModelPattern = sessionModel && parentModelGrantPattern(sessionModel);
		const grants: PerCallModelGrants = {
			settings,
			agentName: agent.name,
			agentModel: agent.model,
			agentSource: agent.source,
			parentModelPattern,
			matchPreferences: getModelMatchPreferences(authority),
		};
		const advertised = getPerCallModelAdvertisement(settings, sessionModel, registry);
		const available = registry.getAvailable("chat");
		const lookup = { getAvailable: () => available };
		const choices = new Map<string, JudgedModelRoute>();
		const seen = new Set<string>();
		const criteria: Record<string, string> = { keep: "Leave the normal Core model route unchanged." };
		const add = (pattern: string, role: string) => {
			const model = resolveModelOverride([pattern], lookup, undefined, { exactOnly: true }).model;
			const selector = model && parentModelGrantPattern(model);
			if (
				!model ||
				!selector ||
				seen.has(selector) ||
				!modelPermitted(model, selector, grants, registry, sessionModel?.provider)
			) {
				return;
			}
			seen.add(selector);
			const label = `route_${choices.size + 1}`;
			choices.set(label, {
				selector,
				modelId: model.id,
				provider: model.provider,
				grants,
				parentProvider: sessionModel?.provider,
			});
			criteria[label] = `${model.name} (${selector}); ${role}; context ${model.contextWindow} tokens; input price $${model.cost.input}/M tokens.`;
		};
		if (parentModelPattern && !advertised.parentModelWithheld) add(parentModelPattern, "active parent model");
		routes: for (const { role, patterns } of advertised.roles) {
			for (const pattern of patterns) {
				if (choices.size === MAX_CHOICES) break routes;
				add(pattern, `@${role}`);
			}
		}
		if (choices.size === 0) return undefined;
		const { answers } = await judgeNatively(
			"subagent-routing",
			{
				state: { assignment, agent: agent.name, normalRole: modelRole ?? null },
				questions: { route: { type: "choice", instructions: question.instructions, criteria } },
			},
			{
				settings: judgeSettings,
				registry,
				sessionModel,
				sessionId: session.getSessionId?.() ?? undefined,
				signal,
				onUsage: journalJudgmentUsage(session.sessionManager),
				telemetry: session.getTelemetry?.(),
				costGate: session.costGate,
			},
			TIMEOUT_MS,
		);
		return signal?.aborted ? undefined : choices.get(answers.route.choice);
	} catch {
		// Unavailable, timed out, or malformed judgments never block normal Core routing.
		return undefined;
	}
}
