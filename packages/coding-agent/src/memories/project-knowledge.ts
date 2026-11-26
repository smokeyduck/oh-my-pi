import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import type { Settings } from "../config/settings";
import { cfgVaultEnabled } from "../tools/settings";
import { writeFileAtomically, writeFileAtomicallySync } from "../utils/atomic-file";
import type { MemoryListEditResult, MemoryListEntry } from "./index";
import { normalizeScopeCwd } from "./storage";

type EntryKind = "note" | "lesson";
type EntryEdit =
	| { action: "add"; entryKind: EntryKind; text: string }
	| { action: "update"; line: string; text: string }
	| { action: "delete"; line: string };

export type ProjectKnowledgeEdit =
	| { kind: "knowledge-source"; vault: string | null; previous: string | null }
	| ({ kind: "knowledge-entry"; vault: string } & EntryEdit);

export type ProjectKnowledge =
	| { source: "local"; vaultEnabled: boolean }
	| { source: "obsidian"; vault: string; status: "disabled" | "unavailable" }
	| { source: "obsidian"; vault: string; status: "ready"; notes: MemoryListEntry[]; lessons: MemoryListEntry[] };

const ENTRY_NAME = /^(note|lesson)-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.md$/;
const REVISION = /^[0-9a-f]{64}$/;
const MAX_ENTRY_BYTES = 64 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function digest(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function projectKey(cwd: string): string {
	return digest(normalizeScopeCwd(path.resolve(cwd)));
}

function bindingFile(agentDir: string, cwd: string): string {
	return path.join(agentDir, "knowledge-sources", `${projectKey(cwd)}.json`);
}

/** Only the source binding is stored locally; resetting operational Memory cannot delete it. */
async function readKnowledgeBinding(binding: string): Promise<string | null> {
	let raw: string;
	try {
		raw = await fs.readFile(binding, "utf8");
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
	const vault: unknown = JSON.parse(raw);
	if (typeof vault !== "string" || !path.isAbsolute(vault)) throw new Error("Invalid project knowledge vault binding.");
	return vault;
}

// Reject link/junction aliases, even inside the vault: another project or an arbitrary file
// must never become a write target. The root itself is canonicalized once at selection time.
async function requireDirectory(directory: string): Promise<void> {
	const stat = await fs.lstat(directory);
	if (!stat.isDirectory() || normalizeScopeCwd(await fs.realpath(directory)) !== normalizeScopeCwd(directory)) {
		throw new Error("Expected a real Obsidian vault directory.");
	}
}

function knowledgeDirectory(vault: string, cwd: string): string {
	return path.join(vault, `WISA Knowledge ${projectKey(cwd)}`);
}

async function requireVault(vault: string): Promise<void> {
	await requireDirectory(vault);
	await requireDirectory(path.join(vault, ".obsidian"));
}

function readEntry(directory: string, filename: string): MemoryListEntry {
	const target = path.join(directory, filename);
	const stat = fsSync.lstatSync(target);
	if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_ENTRY_BYTES) {
		throw new Error("Invalid project knowledge Markdown file.");
	}
	const bytes = fsSync.readFileSync(target);
	const text = utf8.decode(bytes).trim();
	return { line: `${filename}:${digest(bytes)}`, text };
}

/** Read only this project's approved Markdown; a blocked vault never falls back to local notes. */
export async function readProjectKnowledge(agentDir: string, cwd: string, settings: Settings): Promise<ProjectKnowledge> {
	const vault = await readKnowledgeBinding(bindingFile(agentDir, cwd));
	const vaultEnabled = cfgVaultEnabled.get(settings);
	if (!vault) return { source: "local", vaultEnabled };
	if (!vaultEnabled) return { source: "obsidian", vault, status: "disabled" };
	try {
		await requireVault(vault);
		const directory = knowledgeDirectory(vault, cwd);
		await requireDirectory(directory);
		const notes: MemoryListEntry[] = [];
		const lessons: MemoryListEntry[] = [];
		for (const filename of (await fs.readdir(directory)).sort()) {
			const kind = ENTRY_NAME.exec(filename)?.[1];
			if (kind) (kind === "note" ? notes : lessons).push(readEntry(directory, filename));
		}
		return { source: "obsidian", vault, status: "ready", notes, lessons };
	} catch {
		return { source: "obsidian", vault, status: "unavailable" };
	}
}

/** A stale local editor must not write after a source switch. */
export async function editLocalKnowledgeNote(
	agentDir: string,
	cwd: string,
	write: () => Promise<MemoryListEditResult>,
): Promise<MemoryListEditResult> {
	const binding = bindingFile(agentDir, cwd);
	await fs.mkdir(path.dirname(binding), { recursive: true });
	return withFileLock(binding, async () => {
		if (await readKnowledgeBinding(binding)) return { ok: false, reason: "not_found" };
		return write();
	});
}

export async function editProjectKnowledge(
	agentDir: string,
	cwd: string,
	settings: Settings,
	edit: ProjectKnowledgeEdit,
): Promise<MemoryListEditResult> {
	const binding = bindingFile(agentDir, cwd);
	await fs.mkdir(path.dirname(binding), { recursive: true });
	return withFileLock(binding, async () => {
		const vault = await readKnowledgeBinding(binding);
		if (edit.kind === "knowledge-source") {
			if (edit.previous !== vault) return { ok: false, reason: "not_found" };
			if (edit.vault === null) {
				await fs.rm(binding, { force: true });
				return { ok: true };
			}
			assertVaultEnabled(settings);
			if (!path.isAbsolute(edit.vault)) throw new Error("Select an absolute Obsidian Vault directory.");
			const selected = await fs.realpath(edit.vault);
			await requireVault(selected);
			assertVaultEnabled(settings);
			const directory = knowledgeDirectory(selected, cwd);
			await fs.mkdir(directory, { recursive: true });
			await requireDirectory(directory);
			assertVaultEnabled(settings);
			await writeFileAtomically(binding, `${JSON.stringify(selected)}\n`);
			return { ok: true };
		}
		if (!vault || edit.vault !== vault) return { ok: false, reason: "not_found" };
		assertVaultEnabled(settings);
		await requireVault(vault);
		const directory = knowledgeDirectory(vault, cwd);
		await requireDirectory(directory);
		const lock = path.join(directory, ".wisa-knowledge");
		// On Unix the native lock opens a sidecar file; never follow an alias from a vault.
		const lockStat = await fs.lstat(`${lock}.lock`).catch(error => {
			if (isEnoent(error)) return undefined;
			throw error;
		});
		if (lockStat && (!lockStat.isFile() || lockStat.nlink !== 1)) {
			throw new Error("Invalid project knowledge lock file.");
		}
		return withFileLock(lock, async () => {
			await requireVault(vault);
			await requireDirectory(directory);
			assertVaultEnabled(settings);
			return editEntry(directory, edit);
		});
	});
}

function assertVaultEnabled(settings: Settings): void {
	if (!cfgVaultEnabled.get(settings)) throw new Error("Obsidian Vault is disabled (vault.enabled).");
}

function editEntry(directory: string, edit: EntryEdit): MemoryListEditResult {
	if (edit.action !== "add" && edit.action !== "update" && edit.action !== "delete") {
		throw new Error("Unknown project knowledge edit.");
	}
	const text = edit.action === "delete" ? undefined : edit.text.trim();
	if (text !== undefined) {
		if (!text) return { ok: false, reason: "empty" };
		if (Buffer.byteLength(text, "utf8") + 1 > MAX_ENTRY_BYTES) {
			throw new Error("Project knowledge Markdown exceeds 64 KiB.");
		}
	}
	if (edit.action === "add") {
		if (edit.entryKind !== "note" && edit.entryKind !== "lesson") throw new Error("Invalid project knowledge type.");
		const filename = `${edit.entryKind}-${crypto.randomUUID()}.md`;
		const target = path.join(directory, filename);
		const file = fsSync.openSync(target, "wx", 0o600);
		try {
			try {
				fsSync.writeFileSync(file, `${text}\n`, "utf8");
				fsSync.fsyncSync(file);
			} finally {
				fsSync.closeSync(file);
			}
		} catch (error) {
			fsSync.unlinkSync(target);
			throw error;
		}
		return { ok: true };
	}
	const [filename, revision, extra] = edit.line.split(":");
	if (!filename || !revision || extra !== undefined || !ENTRY_NAME.test(filename) || !REVISION.test(revision)) {
		return { ok: false, reason: "not_found" };
	}
	try {
		if (readEntry(directory, filename).line !== edit.line) return { ok: false, reason: "not_found" };
	} catch (error) {
		if (isEnoent(error)) return { ok: false, reason: "not_found" };
		throw error;
	}
	const target = path.join(directory, filename);
	if (edit.action === "delete") fsSync.unlinkSync(target);
	else writeFileAtomicallySync(target, `${text}\n`);
	return { ok: true };
}
