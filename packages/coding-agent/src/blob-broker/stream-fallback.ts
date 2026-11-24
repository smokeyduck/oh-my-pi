/**
 * Transparent provider-file to URL to inline recovery for image requests.
 * Retries are allowed only before the provider emits content, keeping the
 * consumer-facing stream single and ordered.
 */

import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessageEvent, Context } from "@oh-my-pi/pi-ai";
import {
	contextHasInputImages,
	isImageInputRejection,
	REJECTED_IMAGE_NOTE,
	replaceContextImages,
} from "@oh-my-pi/pi-ai/providers/image-recovery";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { logger } from "@oh-my-pi/pi-utils";
import { clampProviderContextImageBytes } from "../session/provider-image-budget";
import { contextHasImageUrls, contextHasProviderFiles } from "./context-images";
import type { ImageUrlService } from "./service";

type ImageSource = "provider-file" | "url" | "inline";

function imageSource(context: Context): ImageSource {
	if (contextHasProviderFiles(context)) return "provider-file";
	return contextHasImageUrls(context) ? "url" : "inline";
}

/**
 * Wrap `base` with provider-file then URL then inline recovery. `resolveBroker`
 * is consulted per request so live settings changes swap the service.
 */
export function wrapStreamFnWithBlobUrlFallback(
	base: StreamFn,
	resolveBroker: () => ImageUrlService | undefined,
): StreamFn {
	return (model, context, options) => {
		if (!contextHasProviderFiles(context) && !contextHasImageUrls(context)) return base(model, context, options);
		const broker = resolveBroker();
		if (!broker) return base(model, context, options);

		const outer = new AssistantMessageEventStream();
		let sawStart = false;

		const run = async (): Promise<void> => {
			let attemptContext = context;
			let failedSourceAwaitingProof: ImageSource | undefined;
			for (;;) {
				const source = imageSource(attemptContext);
				const inner = await base(model, attemptContext, options);
				let sawAttemptContent = false;
				let retry = false;
				let succeeded = false;
				for await (const event of inner) {
					if (event.type === "start") {
						if (!sawStart) {
							sawStart = true;
							outer.push(event);
						}
						continue;
					}
					if (event.type === "error" && !sawAttemptContent && event.error.stopReason === "error") {
						const fallback = clampProviderContextImageBytes(
							await broker.fallbackContext(attemptContext, model),
							model,
						);
						const fallbackSource = imageSource(fallback);
						if (source !== "inline" && fallbackSource !== source) {
							logger.warn("blob-broker: provider rejected image source; retrying with fallback", {
								provider: model.provider,
								model: model.id,
								source,
								fallback: fallbackSource,
								error: event.error.errorMessage?.slice(0, 200),
							});
							attemptContext = fallback;
							failedSourceAwaitingProof = source;
							retry = true;
							break;
						}
					}
					if (event.type === "done") succeeded = true;
					else if (event.type !== "error") sawAttemptContent = true;
					outer.push(event);
				}
				if (retry) continue;
				if (succeeded && failedSourceAwaitingProof === "url") {
					broker.quarantine(model.provider, "request failed with image URLs but succeeded with inline data");
				}
				return;
			}
		};

		void run().catch(error => {
			if (!outer.done) outer.fail(error);
		});
		return outer;
	};
}

/** Recover a rejected live request once, after any broker source fallback. */
export function wrapStreamFnWithImageRejectionFallback(base: StreamFn): StreamFn {
	return (model, context, options) => {
		if (options?.signal?.aborted || !contextHasInputImages(context)) return base(model, context, options);

		const outer = new AssistantMessageEventStream();
		const run = async (): Promise<void> => {
			let start: Extract<AssistantMessageEvent, { type: "start" }> | undefined;
			let emittedContent = false;
			const pump = async (request: Context, allowFallback: boolean): Promise<boolean> => {
				const inner = await base(model, request, options);
				outer.forwardLocalWorkFrom(inner);
				for await (const event of inner) {
					if (event.type === "start" && !emittedContent && event.partial.content.length === 0) {
						start = event;
						continue;
					}
					if (
						allowFallback &&
						!emittedContent &&
						!options?.signal?.aborted &&
						event.type === "error" &&
						isImageInputRejection(event.error)
					) {
						return true;
					}
					if (start) {
						outer.push(start);
						start = undefined;
					}
					emittedContent = true;
					outer.push(event);
				}
				if (!outer.done) {
					const result = await inner.result();
					if (allowFallback && !emittedContent && !options?.signal?.aborted && isImageInputRejection(result)) {
						return true;
					}
					if (start) outer.push(start);
					outer.end(result);
				}
				return false;
			};

			try {
				if (!(await pump(context, true))) return;
			} catch (error) {
				if (emittedContent || options?.signal?.aborted || !isImageInputRejection(error)) throw error;
			}
			start = undefined;
			await pump(replaceContextImages(context, REJECTED_IMAGE_NOTE), false);
		};
		void run()
			.catch(error => outer.fail(error))
			.finally(() => outer.forwardLocalWorkFrom(undefined));
		return outer;
	};
}
