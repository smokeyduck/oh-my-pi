import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetDirsFromEnvForTests,
	getConfigRootDir,
	getProjectAgentDir,
	getProjectConfigDirName,
} from "@oh-my-pi/pi-utils";
import { loadCapability, setEnabledProviders } from "../src/capability";
import { clearCache } from "../src/capability/fs";
import { type ContextFile, contextFileCapability } from "../src/capability/context-file";
import { type MCPServer, mcpCapability } from "../src/capability/mcp";
import { Settings } from "../src/config/settings";
import { cfgModelRoles } from "../src/config/model-settings";
import { resolveActiveProjectRegistryPath } from "../src/discovery/helpers";
import "../src/discovery";
import { AgentStorage } from "../src/session/agent-storage";
import { storageStatePath } from "../src/tools/browser/storage-state";

const keys = [
	"HOME",
	"PI_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"PI_PROJECT_CONFIG_DIR",
	"PI_CONFIG_SOURCES",
	"OMP_PROFILE",
	"PI_PROFILE",
	"PI_CONFIG_FILES",
];
const original = new Map(keys.map(key => [key, process.env[key]]));
let root: string | undefined;
afterEach(() => {
	AgentStorage.close();
	vi.restoreAllMocks();
	for (const [key, value] of original) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	setEnabledProviders([]);
	clearCache();
	__resetDirsFromEnvForTests();
	if (root) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(native: boolean): { cwd: string; agentDir: string } {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "wisa-project-isolation-"));
	const home = path.join(root, "home");
	fs.mkdirSync(home, { recursive: true });
	vi.spyOn(os, "homedir").mockReturnValue(home);
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "profile", "agent");
	for (const dir of [".omp", ".wisa-studio", ".claude", ".git"])
		fs.mkdirSync(path.join(cwd, dir), { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	for (const key of keys) delete process.env[key];
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_CONFIG_DIR = path.join(root, "profile");
	if (native) {
		process.env.PI_PROJECT_CONFIG_DIR = ".wisa-studio";
		process.env.PI_CONFIG_SOURCES = "native";
	}
	__resetDirsFromEnvForTests();
	fs.writeFileSync(path.join(cwd, ".omp", "config.yml"), "modelRoles:\n  default: old-omp/sentinel\n");
	fs.writeFileSync(path.join(cwd, ".wisa-studio", "config.yml"), "modelRoles:\n  default: wisa/isolated\n");
	fs.writeFileSync(
		path.join(cwd, ".claude", "settings.json"),
		JSON.stringify({ modelRoles: { default: "legacy-claude/sentinel" } }),
	);
	fs.writeFileSync(path.join(cwd, "AGENTS.md"), "Shared project instructions");
	fs.writeFileSync(
		path.join(cwd, ".mcp.json"),
		JSON.stringify({ mcpServers: { legacy: { command: "old-mcp-sentinel" } } }),
	);
	fs.writeFileSync(
		path.join(cwd, ".wisa-studio", "mcp.json"),
		JSON.stringify({ mcpServers: { isolated: { command: "wisa-mcp" } } }),
	);
	return { cwd, agentDir };
}

test("WISA ignores old project settings and ambient MCP; preserves instructions and persists only its namespace", async () => {
	const { cwd, agentDir } = fixture(true);
	const settings = await Settings.loadIsolated({ cwd, agentDir });
	expect(cfgModelRoles.get(settings).default).toBe("wisa/isolated");
	const servers = await loadCapability<MCPServer>(mcpCapability.id, { cwd });
	expect(servers.items.map(server => server.name)).toEqual(["isolated"]);
	expect(storageStatePath("tab", undefined, cwd)).toBe(path.join(getConfigRootDir(), "browser-state", "tab.json"));
	const context = await loadCapability<ContextFile>(contextFileCapability.id, { cwd });
	expect(context.items.some(file => file.content.includes("Shared project instructions"))).toBe(true);
	expect(await resolveActiveProjectRegistryPath(cwd)).toBe(
		path.join(cwd, ".wisa-studio", "plugins", "installed_plugins.json"),
	);
	settings.setProjectModelRole("default", "wisa/saved");
	await settings.flush();
	expect(fs.readFileSync(path.join(cwd, ".omp", "config.yml"), "utf8")).toContain("old-omp/sentinel");
	expect(fs.readFileSync(path.join(cwd, ".wisa-studio", "config.yml"), "utf8")).toContain("wisa/saved");
	const reloaded = await Settings.loadReadOnly({ cwd, agentDir });
	expect(cfgModelRoles.get(reloaded).default).toBe("wisa/saved");
});

test("default CLI still loads .omp and standalone MCP", async () => {
	const { cwd, agentDir } = fixture(false);
	expect(getProjectAgentDir(cwd)).toBe(path.join(cwd, ".omp"));
	const settings = await Settings.loadReadOnly({ cwd, agentDir });
	expect(cfgModelRoles.get(settings).default).toBe("old-omp/sentinel");
	const servers = await loadCapability<MCPServer>(mcpCapability.id, { cwd });
	expect(servers.items.some(server => server.name === "legacy")).toBe(true);
});

test("foreign project settings stay ambient unless the isolated profile explicitly enables them", async () => {
	const { cwd, agentDir } = fixture(true);
	fs.rmSync(path.join(cwd, ".wisa-studio", "config.yml"));
	const isolated = await Settings.loadReadOnly({ cwd, agentDir });
	expect(cfgModelRoles.get(isolated).default).not.toBe("legacy-claude/sentinel");
	fs.writeFileSync(path.join(agentDir, "config.yml"), "enabledProviders:\n  - claude\n");
	const optedIn = await Settings.loadReadOnly({ cwd, agentDir });
	expect(cfgModelRoles.get(optedIn).default).toBe("legacy-claude/sentinel");
	fs.rmSync(path.join(agentDir, "config.yml"));
	fs.writeFileSync(path.join(cwd, ".wisa-studio", "config.yml"), "enabledProviders:\n  - claude\n");
	const projectOptedIn = await Settings.loadReadOnly({ cwd, agentDir });
	expect(cfgModelRoles.get(projectOptedIn).default).toBe("legacy-claude/sentinel");
});

test("native policy preserves explicit source opt-ins and configured overlays", async () => {
	const { cwd, agentDir } = fixture(true);
	const overlay = path.join(root!, "explicit.yml");
	fs.writeFileSync(overlay, "modelRoles:\n  default: explicit/overlay\n");
	const settings = await Settings.loadReadOnly({ cwd, agentDir, configFiles: [overlay] });
	expect(cfgModelRoles.get(settings).default).toBe("explicit/overlay");
	setEnabledProviders(["mcp-json"]);
	const servers = await loadCapability<MCPServer>(mcpCapability.id, { cwd });
	expect(servers.items.some(server => server.name === "legacy")).toBe(true);
});

test("project namespace rejects traversal and absolute paths", () => {
	for (const invalid of ["..", ".", "../old", "/old", "a/b", "a\\b"]) {
		process.env.PI_PROJECT_CONFIG_DIR = invalid;
		expect(() => getProjectConfigDirName()).toThrow("single relative directory name");
	}
});

test("native mode ignores ambient dotenv but retains its own profile dotenv and inherited shell values", () => {
	const { cwd, agentDir } = fixture(true);
	fs.writeFileSync(path.join(process.env.HOME!, ".env"), "WISA_HOME_SENTINEL=old-home\n");
	fs.writeFileSync(path.join(cwd, ".env"), "WISA_PROJECT_SENTINEL=old-project\n");
	fs.writeFileSync(path.join(agentDir, ".env"), "WISA_PROFILE_SENTINEL=isolated-profile\n");
	const modulePath = path.resolve(import.meta.dir, "../../utils/src/env.ts");
	const script = `import {$env} from ${JSON.stringify(modulePath)}; console.log(JSON.stringify({home:$env.WISA_HOME_SENTINEL,project:$env.WISA_PROJECT_SENTINEL,profile:$env.WISA_PROFILE_SENTINEL,shell:$env.WISA_SHELL_SENTINEL}));`;
	const result = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], {
		cwd,
		env: {
			HOME: process.env.HOME!,
			PATH: process.env.PATH!,
			PI_CODING_AGENT_DIR: agentDir,
			PI_CONFIG_DIR: process.env.PI_CONFIG_DIR!,
			PI_PROJECT_CONFIG_DIR: ".wisa-studio",
			PI_CONFIG_SOURCES: "native",
			WISA_SHELL_SENTINEL: "inherited",
		},
	});
	expect(result.exitCode).toBe(0);
	expect(JSON.parse(result.stdout.toString())).toEqual({ profile: "isolated-profile", shell: "inherited" });
});
