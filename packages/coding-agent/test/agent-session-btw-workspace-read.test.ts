import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { runBtwTurn } from "@oh-my-pi/pi-coding-agent/session/btw-turn";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function call(name: string, path: string) {
	return { type: "toolCall" as const, name, arguments: { path } };
}

const read = "read_workspace_file";

test("grounds an isolated side answer in workspace text while rejecting write calls and out-of-scope paths", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "omp-btw-"));
	const authStorage = await AuthStorage.create(":memory:");
	const content = "The project reference is fig-827.";
	const linked = process.platform !== "win32";
	const mock = createMockModel({
		responses: [
			({ messages, tools, inactiveTools }) => {
				expect(tools?.map(tool => tool.name)).toEqual([read]);
				expect(inactiveTools).toBeUndefined();
				expect(JSON.stringify(messages)).toContain("The workspace fact changed after we last checked.");
				return {
					content: [
						"I haven't checked the file yet.",
						call(read, "reference.md"),
						call("write", "reference.md"),
						call(read, "../outside.md"),
						call(read, ".env"),
						...(linked ? [call(read, "link.md")] : []),
					],
				};
			},
			({ messages }) => {
				const results = messages.filter(message => message.role === "toolResult");
				expect(results.map(result => result.isError)).toEqual(
					linked ? [false, true, true, true, true] : [false, true, true, true],
				);
				expect(results[0]?.content[0]).toMatchObject({ text: expect.stringContaining(content) });
				expect(JSON.stringify(results)).not.toContain("private env content");
				return { content: ["fig-827 (reference.md)"] };
			},
		],
	});
	const session = new AgentSession({
		agent: new Agent({ initialState: { model: mock }, convertToLlm }),
		sessionManager: SessionManager.inMemory(cwd),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage),
		sideStreamFn: mock.stream,
	});
	try {
		await writeFile(join(cwd, "reference.md"), content);
		await writeFile(join(cwd, ".env"), "private env content");
		if (linked) await symlink(".env", join(cwd, "link.md"));
		const mainMessage = {
			role: "user" as const,
			content: "The workspace fact changed after we last checked.",
			timestamp: 1,
		};
		session.agent.replaceMessages([mainMessage]);
		const deltas: string[] = [];
		const result = await runBtwTurn(session, {
			question: "What is the new project reference?",
			workspaceRead: true,
			conversationKey: "one",
			onTextDelta: delta => {
				deltas.push(delta);
			},
			signal: new AbortController().signal,
		});
		expect(result.replyText).toBe("fig-827 (reference.md)");
		expect(deltas.join("")).toBe(result.replyText);
		expect(session.messages).toEqual([mainMessage]);
	} finally {
		await session.dispose();
		authStorage.close();
		await rm(cwd, { recursive: true, force: true });
	}
});
