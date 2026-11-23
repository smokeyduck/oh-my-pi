/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Memory backend selector — picks between local memories pipeline,
// Mnemopi local SQLite, Hindsight remote memory, Sharpshooter project
// decisions, or off. The legacy
// `memories.enabled` flag is migration input only; see config/settings.ts.
// Generic protocol hosts opt in. WISA STUDIO uses the local workbench by default.
export const cfgMemoryBackend = register({
	id: "memory.backend",
	protocolDefault: process.env.WISA_STUDIO_DEFAULTS === "1" ? undefined : ["rpc", "acp"],
	type: "enum",
	values: ["off", "local", "hindsight", "mnemopi", "sharpshooter"] as const,
	default: process.env.WISA_STUDIO_DEFAULTS === "1" ? "local" : "off",
	ui: {
		tab: "memory",
		group: "General",
		label: "Memory Backend",
		description: "Off, local summary pipeline, Mnemopi SQLite, Hindsight remote memory, or Sharpshooter",
		options: [
			{ value: "off", label: "Off", description: "No memory subsystem runs" },
			{ value: "local", label: "Local", description: "Local rollout summarisation pipeline (memory_summary.md)" },
			{ value: "hindsight", label: "Hindsight", description: "Vectorize Hindsight remote memory service" },
			{
				value: "mnemopi",
				label: "Mnemopi",
				description: "Local SQLite recall/retain backend with optional embeddings",
			},
			{
				value: "sharpshooter",
				label: "Sharpshooter",
				description:
					"Friction-gated project decision files (architecture/product/style), consolidated in the background",
			},
		],
	},
});
