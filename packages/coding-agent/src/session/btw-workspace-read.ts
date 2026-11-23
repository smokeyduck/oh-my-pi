import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { Tool, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";

const MAX_BYTES = 16 * 1024;
export const MAX_BTW_READ_CALLS = 6;

const parameters = type({
	path: type("string").describe("Workspace-relative path to a UTF-8 text file, using / separators."),
	"offset?": type("number.integer >= 0").describe("Start at this byte offset (default 0)."),
	"+": "reject",
});

export const btwWorkspaceReadTool: Tool<typeof parameters> = {
	name: "read_workspace_file",
	description:
		"Read up to 16 KiB of a regular UTF-8 file in this workspace. No hidden paths, links, URLs, commands or mutations. Cite paths when using this evidence.",
	parameters,
};

function validComponent(component: string): boolean {
	return (
		component.length > 0 &&
		!component.startsWith(".") &&
		!/[\x00-\x1f<>:"|?*\\]/.test(component) &&
		!/[ .]$/.test(component) &&
		!/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(component)
	);
}

async function readWorkspaceText(
	root: string,
	requestedPath: string,
	offset: number,
	signal: AbortSignal,
): Promise<string> {
	const components = requestedPath.split("/");
	if (!components.every(validComponent) || !Number.isSafeInteger(offset)) {
		throw new Error("Use a workspace-relative file path and a valid byte offset.");
	}
	let target = root;
	for (let i = 0; i < components.length; i++) {
		target = path.join(target, components[i]!);
		const entry = await lstat(target);
		if (i === components.length - 1 ? !entry.isFile() || entry.nlink !== 1 : !entry.isDirectory()) {
			throw new Error("Only regular workspace files are allowed; links and special files are not supported.");
		}
	}
	signal.throwIfAborted();
	const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		// Check the open descriptor against the canonical path before reading. This is a workspace
		// scope check, not a sandbox against a local process concurrently rewriting the workspace.
		const [actual, descriptor, current] = await Promise.all([realpath(target), file.stat(), lstat(target)]);
		if (
			path.relative(target, actual) !== "" ||
			!descriptor.isFile() ||
			descriptor.nlink !== 1 ||
			!current.isFile() ||
			descriptor.dev !== current.dev ||
			descriptor.ino !== current.ino
		) {
			throw new Error("The file changed or resolves outside its workspace path.");
		}
		if (offset > descriptor.size) throw new Error("The requested offset is past the end of the file.");
		const buffer = Buffer.allocUnsafe(Math.min(MAX_BYTES, descriptor.size - offset));
		signal.throwIfAborted();
		const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
		signal.throwIfAborted();
		const bytes = buffer.subarray(0, bytesRead);
		if (bytes.includes(0)) throw new Error("Binary files are not supported.");
		// Do not split the last character of a page. The next offset starts on that character.
		let end = bytes.length;
		if (offset + end < descriptor.size && end > 0) {
			let lead = end - 1;
			while (lead > 0 && (bytes[lead]! & 0xc0) === 0x80) lead--;
			const first = bytes[lead]!;
			const width = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
			if (lead + width > end) end = lead;
		}
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
		const next = offset + end;
		return `${requestedPath} (bytes ${offset}–${next} of ${descriptor.size})\n${text}${next < descriptor.size ? `\n[Continue with offset ${next}.]` : ""}`;
	} finally {
		await file.close();
	}
}

export async function runBtwWorkspaceRead(
	root: string,
	call: ToolCall,
	signal: AbortSignal,
): Promise<ToolResultMessage> {
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [],
		isError: false,
		timestamp: Date.now(),
	};
	let text: string;
	try {
		if (call.name !== btwWorkspaceReadTool.name)
			throw new Error("Only read_workspace_file is available in this side question.");
		const args = parameters(call.arguments);
		if (args instanceof type.errors)
			throw new Error("Expected a workspace-relative path and an optional non-negative byte offset.");
		try {
			text = await readWorkspaceText(root, args.path, args.offset ?? 0, signal);
		} catch (error) {
			signal.throwIfAborted();
			// Filesystem errors can contain private absolute paths.
			if (error instanceof TypeError || (error instanceof Error && "code" in error)) {
				throw new Error("Could not read this path as a UTF-8 workspace file.");
			}
			throw error;
		}
	} catch (error) {
		signal.throwIfAborted();
		result.isError = true;
		text = error instanceof Error ? error.message : "Workspace read failed.";
	}
	result.content.push({ type: "text", text });
	return result;
}
