import { afterEach, describe, expect, it, vi } from "bun:test";
import { REJECTED_IMAGE_NOTE, UNSUPPORTED_IMAGE_NOTE } from "@oh-my-pi/pi-ai/providers/image-recovery";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function sseDone(): Response {
	const chunk = {
		id: "gen-1",
		object: "chat.completion.chunk",
		created: 0,
		model: "deepseek-v4-flash",
		choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("session image recovery", () => {
	const sessions: Array<{ dispose(): Promise<void> }> = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		vi.restoreAllMocks();
	});

	it.each([
		["declared image input that the wire strips", true],
		["a provider media-format rejection", false],
	] as const)("keeps prompting after %s", async (_case, knownTextOnly) => {
		using tempDir = TempDir.createSync("@pi-wire-stripped-images-");
		// Declares image input; `compat.stripImageInput` drops images on the wire.
		const model = knownTextOnly
			? getBundledModel("fireworks", "deepseek-v4-flash")
			: buildModel({
					id: "sdk-image-recovery",
					name: "SDK image recovery test model",
					api: "openai-completions",
					provider: "fireworks",
					baseUrl: "https://provider.example.test/v1",
					reasoning: false,
					input: ["text", "image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 4096,
				});
		const bodies: string[] = [];
		const fetchStub = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit | BunFetchRequestInit) => {
				const body = String(init?.body ?? "");
				bodies.push(body);
				if (!knownTextOnly && body.includes(PNG_1X1)) {
					return Response.json({ error: { message: "Unsupported media format" } }, { status: 400 });
				}
				return sseDone();
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		const sessionManager = SessionManager.inMemory(tempDir.path());
		sessionManager.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "earlier screenshot" },
				{ type: "image", data: PNG_1X1, mimeType: "image/png" },
			],
			timestamp: Date.now(),
		});
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime(model.provider, "test-key");
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			taskDepth: 1,
			agentId: "SubAgent",
		});
		sessions.push(session);

		await session.sendUserMessage("next");

		const requests = bodies.filter(body => body.includes("earlier screenshot"));
		expect(requests).toHaveLength(knownTextOnly ? 1 : 2);
		if (!knownTextOnly) expect(requests[0]).toContain(PNG_1X1);
		// The session's own text replacement ran, not the wire's last-resort strip.
		const request = requests.at(-1);
		expect(request).toContain(knownTextOnly ? UNSUPPORTED_IMAGE_NOTE : REJECTED_IMAGE_NOTE);
		expect(request).not.toContain(PNG_1X1);
		expect(JSON.stringify(sessionManager.buildSessionContext().messages)).toContain(PNG_1X1);
		expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});
});
