import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CreateAgentSessionOptions, createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

import {
	cfgIncludeWorkspaceTree,
	cfgOmitThinking,
	cfgPersonality,
	cfgTemperature,
	cfgTierOpenai,
	cfgTopP,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgTtsrEnabled } from "@oh-my-pi/pi-coding-agent/export/ttsr-settings";
import {
	cfgCompactionEnabled,
	cfgCompactionMethodOrder,
	cfgCompactionThresholdPercent,
	cfgToolsFormat,
} from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { cfgInterruptMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgSteeringMode } from "@oh-my-pi/pi-coding-agent/modes/settings";

describe("AgentSession live settings", () => {
	const tempDirs: string[] = [];
	let modelRegistry!: ModelRegistry;
	let authDir: string;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		authDir = path.join(os.tmpdir(), `pi-live-settings-auth-${Snowflake.next()}`);
		fs.mkdirSync(authDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(authDir));
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		for (const dir of tempDirs.splice(0)) removeSyncWithRetries(dir);
	});

	afterAll(() => {
		// The discovered auth DB lives in authDir; Windows cannot delete it while open.
		modelRegistry.authStorage.close();
		removeSyncWithRetries(authDir);
	});

	const start = async (
		settings: Settings,
		extra?: Pick<CreateAgentSessionOptions, "systemPrompt" | "sessionManager">,
	): Promise<AgentSession> => {
		const cwd = extra?.sessionManager?.getCwd() ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-live-settings-"));
		if (!extra?.sessionManager) tempDirs.push(cwd);
		const created = await createAgentSession({
			cwd,
			agentDir: cwd,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			workspaceTree: {
				rootPath: cwd,
				rendered: "live-settings-tree-marker/",
				truncated: false,
				totalLines: 1,
				agentsMdFiles: [],
			},
			...extra,
		});
		session = created.session;
		return created.session;
	};

	it("applies settings changed through code to the running agent without a UI", async () => {
		const settings = Settings.isolated();
		const live = await start(settings);

		cfgTemperature.set(settings, 0.2);
		cfgTopP.set(settings, -1);
		cfgSteeringMode.set(settings, "all");
		cfgInterruptMode.set(settings, "wait");
		cfgOmitThinking.set(settings, true);
		cfgTierOpenai.set(settings, "priority");
		await Promise.resolve();

		expect(live.agent.temperature).toBe(0.2);
		expect(live.agent.topP).toBeUndefined();
		expect(live.steeringMode).toBe("all");
		expect(live.interruptMode).toBe("wait");
		expect(live.agent.hideThinkingSummary).toBe(true);
		expect(live.serviceTierByFamily.openai).toBe("priority");
		// Exactly one transcript entry: the watch applies the tier once.
		const tierEntries = live.sessionManager.getBranch().filter(entry => entry.type === "service_tier_change");
		expect(tierEntries).toHaveLength(1);
	});

	it("rebuilds the system prompt when prompt-affecting settings change", async () => {
		const settings = Settings.isolated();
		const live = await start(settings);
		expect(live.systemPrompt.join("\n")).not.toContain("live-settings-tree-marker/");

		cfgIncludeWorkspaceTree.set(settings, true);
		// The watch queues its rebuild on the next microtask; an explicit refresh
		// serializes behind it on the tool-registry mutation queue.
		await Promise.resolve();
		await live.refreshBaseSystemPrompt();
		expect(live.systemPrompt.join("\n")).toContain("live-settings-tree-marker/");

		const beforePersonality = live.systemPrompt.join("\n");
		cfgPersonality.set(settings, "none");
		await Promise.resolve();
		await live.refreshBaseSystemPrompt();
		expect(live.systemPrompt.join("\n")).not.toBe(beforePersonality);
	});

	it("rebuilds the system prompt once for a bulk change across several prompt inputs", async () => {
		const settings = Settings.isolated();
		let builds = 0;
		const live = await start(settings, {
			systemPrompt: defaultPrompt => {
				builds++;
				return defaultPrompt;
			},
		});
		// Let startup-queued rebuilds drain before counting.
		await live.runToolRegistryMutation(async () => {});
		const before = live.systemPrompt.join("\n");
		builds = 0;

		cfgPersonality.set(settings, "none");
		cfgIncludeWorkspaceTree.set(settings, true);
		cfgTtsrEnabled.set(settings, false);
		cfgToolsFormat.set(settings, "glm");
		await Promise.resolve();
		await live.runToolRegistryMutation(async () => {});

		expect(builds).toBe(1);
		expect(live.systemPrompt.join("\n")).not.toBe(before);
		expect(live.systemPrompt.join("\n")).toContain("live-settings-tree-marker/");
	});

	it("restores compaction preferences only in the transcript that owns them", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-compaction-"));
		tempDirs.push(cwd);
		const dir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, dir);
		const settings = Settings.isolated();
		cfgCompactionThresholdPercent.set(settings, 20);
		const normalOrder = cfgCompactionMethodOrder.get(settings);
		const live = await start(settings, { sessionManager: manager });
		const first = live.sessionId;
		const file = live.sessionFile!;
		live.setSessionCompactionSettings(first, {
			"compaction.thresholdPercent": -1,
			"compaction.methodOrder": ["shake", "soft"],
			"compaction.enabled": false,
		});
		expect(cfgCompactionThresholdPercent.get(settings)).toBe(-1);
		expect(settings.getProvenanceDetails(cfgCompactionThresholdPercent).globalValue).toBe(20);
		await manager.ensureOnDisk();

		expect(await live.newSession()).toBe(true);
		expect(cfgCompactionThresholdPercent.get(settings)).toBe(20);
		expect(cfgCompactionMethodOrder.get(settings)).toEqual(normalOrder);
		expect(() => live.setSessionCompactionSettings(first, { "compaction.thresholdPercent": 80 })).toThrow();
		expect(await live.switchSession(file, { keepModel: true })).toBe(true);
		expect(cfgCompactionThresholdPercent.get(settings)).toBe(-1);

		await live.dispose();
		session = undefined;
		const reopenedSettings = Settings.isolated();
		await start(reopenedSettings, { sessionManager: await SessionManager.open(file, dir) });
		expect(cfgCompactionThresholdPercent.get(reopenedSettings)).toBe(-1);
		expect(cfgCompactionMethodOrder.get(reopenedSettings)).toEqual(["shake", "soft"]);
		expect(cfgCompactionEnabled.get(reopenedSettings)).toBe(false);
	});
});
