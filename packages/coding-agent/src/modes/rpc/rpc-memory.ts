/**
 * Memory workbench RPC: a host reviews and edits one project's local memory.
 * Every mutation answers with the project's fresh overview so the host never
 * renders a half-applied state.
 */
import * as path from "node:path";
import { editMemoryList } from "../../memories";
import { editLocalKnowledgeNote, editProjectKnowledge } from "../../memories/project-knowledge";
import {
	eraseMemory,
	memoryScopeFor,
	readMemoryActivity,
	readMemoryOverview,
	setMemorySourceForgotten,
	startMemoryUpdate,
} from "../../memories/workbench";
import type { AgentSession } from "../../session/agent-session";
import type { RpcMemoryEdit, RpcMemoryEditResult, RpcMemoryOverview, RpcMemoryUpdateResult } from "./rpc-types";

/** Sessions changed within this many minutes are still being worked in; "update now" leaves them. */
const DEFAULT_UPDATE_IDLE_MINUTES = 10;

function scopeOf(session: AgentSession, cwd: string | undefined) {
	const target = cwd?.trim() ? cwd : session.sessionManager.getCwd();
	if (!path.isAbsolute(target)) throw new Error(`Memory project must be an absolute path: ${target}`);
	return memoryScopeFor(session.settings.getAgentDir(), target);
}

async function knowledgeSettingsFor(session: AgentSession, cwd: string) {
	const settings = session.settings;
	return cwd === settings.getCwd() ? settings : settings.cloneForCwd(cwd);
}

export async function buildRpcMemoryOverview(session: AgentSession, cwd?: string): Promise<RpcMemoryOverview> {
	const scope = scopeOf(session, cwd);
	return readMemoryOverview({
		agentDir: session.settings.getAgentDir(),
		settings: session.settings,
		knowledgeSettings: await knowledgeSettingsFor(session, scope.cwd),
		scope,
		session,
		modelRegistry: session.modelRegistry,
	});
}

export function buildRpcMemoryActivity(session: AgentSession, cwd?: string): Pick<RpcMemoryOverview, "activity"> {
	return { activity: readMemoryActivity(session.settings.getAgentDir(), scopeOf(session, cwd)) };
}

function startUpdate(session: AgentSession, cwd: string | undefined, minIdleMinutes: number): boolean {
	return startMemoryUpdate({
		session,
		settings: session.settings,
		modelRegistry: session.modelRegistry,
		agentDir: session.settings.getAgentDir(),
		scope: scopeOf(session, cwd),
		minIdleMinutes,
	});
}

/** Start reading the project's waiting sessions and rebuilding its knowledge. */
export async function applyRpcMemoryUpdate(
	session: AgentSession,
	cwd?: string,
	minIdleMinutes = DEFAULT_UPDATE_IDLE_MINUTES,
): Promise<RpcMemoryUpdateResult> {
	const started = startUpdate(session, cwd, minIdleMinutes);
	return { started, overview: await buildRpcMemoryOverview(session, cwd) };
}

export async function applyRpcMemoryEdit(
	session: AgentSession,
	edit: RpcMemoryEdit,
	cwd?: string,
): Promise<RpcMemoryEditResult> {
	const agentDir = session.settings.getAgentDir();
	const scope = scopeOf(session, cwd);
	let result: RpcMemoryEditResult["result"] = { ok: true };
	switch (edit.kind) {
		case "knowledge-source":
		case "knowledge-entry":
			result = await editProjectKnowledge(agentDir, scope.cwd, await knowledgeSettingsFor(session, scope.cwd), edit);
			break;
		case "note":
		case "lesson": {
			const kind = edit.kind === "note" ? "notes" : "lessons";
			if (edit.action === "add" && edit.kind !== "note") {
				throw new Error("Lessons are captured by the agent; only notes can be added.");
			}
			const write = () => editMemoryList(agentDir, scope.cwd, kind, edit);
			result = edit.kind === "note" ? await editLocalKnowledgeNote(agentDir, scope.cwd, write) : await write();
			break;
		}
		case "source": {
			setMemorySourceForgotten(agentDir, scope, edit.threadId, edit.action === "forget");
			// Forgetting rebuilds the knowledge without the session; restoring reads it again.
			startUpdate(session, scope.cwd, DEFAULT_UPDATE_IDLE_MINUTES);
			break;
		}
		case "erase": {
			await eraseMemory(agentDir, scope);
			break;
		}
	}
	return { result, overview: await buildRpcMemoryOverview(session, scope.cwd) };
}
