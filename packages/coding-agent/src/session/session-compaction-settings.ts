import { isRecord } from "@oh-my-pi/pi-utils";
import type { AnySetting } from "../config/registry";
import type { Settings } from "../config/settings";
import { DEFAULT_COMPACTION_METHOD_ORDER, resolveCompactionMethodOrder } from "./compaction-methods";
import {
	cfgCompactionEnabled,
	cfgCompactionExperimentalContextManagement,
	cfgCompactionKeepRecentTokens,
	cfgCompactionMethodOrder,
	cfgCompactionThresholdPercent,
	cfgContextPromotionEnabled,
} from "./context-settings";
import type { SessionHeader } from "./session-entries";
import type { SessionManager } from "./session-manager";

const ENTRY_TYPE = "session-compaction-settings";
const ALLOWED = new Map<string, AnySetting>(
	[
		cfgCompactionEnabled,
		cfgCompactionExperimentalContextManagement,
		cfgCompactionKeepRecentTokens,
		cfgCompactionMethodOrder,
		cfgCompactionThresholdPercent,
		cfgContextPromotionEnabled,
	].map(setting => [setting.id, setting]),
);

/** Preferences for one transcript, not its global or project settings. */
export class SessionCompactionSettings {
	#header: SessionHeader | null | undefined;
	#values?: Record<string, unknown>;
	readonly #baseOverrides = new Map<AnySetting, unknown>();

	constructor(
		private readonly manager: SessionManager,
		private readonly settings: Settings,
	) {}

	restore(): void {
		const header = this.manager.getHeader();
		if (header === this.#header) return;
		this.#header = header;
		for (const [setting, base] of this.#baseOverrides) {
			if (base === undefined) setting.clearOverride(this.settings);
			else setting.override(this.settings, base);
		}
		this.#baseOverrides.clear();
		this.#values = undefined;

		const saved = this.manager.findLastCustomEntry(ENTRY_TYPE)?.data;
		// Forks can copy entries but must not adopt settings belonging to their parent.
		if (!isRecord(saved) || saved.sessionId !== header?.id || !isRecord(saved.values)) return;
		for (const [path, value] of Object.entries(saved.values)) {
			const setting = ALLOWED.get(path);
			if (!setting) continue;
			try {
				setting.assertWritable(value);
			} catch {
				continue;
			}
			this.#apply(setting, value);
		}
	}

	patch(values: unknown): void {
		if (!isRecord(values)) throw new Error("Expected compaction settings for the current session");
		const entries = Object.entries(values);
		if (entries.length === 0) return;
		// Validate the whole preset before changing any of it.
		const patch = entries.map(([path, value]) => {
			const setting = ALLOWED.get(path);
			if (!setting) throw new Error(`Not a session compaction setting: ${path}`);
			setting.assertWritable(value);
			return [setting, value] as const;
		});
		for (const [setting, value] of patch) this.#apply(setting, value);
		if (
			values[cfgCompactionEnabled.id] === true &&
			resolveCompactionMethodOrder(cfgCompactionMethodOrder.get(this.settings)).length === 0
		) {
			this.#apply(cfgCompactionMethodOrder, [...DEFAULT_COMPACTION_METHOD_ORDER]);
		}
		this.manager.appendCustomEntry(
			ENTRY_TYPE,
			{ sessionId: this.manager.getSessionId(), values: { ...this.#values } },
			{ preserveLeaf: true },
		);
	}

	#apply(setting: AnySetting, value: unknown): void {
		if (!this.#baseOverrides.has(setting)) {
			this.#baseOverrides.set(
				setting,
				this.settings.hasRuntimeOverride(setting) ? setting.get(this.settings) : undefined,
			);
		}
		(this.#values ??= {})[setting.id] = value;
		setting.override(this.settings, value);
	}
}
