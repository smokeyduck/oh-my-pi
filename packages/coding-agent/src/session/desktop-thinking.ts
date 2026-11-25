import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Effort, Model } from "@oh-my-pi/pi-ai";
import {
	defaultSupportedEffort,
	hasVerifiedThinkingControl,
	supportsProviderAdaptiveThinking,
} from "@oh-my-pi/pi-catalog/model-thinking";
import type { Settings } from "../config/settings";
import { AUTO_THINKING, clampThinkingLevelToCeiling, resolveThinkingLevelForModel } from "../thinking/levels";
import type { ConfiguredThinkingLevel } from "../utils/render-utils";
import { cfgDefaultThinkingLevel } from "./settings";

/** The GUI uses `auto` for provider adaptation, never for the CLI classifier. */
export function desktopThinkingEnabled(): boolean {
	return process.env.PI_GUI_NATIVE_THINKING === "1";
}

/** Honor a user-configured pin without mistaking CLI's built-in High for one. */
export function desktopThinkingSetting(settings: Settings): ConfiguredThinkingLevel | undefined {
	return cfgDefaultThinkingLevel.isConfigured(settings) ? cfgDefaultThinkingLevel.get(settings) : undefined;
}

export function resolveDesktopThinkingLevel(
	model: Model | undefined,
	selector: ConfiguredThinkingLevel | undefined,
	ceiling?: Effort,
) {
	if (!model || !hasVerifiedThinkingControl(model)) return undefined;
	const nativeAuto = supportsProviderAdaptiveThinking(model);
	const selected =
		selector === undefined || selector === "inherit" || (selector === AUTO_THINKING && !nativeAuto)
			? (model.thinking?.defaultLevel ?? (nativeAuto ? AUTO_THINKING : requiredDesktopEffort(model)))
			: selector;
	const level =
		selected === AUTO_THINKING
			? undefined
			: selected === ThinkingLevel.Off && !desktopSupportsThinkingOff(model)
				? (model.thinking?.defaultLevel ?? requiredDesktopEffort(model))
				: selected;
	return resolveThinkingLevelForModel(model, clampThinkingLevelToCeiling(model, level ?? ceiling, ceiling));
}

function requiredDesktopEffort(model: Model): Effort | undefined {
	if (model.thinking?.requiresEffort && !model.thinking.suppressWhenOff) return defaultSupportedEffort(model);
	return undefined;
}

export function desktopSupportsThinkingOff(model: Model): boolean {
	if (!hasVerifiedThinkingControl(model)) return false;
	if (model.thinking?.suppressWhenOff) return true;
	if (model.thinking?.requiresEffort) return false;
	if (model.thinking?.effortRouting?.off !== undefined) return true;
	const compat = model.compat;
	const keepsReasoning =
		(compat &&
			"reasoningDisableMode" in compat &&
			(compat.reasoningDisableMode === "lowest-effort" || compat.reasoningDisableMode === "omit")) ||
		(compat &&
			"disabledThinking" in compat &&
			(compat.disabledThinking === "adaptive" || compat.disabledThinking === "between-tools"));
	return !keepsReasoning;
}
