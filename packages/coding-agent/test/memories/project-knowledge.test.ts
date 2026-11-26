import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildMemoryToolDeveloperInstructions, editMemoryList, getMemoryRoot } from "@oh-my-pi/pi-coding-agent/memories";
import {
	editLocalKnowledgeNote,
	editProjectKnowledge,
	readProjectKnowledge,
} from "@oh-my-pi/pi-coding-agent/memories/project-knowledge";
import { eraseMemory } from "@oh-my-pi/pi-coding-agent/memories/workbench";
import { TempDir } from "@oh-my-pi/pi-utils";

const enabled = Settings.isolated({ "memory.backend": "local", "vault.enabled": true });
const disabled = Settings.isolated({ "memory.backend": "local", "vault.enabled": false });
const stale = { ok: false, reason: "not_found" } as const;

describe("Obsidian project knowledge", () => {
	let temp: TempDir;
	let agentDir: string;
	let vault: string;
	let cwd: string;

	beforeEach(async () => {
		temp = TempDir.createSync("@test-project-knowledge-");
		const home = await fs.realpath(temp.path());
		agentDir = path.join(home, "agent");
		vault = path.join(home, "vault");
		cwd = path.join(home, "work", "one");
		await fs.mkdir(path.join(vault, ".obsidian"), { recursive: true });
	});

	afterEach(async () => {
		await temp.remove();
	});

	async function bind(project = cwd) {
		await expect(editProjectKnowledge(agentDir, project, enabled, { kind: "knowledge-source", vault, previous: null }))
			.resolves.toEqual({ ok: true });
	}

	async function ready(project = cwd) {
		const knowledge = await readProjectKnowledge(agentDir, project, enabled);
		if (knowledge.source !== "obsidian" || knowledge.status !== "ready") {
			throw new Error(`Expected ready vault, got ${JSON.stringify(knowledge)}`);
		}
		return knowledge;
	}

	async function projectFolder(): Promise<string> {
		const name = (await fs.readdir(vault)).find(entry => entry.startsWith("WISA Knowledge "));
		if (!name) throw new Error("Missing knowledge directory");
		return path.join(vault, name);
	}

	test("writes only approved Markdown to the selected project vault and keeps operational Memory separate", async () => {
		const root = getMemoryRoot(agentDir, cwd);
		await editMemoryList(agentDir, cwd, "notes", { action: "add", text: "Previous local note" });
		await Bun.write(path.join(root, "memory_summary.md"), "Operational summary");
		await Bun.write(path.join(root, "learned.md"), "- Automatic lesson\n");
		await bind();
		expect((await ready()).notes).toEqual([]);
		for (const [entryKind, text] of [["note", "Project note"], ["lesson", "Approved insight"]] as const) {
			await expect(editProjectKnowledge(agentDir, cwd, enabled, { kind: "knowledge-entry", action: "add", entryKind, vault, text }))
				.resolves.toEqual({ ok: true });
		}
		const otherCwd = path.join(path.dirname(path.dirname(cwd)), "work-one");
		await bind(otherCwd);
		expect((await ready(otherCwd)).notes).toEqual([]);
		expect((await ready(otherCwd)).lessons).toEqual([]);
		expect((await ready()).notes.map(note => note.text)).toEqual(["Project note"]);
		expect((await ready()).lessons.map(note => note.text)).toEqual(["Approved insight"]);
		expect(await fs.readFile(path.join(root, "notes.md"), "utf8")).toBe("- Previous local note\n");
		const prompt = await buildMemoryToolDeveloperInstructions(agentDir, cwd, enabled);
		expect(prompt).toContain("Project note");
		expect(prompt).toContain("Approved insight");
		expect(prompt).toContain("Operational summary");
		expect(prompt).toContain("Automatic lesson");
		expect(prompt).not.toContain("Previous local note");
		const session = { sessionManager: { getSessionFile: () => "/session.jsonl" } };
		expect(await buildMemoryToolDeveloperInstructions(agentDir, cwd, enabled, session)).toContain("Project note");
		expect(await buildMemoryToolDeveloperInstructions(agentDir, cwd, disabled, session)).not.toContain("Project note");
		expect(await buildMemoryToolDeveloperInstructions(agentDir, otherCwd, enabled, session)).not.toContain("Project note");
		await eraseMemory(agentDir, { cwd, sessionDir: path.join(agentDir, "sessions") });
		expect((await ready()).notes.map(note => note.text)).toEqual(["Project note"]);
	});

	test("refuses stale revisions and traversal, then updates and deletes from the same Markdown source", async () => {
		await bind();
		await editProjectKnowledge(agentDir, cwd, enabled, {
			kind: "knowledge-entry", action: "add", entryKind: "note", vault, text: "Original",
		});
		const directory = await projectFolder();
		const [original] = (await ready()).notes;
		if (!original) throw new Error("Missing original note");
		const filename = original.line.slice(0, original.line.indexOf(":"));
		const external = path.join(directory, filename);
		await fs.writeFile(external, "Edited in Obsidian\n");
		await expect(editProjectKnowledge(agentDir, cwd, enabled, {
			kind: "knowledge-entry", action: "update", vault, line: original.line, text: "Stale",
		})).resolves.toEqual(stale);
		await expect(editProjectKnowledge(agentDir, cwd, enabled, {
			kind: "knowledge-entry", action: "delete", vault, line: `../${original.line}`,
		})).resolves.toEqual(stale);
		expect(await fs.readFile(external, "utf8")).toBe("Edited in Obsidian\n");
		const [fresh] = (await ready()).notes;
		if (!fresh) throw new Error("Missing externally edited note");
		await expect(editProjectKnowledge(agentDir, cwd, enabled, {
			kind: "knowledge-entry", action: "update", vault, line: fresh.line, text: "First paragraph\n\nSecond paragraph",
		})).resolves.toEqual({ ok: true });
		expect(await fs.readFile(external, "utf8")).toBe("First paragraph\n\nSecond paragraph\n");
		const [updated] = (await ready()).notes;
		if (!updated) throw new Error("Missing updated note");
		await expect(editProjectKnowledge(agentDir, cwd, enabled, {
			kind: "knowledge-entry", action: "delete", vault, line: updated.line,
		})).resolves.toEqual({ ok: true });
		expect((await ready()).notes).toEqual([]);
	});

	test("fails closed when permission is revoked or the vault folder is replaced by a link", async () => {
		const root = getMemoryRoot(agentDir, cwd);
		await editMemoryList(agentDir, cwd, "notes", { action: "add", text: "Never fall back to this" });
		await Bun.write(path.join(root, "memory_summary.md"), "Operational summary");
		const selection = { kind: "knowledge-source", vault, previous: null } as const;
		await expect(editProjectKnowledge(agentDir, cwd, disabled, selection)).rejects.toThrow("vault.enabled");
		await bind();
		const add = { kind: "knowledge-entry", action: "add", entryKind: "note", vault, text: "Vault-only note" } as const;
		await editProjectKnowledge(agentDir, cwd, enabled, add);
		await expect(editProjectKnowledge(agentDir, cwd, disabled, add)).rejects.toThrow("vault.enabled");
		await expect(editLocalKnowledgeNote(agentDir, cwd, () => {
			throw new Error("Must not write to local Memory");
		})).resolves.toEqual(stale);
		expect(await readProjectKnowledge(agentDir, cwd, disabled)).toEqual({ source: "obsidian", status: "disabled", vault });
		const blocked = await buildMemoryToolDeveloperInstructions(agentDir, cwd, disabled);
		expect(blocked).toContain("Operational summary");
		expect(blocked).not.toContain("Never fall back to this");
		expect(blocked).not.toContain("Vault-only note");

		const directory = await projectFolder();
		const original = `${directory}.moved`;
		await fs.rename(directory, original);
		expect(await readProjectKnowledge(agentDir, cwd, enabled)).toEqual({ source: "obsidian", status: "unavailable", vault });
		const foreign = path.join(temp.path(), "foreign");
		await fs.mkdir(foreign);
		await fs.symlink(foreign, directory, process.platform === "win32" ? "junction" : "dir");
		expect(await readProjectKnowledge(agentDir, cwd, enabled)).toEqual({ source: "obsidian", status: "unavailable", vault });
		await expect(editProjectKnowledge(agentDir, cwd, enabled, add)).rejects.toThrow("real Obsidian vault directory");
		expect(await fs.readdir(foreign)).toEqual([]);
		const unavailable = await buildMemoryToolDeveloperInstructions(agentDir, cwd, enabled);
		expect(unavailable).toContain("Operational summary");
		expect(unavailable).not.toContain("Never fall back to this");
		await expect(editProjectKnowledge(agentDir, cwd, disabled, { kind: "knowledge-source", vault: null, previous: vault }))
			.resolves.toEqual({ ok: true });
		expect(await buildMemoryToolDeveloperInstructions(agentDir, cwd, disabled)).toContain("Never fall back to this");
		expect((await fs.readdir(original)).filter(name => name.endsWith(".md"))).toHaveLength(1);
	});
});
