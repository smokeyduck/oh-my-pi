import * as path from "node:path";
import type { AgentSession } from "../../session/agent-session";
import { buildSessionContext, type SessionContext } from "../../session/session-context";
import type { SessionEntry, SessionHeader } from "../../session/session-entries";
import { findSessionFiles } from "../../session/session-listing";
import { loadEntriesFromFile, readSessionHeaderId } from "../../session/session-loader";
import {
	attachRpcTranscriptEntryIds,
	pageRpcMessages,
	RPC_MESSAGES_PAGE_STALE_ERROR,
	RpcMessagesPageError,
	type RpcMessagesPage,
} from "./rpc-messages";
import type { RpcCommand } from "./rpc-types";

const MAX_BOUNDARIES = 3;
const MAX_ROWS = 48;
type ArchiveQuery = NonNullable<Extract<RpcCommand, { type: "get_transcript_page" }>["archive"]>;
type ArchivePage = RpcMessagesPage & { hasOlder: boolean };

/** A legacy handoff starts a child session; current handoffs are compaction dividers in-place. */
function handoffParent(context: SessionContext, header: SessionHeader | undefined | null): string | undefined {
	if (!header?.parentSession) return undefined;
	const marked = context.messages.some(message => message.role === "custom" && message.customType === "handoff");
	return marked ? header.parentSession : undefined;
}

async function loadParent(reference: string, sessionFile: string | undefined) {
	const absolute = path.isAbsolute(reference) ? path.resolve(reference) : undefined;
	const id = absolute ? /_([\w-]+)\.jsonl$/.exec(path.basename(absolute))?.[1] : reference;
	if (!id || !/^[\w-]+$/.test(id)) return undefined;
	const suffix = `_${id}.jsonl`;
	const siblings = sessionFile
		? await Array.fromAsync(new Bun.Glob(`*${suffix}`).scan({ cwd: path.dirname(sessionFile), absolute: true }))
		: [];
	// The persisted reference is only a lookup key. Never open a path named
	// by an imported header unless a session directory actually lists it.
	const local = absolute ? siblings.filter(candidate => path.resolve(candidate) === absolute) : siblings;
	const files =
		local.length > 0
			? local
			: (await findSessionFiles(id)).filter(candidate =>
					absolute ? path.resolve(candidate) === absolute : candidate.endsWith(suffix),
				);
	if (files.length !== 1) return undefined;
	const file = files[0];
	if ((await readSessionHeaderId(file)) !== id) return undefined;
	const [header, ...entries] = await loadEntriesFromFile(file);
	if (header?.type !== "session" || header.id !== id) return undefined;
	return {
		file,
		header,
		context: buildSessionContext(entries as SessionEntry[], undefined, undefined, { transcript: true }),
	};
}

function dividers(context: SessionContext): number[] {
	const boundaries: number[] = [];
	for (const [index, message] of context.messages.entries()) {
		if (message.role === "compactionSummary") boundaries.push(index);
	}
	return boundaries;
}

function stale(): never {
	throw new RpcMessagesPageError(RPC_MESSAGES_PAGE_STALE_ERROR, "stale_cursor");
}

function archiveRows(
	context: SessionContext,
	start: number,
	end: number,
	hasOlder: boolean,
	target?: number,
): ArchivePage {
	const totalMessages = end - start;
	if (totalMessages === 0) return { messages: [], totalMessages, hasOlder };
	// Nearest rows within this boundary, or a window beginning at a search hit.
	const from = target ?? Math.max(start, end - MAX_ROWS);
	const until = Math.min(end, from + MAX_ROWS);
	const messages = attachRpcTranscriptEntryIds(
		context.messages.slice(from, until),
		context.messageEntryIds?.slice(from, until) ?? [],
	);
	// Spend the existing page byte budget starting with the row nearest the boundary.
	if (target === undefined) messages.reverse();
	const page = pageRpcMessages(
		messages,
		{ sessionId: "archive", leafId: null, messageCount: messages.length },
		{ strictByteLimit: true },
	);
	return { messages: target === undefined ? page.messages.reverse() : page.messages, totalMessages, hasOlder };
}

/** Read one bounded historical interval without switching, reopening or updating the active session. */
export async function pageRpcTranscriptArchive(session: AgentSession, query: ArchiveQuery): Promise<ArchivePage> {
	if (!Number.isInteger(query.depth) || query.depth < 0 || query.depth >= MAX_BOUNDARIES) {
		throw new Error("Invalid RPC transcript archive depth");
	}
	const id = session.sessionId;
	if (id !== query.sessionId) stale();
	const manager = session.sessionManager;
	const leaf = manager.getLeafId();
	let file = session.sessionFile;
	let context = session.buildTranscriptSessionContext();
	let boundaries = dividers(context);
	let parent = handoffParent(context, manager.getHeader());
	const latest = boundaries.at(-1);
	const marker =
		latest ??
		(parent
			? context.messages.findIndex(message => message.role === "custom" && message.customType === "handoff")
			: -1);
	if (marker < 0 || context.messageEntryIds?.[marker] !== query.boundaryId) stale();
	if (query.targetEntryId !== undefined) {
		const target = context.messageEntryIds?.indexOf(query.targetEntryId) ?? -1;
		const end = boundaries.find(index => index > target);
		return target >= 0 && end !== undefined
			? archiveRows(context, 0, end, false, target)
			: { messages: [], totalMessages: 0, hasOlder: false };
	}
	const seen = new Set([id]);
	let end = latest ?? 0;
	if (latest !== undefined) boundaries.pop();
	for (let depth = 0; depth <= query.depth; depth++) {
		if (end === 0 && parent) {
			const source = await loadParent(parent, file);
			if (
				id !== session.sessionId ||
				leaf !== manager.getLeafId() ||
				session.isStreaming ||
				session.isCompacting ||
				session.isBackgroundCompacting
			)
				stale();
			if (!source || seen.has(source.header.id)) break;
			seen.add(source.header.id);
			({ file, context } = source);
			boundaries = dividers(context);
			parent = handoffParent(context, source.header);
			end = context.messages.length;
		}
		if (end === 0) break;
		const start = boundaries.pop() ?? 0;
		if (depth === query.depth) {
			return archiveRows(context, start, end, depth + 1 < MAX_BOUNDARIES && (start > 0 || parent !== undefined));
		}
		end = start;
	}
	return { messages: [], totalMessages: 0, hasOlder: false };
}
