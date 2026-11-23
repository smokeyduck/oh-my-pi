import type { Effort, Model } from "@oh-my-pi/pi-ai";
import { hasVerifiedThinkingControl, supportsProviderAdaptiveThinking } from "@oh-my-pi/pi-catalog/model-thinking";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	clampThinkingLevelToCeiling,
	resolveThinkingLevelForModel,
} from "@oh-my-pi/pi-tui/thinking";
import type { Settings } from "../config/settings";
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
	if (!hasVerifiedThinkingControl(model)) return undefined;
	const level = selector === AUTO_THINKING || selector === "inherit" ? undefined : selector;
	// A bounded child run must not switch to unbounded provider adaptation.
	return resolveThinkingLevelForModel(model, clampThinkingLevelToCeiling(model, level ?? ceiling, ceiling));
}

export function desktopDefaultThinkingSelector(model: Model | undefined): ConfiguredThinkingLevel | undefined {
	if (supportsProviderAdaptiveThinking(model)) return AUTO_THINKING;
	return hasVerifiedThinkingControl(model) ? "inherit" : undefined;
}
