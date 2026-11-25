import type { ExtensionUIContext } from "../../extensibility/extensions";
import type { AgentSession } from "../../session/agent-session";
import { OmfgController } from "../controllers/omfg-controller";

export interface RpcOmfgResult {
	state: "saved" | "rejected" | "aborted";
	savedPath?: string;
}

/** Run the existing TTSR-rule workflow over RPC-hosted select/input/confirm dialogs. */
export async function runRpcOmfg(
	session: AgentSession,
	ui: ExtensionUIContext,
	complaint: string,
): Promise<RpcOmfgResult> {
	let diagnostic = "Unable to create TTSR rule.";
	const context: ConstructorParameters<typeof OmfgController>[0] = {
		session,
		sessionManager: session.sessionManager,
		settings: session.settings,
		showStatus: (message: string) => {
			diagnostic = message;
		},
		showError: (message: string) => {
			diagnostic = message;
		},
		showHookConfirm: (title: string, message: string) => ui.confirm(title, message),
		showHookSelector: (title: string, options: string[]) => ui.select(title, options),
		showHookInput: (title: string, placeholder?: string) => ui.input(title, placeholder),
	};
	const result = await new OmfgController(context).startAndWait(complaint);
	if (!result) throw new Error(diagnostic);
	if (result.state === "error") throw new Error(result.errorMessage ?? diagnostic);
	if (result.state === "saved") return result;
	if (result.state === "rejected") return { state: "rejected" };
	if (result.state === "aborted") return { state: "aborted" };
	throw new Error(`Unexpected /omfg terminal state: ${result.state}`);
}
