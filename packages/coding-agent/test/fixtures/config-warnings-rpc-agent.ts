import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { cfgMarketplaceAutoUpdate, cfgStartupCheckUpdate } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionTools } from "@oh-my-pi/pi-coding-agent/session/session-tools";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

// Real root startup, SDK resolution, registry and RPC dispatch. Only transport
// I/O is disabled, and the late-failure case injects a failed tool reconciliation.
const cwd = process.cwd();
const authStorage = createInMemoryAuthStorage();
const settings = Settings.isolated();
cfgMarketplaceAutoUpdate.override(settings, "off");
cfgStartupCheckUpdate.override(settings, false);
const registry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"), {
	fetch: async () => {
		throw new Error("Offline warning lifecycle fixture");
	},
});
const mode = Bun.env.WARNING_FIXTURE_MODE;
const savedSession = Bun.env.WARNING_FIXTURE_SESSION;
if (mode === "resume" && !savedSession) throw new Error("Missing disposable session path");
const persistedManager =
	mode === "resume"
		? await SessionManager.open(savedSession!)
		: mode === "persist"
			? SessionManager.create(cwd, path.join(cwd, "sessions"))
			: undefined;
await persistedManager?.ensureOnDisk();
if (mode === "resume") authStorage.keys.setRuntime("warning-fixture", "disposable-fixture-key");
if (mode === "late-failure") {
	const sync = SessionTools.prototype.syncAfterModelChange;
	let fail = true;
	SessionTools.prototype.syncAfterModelChange = async function (...args) {
		await sync.apply(this, args);
		if (fail) {
			fail = false;
			throw new Error("Fixture tool reconciliation failed");
		}
	};
}
const args = [
	"--mode",
	"rpc",
	"--no-session",
	"--no-extensions",
	"--no-skills",
	"--no-rules",
	"--no-tools",
	"--no-lsp",
	"--no-context-files",
];
await runRootCommand(parseArgs(args), args, {
	settings,
	discoverAuthStorage: async () => authStorage,
	createAgentSession: async options => {
		if (persistedManager) await options?.sessionManager?.close();
		const result = await createAgentSession({
			...options,
			authStorage,
			modelRegistry: registry,
			sessionManager: persistedManager ?? options?.sessionManager,
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		if (mode === "resume") {
			result.session.configWarnings.push("Fixture unrelated configuration warning");
			return result;
		}
		if (!result.modelFallbackMessage || result.session.model) throw new Error("Expected unresolved startup model");
		result.session.configWarnings.push("Fixture unrelated configuration warning");
		// Equal text must not let transient cleanup remove another warning's entry.
		if (mode !== "startup-race") result.session.configWarnings.push(result.modelFallbackMessage);
		authStorage.keys.setRuntime("warning-fixture", "disposable-fixture-key");
		if (mode === "startup-race") {
			const model = registry.find("warning-fixture", "fixture-model");
			if (!model) throw new Error("Fixture model missing");
			await result.session.setModel(model);
			// A delayed startup publisher must not resurrect the resolved diagnostic.
			result.session.setStartupModelWarning(result.modelFallbackMessage);
		}
		return result;
	},
});
await persistedManager?.close();
authStorage.close();
process.exit(0);
