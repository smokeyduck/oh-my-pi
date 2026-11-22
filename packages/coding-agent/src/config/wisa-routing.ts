import type { Api } from "@oh-my-pi/pi-ai/types";
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";

/** Wisa's three client-facing protocols; upstream transport may be translated. */
export function isWisaGateway(provider: string, baseUrl: string | undefined): boolean {
	if (provider !== "wisa" || !baseUrl) return false;
	try {
		const url = new URL(baseUrl);
		return (
			url.origin === "https://api.askwisa.com" &&
			url.pathname.replace(/\/$/, "") === "/v1" &&
			!url.search &&
			!url.hash
		);
	} catch {
		return false;
	}
}

/** Explicit provider/model APIs take precedence; never apply to arbitrary gateways. */
export function wisaModelApi(id: string): Api {
	const identity = classifyModel("wisa", id, { lenient: true });
	if (identity.class === "anthropic") return "anthropic-messages";
	if (identity.class === "openai") return "openai-responses";
	return "openai-completions";
}
