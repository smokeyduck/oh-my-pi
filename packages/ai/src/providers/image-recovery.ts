import { isRecord } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { AssistantMessage, Context, ImageContent, Message, Model, TextContent } from "../types";
import { sendsImageInputOnWire } from "./vision-guard";

export const UNSUPPORTED_IMAGE_NOTE = "[image omitted: the active model does not support image input]";
export const REJECTED_IMAGE_NOTE = "[image omitted: the provider rejected the image input or format]";

/** Copy only changed blocks; the original history and opaque non-image replay items stay intact. */
function mapChanged<T>(items: T[], replace: (item: T) => T): T[] {
	let copy: T[] | undefined;
	for (let index = 0; index < items.length; index++) {
		const original = items[index];
		const replacement = replace(original);
		if (replacement !== original) {
			copy ??= items.slice();
			copy[index] = replacement;
		}
	}
	return copy ?? items;
}

function isResponsesImagePart(part: unknown): boolean {
	return isRecord(part) && part.type === "input_image";
}

function hasResponsesInputImage(item: Record<string, unknown>): boolean {
	return (
		item.type === "input_image" ||
		(item.type === "computer_call_output" && isRecord(item.output) && item.output.type === "computer_screenshot") ||
		(Array.isArray(item.content) && item.content.some(isResponsesImagePart)) ||
		(Array.isArray(item.output) && item.output.some(isResponsesImagePart))
	);
}

/** Cheap check for streaming requests, avoiding an event proxy on text-only turns. */
export function contextHasInputImages(context: Context): boolean {
	return context.messages.some(message => {
		if (message.role === "toolResult" && message.providerMetadata?.type === "computer") return true;
		if (
			message.role !== "assistant" &&
			Array.isArray(message.content) &&
			message.content.some(part => part.type === "image")
		) {
			return true;
		}
		return (
			message.role !== "toolResult" &&
			message.providerPayload?.type === "openaiResponsesHistory" &&
			message.providerPayload.items.some(hasResponsesInputImage)
		);
	});
}

/** Rewrite Responses-native replay without losing its tool call IDs or compaction items. */
export function replaceResponsesInputImages(
	items: Array<Record<string, unknown>>,
	placeholder: string,
): Array<Record<string, unknown>> {
	const text = { type: "input_text", text: placeholder };
	const replacePart = (part: unknown): unknown => (isResponsesImagePart(part) ? text : part);
	return mapChanged(items, item => {
		if (item.type === "input_image") return text;
		if (item.type === "computer_call_output" && isRecord(item.output) && item.output.type === "computer_screenshot") {
			const rewritten = { ...item };
			delete rewritten.output;
			return { ...rewritten, error: placeholder };
		}
		if (Array.isArray(item.content)) {
			const content = mapChanged(item.content, replacePart);
			if (content !== item.content) return { ...item, content };
		}
		if (Array.isArray(item.output)) {
			const output = mapChanged(item.output, replacePart);
			if (output !== item.output) return { ...item, output };
		}
		return item;
	});
}

function replaceContent(content: (TextContent | ImageContent)[], placeholder: string): (TextContent | ImageContent)[] {
	const firstImage = content.findIndex(part => part.type === "image");
	if (firstImage === -1) return content;
	const replaced = content.slice(0, firstImage);
	for (let i = firstImage; i < content.length; i++) {
		const part = content[i];
		if (part.type !== "image") {
			replaced.push(part);
		} else {
			const previous = replaced[replaced.length - 1];
			if (previous?.type !== "text" || previous.text !== placeholder) {
				replaced.push({ type: "text", text: placeholder });
			}
		}
	}
	return replaced;
}

/** Replace input images in both generic messages and provider-native replay, never in the transcript. */
export function replaceLlmImagesWithText(messages: Message[], placeholder: string): Message[] {
	return mapChanged(messages, message => {
		if (message.role === "toolResult") {
			let content = replaceContent(message.content, placeholder);
			const computer = message.providerMetadata?.type === "computer";
			if (computer && content === message.content) {
				content = [...content, { type: "text", text: placeholder }];
			}
			return content !== message.content
				? { ...message, content, providerMetadata: computer ? undefined : message.providerMetadata }
				: message;
		}
		const payload = message.providerPayload;
		let providerPayload = payload;
		if (payload?.type === "openaiResponsesHistory") {
			const items = replaceResponsesInputImages(payload.items, placeholder);
			if (items !== payload.items) providerPayload = { ...payload, items };
		}
		if (message.role === "assistant") {
			// Generic assistant images are outputs, not replayed inputs.
			return providerPayload === payload ? message : { ...message, providerPayload };
		}
		let content = Array.isArray(message.content) ? replaceContent(message.content, placeholder) : message.content;
		if (content === message.content && providerPayload !== payload) {
			// Other transports read the generic view of a native-only image.
			if (typeof content === "string") content = content ? `${content}\n${placeholder}` : placeholder;
			else content = [...content, { type: "text", text: placeholder }];
		}
		return content === message.content && providerPayload === payload
			? message
			: { ...message, content, providerPayload };
	});
}

export function replaceContextImages(context: Context, placeholder: string): Context {
	const messages = replaceLlmImagesWithText(context.messages, placeholder);
	return messages === context.messages ? context : { ...context, messages };
}

export function omitUnsupportedContextImages(context: Context, model: Model): Context {
	return sendsImageInputOnWire(model) ? context : replaceContextImages(context, UNSUPPORTED_IMAGE_NOTE);
}

// Match rejection evidence, not a generic invalid request or HTTP Content-Type error.
const IMAGE_REJECTION_CODE =
	/\b(?:invalid_image(?:_(?:format|url|data))?|unsupported_image(?:_(?:format|media_type|type))?|image_parse_error|invalid_base64_image)\b/i;
const IMAGE_FIELD = /\b(?:image_url|input_image)\b/i;
const REJECTION =
	/\b(?:unsupported|invalid|unknown|unrecognized|not (?:supported|allowed|permitted|accepted)|only supported|unexpected|incompatible|must be)\b/i;
const IMAGE_REJECTION =
	/\b(?:unsupported|invalid|unknown|unrecognized) (?:base64 |input )?(?:images?|vision input)\b|\b(?:does(?: not|n't) support|failed to (?:decode|read|process)|cannot (?:decode|read|process)|could not (?:decode|read|process)) (?:\w+ ){0,2}(?:images?|vision input)\b|\b(?:images?|vision input)(?: (?:input|modality|format|type|data))? (?:is |are )?(?:not (?:supported|allowed|permitted|accepted)|unsupported|invalid)\b/i;
const MEDIA_FORMAT_REJECTION =
	/\b(?:unsupported|invalid|unrecognized) (?:input )?media[_ ]format\b|\b(?:input )?media[_ ]format\b[^\n.]{0,60}\b(?:not supported|unsupported|invalid)\b/i;
const IMAGE_MIME_REJECTION =
	/\b(?:invalid|unsupported|unknown) (?:input )?(?:MIME|media|content)[_ ]type\b[^\n.]{0,60}\bimage\//i;
const TEXT_ONLY =
	/\b(?:only (?:supports?|accepts?) text(?: input)?|(?:supports?|accepts?) (?:text(?: input)? only|only text(?: input)?)|not a multimodal model)\b/i;

/** Check only request-validation failures, even on transports that omit the HTTP status. */
export function isImageInputRejection(error: unknown): boolean {
	const assistant = isRecord(error) && error.role === "assistant" ? (error as unknown as AssistantMessage) : undefined;
	if (assistant && (assistant.stopReason !== "error" || assistant.content.length !== 0)) return false;
	const id = assistant?.errorId;
	const status = AIError.status(error) ?? (id !== undefined && id >= 100 && id <= 599 ? id : undefined);
	if (status !== undefined && status !== 400 && status !== 415 && status !== 422) return false;
	// Native compaction wraps the transport failure in a generic HTTP error.
	const cause = error instanceof AIError.ProviderHttpError ? error.cause : undefined;
	const detail = cause instanceof AIError.OpenAIHttpError ? cause : error;
	const message = assistant
		? (assistant.errorClassificationMessage ?? assistant.errorMessage)
		: detail instanceof Error
			? detail.message
			: "";
	const code = detail instanceof AIError.ProviderHttpError ? detail.code : undefined;
	const imageRejected =
		(code && IMAGE_REJECTION_CODE.test(code)) ||
		(message &&
			(IMAGE_REJECTION_CODE.test(message) ||
				IMAGE_REJECTION.test(message) ||
				MEDIA_FORMAT_REJECTION.test(message) ||
				IMAGE_MIME_REJECTION.test(message) ||
				TEXT_ONLY.test(message) ||
				(IMAGE_FIELD.test(message) && REJECTION.test(message))));
	if (!imageRejected) return false;
	const classification = id ?? AIError.classify(assistant ? new Error(message) : detail);
	return !(
		AIError.is(classification, AIError.Flag.AuthFailed) ||
		AIError.is(classification, AIError.Flag.AccountPolicy) ||
		AIError.is(classification, AIError.Flag.ContentBlocked) ||
		AIError.is(classification, AIError.Flag.ContextOverflow) ||
		AIError.is(classification, AIError.Flag.UsageLimit) ||
		AIError.is(classification, AIError.Flag.Abort)
	);
}

/** A single retry for a one-shot completion, only when its outbound context can actually change. */
export async function completeWithImageRejectionFallback(
	context: Context,
	signal: AbortSignal | undefined,
	send: (context: Context) => Promise<AssistantMessage>,
): Promise<AssistantMessage> {
	let response: AssistantMessage;
	try {
		response = await send(context);
	} catch (error) {
		if (signal?.aborted || !isImageInputRejection(error)) throw error;
		const fallback = replaceContextImages(context, REJECTED_IMAGE_NOTE);
		if (fallback === context) throw error;
		return send(fallback);
	}
	if (signal?.aborted || !isImageInputRejection(response)) return response;
	const fallback = replaceContextImages(context, REJECTED_IMAGE_NOTE);
	return fallback === context ? response : send(fallback);
}
