import { expect, test } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { discoverModelsByProviderType } from "../src/config/model-discovery";

const tool = {
	name: "lookup",
	description: "Look up a value",
	parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
};
const cases = [
	{
		id: "claude-opus-4-6",
		path: "/v1/messages",
		frames: [
			{
				type: "message_start",
				message: {
					id: "m1",
					type: "message",
					role: "assistant",
					model: "claude-opus-4-6",
					content: [],
					stop_reason: null,
					usage: { input_tokens: 2, output_tokens: 0 },
				},
			},
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Consider the key" } },
			{ type: "content_block_stop", index: 0 },
			{
				type: "content_block_start",
				index: 1,
				content_block: { type: "tool_use", id: "call_1", name: "lookup", input: {} },
			},
			{
				type: "content_block_delta",
				index: 1,
				delta: { type: "input_json_delta", partial_json: '{"key":"value"}' },
			},
			{ type: "content_block_stop", index: 1 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
			{ type: "message_stop" },
		],
	},
	{
		id: "gpt-6-sol",
		path: "/v1/responses",
		frames: [
			{ type: "response.created", response: { id: "r1", status: "in_progress" } },
			{ type: "response.output_item.added", output_index: 0, item: { id: "rs1", type: "reasoning", summary: [] } },
			{
				type: "response.reasoning_summary_part.added",
				output_index: 0,
				item_id: "rs1",
				summary_index: 0,
				part: { type: "summary_text", text: "" },
			},
			{
				type: "response.reasoning_summary_text.delta",
				output_index: 0,
				item_id: "rs1",
				summary_index: 0,
				delta: "Consider the key",
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { id: "rs1", type: "reasoning", summary: [{ type: "summary_text", text: "Consider the key" }] },
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { id: "fc1", type: "function_call", call_id: "call_1", name: "lookup", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc1", delta: '{"key":"value"}' },
			{
				type: "response.output_item.done",
				output_index: 1,
				item: { id: "fc1", type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"key":"value"}' },
			},
			{
				type: "response.completed",
				response: { id: "r1", status: "completed", usage: { input_tokens: 2, output_tokens: 5, total_tokens: 7 } },
			},
		],
	},
	{
		id: "grok-4.7",
		path: "/v1/chat/completions",
		frames: [
			{
				id: "c1",
				choices: [
					{ index: 0, delta: { role: "assistant", reasoning_content: "Consider the key" }, finish_reason: null },
				],
			},
			{
				id: "c1",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "lookup", arguments: '{"key":"value"}' },
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "c1",
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
				usage: { prompt_tokens: 2, completion_tokens: 5, total_tokens: 7 },
			},
		],
	},
];

for (const fixture of cases)
	test(`Wisa ${fixture.id} sends ${fixture.path} and streams thinking/tool calls`, async () => {
		const [model] = await discoverModelsByProviderType(
			{
				provider: "wisa",
				baseUrl: "https://api.askwisa.com/v1",
				api: "openai-completions",
				wisaDefaults: true,
				discovery: { type: "openai-models-list" },
			},
			{
				fetch: async () => Response.json({ data: [{ id: fixture.id }] }),
				getBearerApiKeyResolver: async () => undefined,
			},
		);
		let requestUrl = "";
		let payload: Record<string, unknown> = {};
		const fetch: FetchImpl = async (input, init) => {
			requestUrl = String(input);
			payload = JSON.parse(String(init?.body));
			return new Response(
				fixture.frames
					.map(frame => `event: ${"type" in frame ? frame.type : "message"}\ndata: ${JSON.stringify(frame)}\n\n`)
					.join(""),
				{ headers: { "content-type": "text/event-stream" } },
			);
		};
		const stream = streamSimple(
			model,
			{ messages: [{ role: "user", content: "Find the key", timestamp: 0 }], tools: [tool] },
			{ apiKey: "fixture-not-a-credential", fetch, reasoning: Effort.High },
		);
		const result = await stream.result();
		expect(requestUrl).toBe(`https://api.askwisa.com${fixture.path}`);
		expect(payload.model).toBe(fixture.id);
		expect(payload.stream).toBe(true);
		expect(payload.tools).toHaveLength(1);
		expect(result.errorMessage).toBeUndefined();
		expect(
			result.content.some(block => block.type === "thinking" && block.thinking.includes("Consider the key")),
		).toBe(true);
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "toolCall", name: "lookup", arguments: { key: "value" } }),
		);
	});
