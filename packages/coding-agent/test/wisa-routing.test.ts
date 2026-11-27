import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry } from "../src/config/model-registry";
import { AuthStorage } from "../src/session/auth-storage";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { discoverModelsByProviderType, type DiscoveryProviderConfig } from "../src/config/model-discovery";
import { isWisaGateway, wisaModelApi } from "../src/config/wisa-routing";

const ids = ["claude-opus-4-6", "gpt-6-sol", "codex-mini", "o3", "gemini-4-argon", "grok-4.7", "capcuttts"];
const config: DiscoveryProviderConfig = {
	provider: "wisa",
	baseUrl: "https://api.askwisa.com/v1",
	api: "openai-completions",
	wisaDefaults: true,
	discovery: { type: "openai-models-list" },
};
const fetch: FetchImpl = async () => Response.json({ data: ids.map(id => ({ id })) });
const context = { fetch, getBearerApiKeyResolver: async () => undefined };

describe("Wisa client-facing API defaults", () => {
	test("discovers all families without changing wire model ids", async () => {
		const models = await discoverModelsByProviderType(config, context);
		expect(models.map(model => [model.id, model.api])).toEqual(ids.map(id => [id, wisaModelApi(id)]));
		expect(models.map(model => model.api)).toEqual([
			"anthropic-messages",
			"openai-responses",
			"openai-responses",
			"openai-responses",
			"openai-completions",
			"openai-completions",
			"openai-completions",
		]);
	});
	test("registry accepts absent provider API, preserves explicit model overrides, and refreshes new models", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wisa-routing-"));
		const auth = await AuthStorage.create(":memory:");
		try {
			const file = join(dir, "models.json");
			writeFileSync(
				file,
				JSON.stringify({
					providers: {
						wisa: {
							baseUrl: config.baseUrl,
							auth: "none",
							discovery: config.discovery,
							modelOverrides: { "claude-opus-4-6": { api: "openai-completions" } },
						},
					},
				}),
			);
			const registry = new ModelRegistry(auth, file, { fetch, cacheDbPath: join(dir, "cache.db") });
			await registry.refreshDiscoverableProviders(["wisa"], "online");
			const models = registry.getAll().filter(model => model.provider === "wisa");
			expect(models.find(model => model.id === "claude-opus-4-6")?.api).toBe("openai-completions");
			expect(models.find(model => model.id === "gpt-6-sol")?.api).toBe("openai-responses");
			expect(models.find(model => model.id === "gemini-4-argon")?.api).toBe("openai-completions");
			expect(models).toHaveLength(ids.length);
		} finally {
			auth.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("keeps the existing discovered roster across a family-policy change and failed refresh", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wisa-cache-policy-"));
		const auth = await AuthStorage.create(":memory:");
		try {
			const file = join(dir, "models.json");
			const cacheDbPath = join(dir, "cache.db");
			const cached = await discoverModelsByProviderType({ ...config, wisaDefaults: false }, context);
			expect(writeModelCache("wisa:openai-models-list-context-v7", Date.now(), cached, true, "", cacheDbPath)).toBe(
				"written",
			);
			for (const api of [undefined, "openai-completions"] as const) {
				writeFileSync(
					file,
					JSON.stringify({
						providers: {
							wisa: {
								baseUrl: config.baseUrl,
								auth: "none",
								discovery: config.discovery,
								api,
								modelOverrides: { "gpt-6-sol": { api: "anthropic-messages" } },
							},
						},
					}),
				);
				const registry = new ModelRegistry(auth, file, {
					cacheDbPath,
					fetch: async () => {
						throw new Error("fixture discovery unavailable");
					},
				});
				const assertRoster = () => {
					const models = registry.getAll().filter(model => model.provider === "wisa");
					expect(models).toHaveLength(ids.length);
					expect(models.find(model => model.id === "claude-opus-4-6")?.api).toBe(api ?? "anthropic-messages");
					expect(models.find(model => model.id === "gpt-6-sol")?.api).toBe("anthropic-messages");
				};
				assertRoster();
				await registry.refreshDiscoverableProviders(["wisa"], "online");
				assertRoster();
				expect(registry.getProviderDiscoveryState("wisa")).toMatchObject({
					status: "cached",
					stale: true,
					error: "fixture discovery unavailable",
				});
			}
		} finally {
			auth.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("preserves an explicit provider API", async () => {
		const models = await discoverModelsByProviderType({ ...config, wisaDefaults: false }, context);
		expect(models.every(model => model.api === "openai-completions")).toBe(true);
	});
	test("never applies family routing to another provider or endpoint", async () => {
		for (const patch of [{ provider: "other" }, { baseUrl: "https://other.invalid/v1" }]) {
			const models = await discoverModelsByProviderType({ ...config, ...patch }, context);
			expect(models.every(model => model.api === "openai-completions")).toBe(true);
		}
		expect(isWisaGateway("wisa", "https://api.askwisa.com.evil.test/v1")).toBe(false);
	});
});
