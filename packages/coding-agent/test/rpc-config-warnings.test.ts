import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { RpcCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";

interface Frame {
	type: string;
	id?: string;
	success?: boolean;
	data?: Record<string, unknown>;
	error?: string;
}

async function start(mode = "normal", directory?: TempDir, sessionFile?: string) {
	const temp = directory ?? (await TempDir.create("@rpc-config-warnings-"));
	await Bun.write(
		temp.join("models.yml"),
		[
			"providers:",
			"  warning-fixture:",
			"    baseUrl: https://warning-fixture.invalid/v1",
			"    api: openai-completions",
			"    auth: oauth",
			"    models:",
			"      - id: fixture-model",
			"  warning-unauthenticated:",
			"    baseUrl: https://warning-fixture.invalid/v1",
			"    api: openai-completions",
			"    auth: oauth",
			"    models:",
			"      - id: fixture-model",
		].join("\n"),
	);
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "config-warnings-rpc-agent.ts")], {
		cwd: temp.path(),
		env: {
			PATH: Bun.env.PATH,
			HOME: temp.join("home"),
			PI_CODING_AGENT_DIR: temp.join("agent"),
			XDG_CONFIG_HOME: temp.join("config"),
			XDG_DATA_HOME: temp.join("data"),
			XDG_CACHE_HOME: temp.join("cache"),
			CI: "true",
			PI_NO_TITLE: "1",
			WARNING_FIXTURE_MODE: mode,
			...(sessionFile ? { WARNING_FIXTURE_SESSION: sessionFile } : {}),
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderr = new Response(child.stderr).text();
	const pending = new Map<string, PromiseWithResolvers<Frame>>();
	const events: string[] = [];
	let sequence = 0;
	const pump = (async () => {
		try {
			for await (const frame of readJsonl<unknown>(child.stdout)) {
				if (!isRecord(frame) || typeof frame.type !== "string") continue;
				if (frame.type === "response" && typeof frame.id === "string") {
					pending.get(frame.id)?.resolve(frame as unknown as Frame);
					pending.delete(frame.id);
				} else {
					events.push(frame.type);
				}
			}
		} finally {
			const error = new Error(`Fixture RPC ended: ${await stderr}`);
			for (const waiter of pending.values()) waiter.reject(error);
			pending.clear();
		}
	})();
	const request = async (command: RpcCommand): Promise<Frame> => {
		const id = String(++sequence);
		const waiter = Promise.withResolvers<Frame>();
		pending.set(id, waiter);
		child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		await child.stdin.flush();
		return waiter.promise;
	};
	return {
		request,
		events,
		warnings: async () => {
			const response = await request({ type: "get_config_warnings" });
			expect(response.success).toBe(true);
			return response.data?.warnings as string[];
		},
		[Symbol.asyncDispose]: async () => {
			child.stdin.end();
			await child.exited;
			await pump;
			if (!directory) await temp.remove();
		},
	};
}

const select: RpcCommand = { type: "set_model", provider: "warning-fixture", modelId: "fixture-model" };

describe("RPC startup model warning lifecycle", () => {
	test("keeps warnings after auth/catalog availability and failed selections, then retracts only the owned warning", async () => {
		await using rpc = await start();
		const before = await rpc.warnings();
		const transient = before.at(-1)!;
		// The SDK produced the same diagnostic as another warning owner. Both must
		// survive availability and failures; only the session-owned one expires.
		expect(before.filter(warning => warning === transient)).toHaveLength(2);
		expect((await rpc.request({ type: "get_state" })).data?.model).toBeUndefined();
		const available = await rpc.request({ type: "get_available_models" });
		expect(available.success).toBe(true);
		expect(available.data?.models).toContainEqual(
			expect.objectContaining({ provider: "warning-fixture", id: "fixture-model" }),
		);
		expect(await rpc.warnings()).toEqual(before);
		for (const provider of ["warning-missing", "warning-unauthenticated"]) {
			expect((await rpc.request({ type: "set_model", provider, modelId: "fixture-model" })).success).toBe(false);
			expect(await rpc.warnings()).toEqual(before);
		}
		expect(rpc.events).not.toContain("config_warnings_changed");
		expect((await rpc.request(select)).success).toBe(true);
		expect((await rpc.request({ type: "get_state" })).data?.model).toMatchObject({
			provider: "warning-fixture",
			id: "fixture-model",
		});
		expect(await rpc.warnings()).toEqual(before.slice(0, -1));
		expect(rpc.events.filter(type => type === "config_warnings_changed")).toHaveLength(1);
		// Same-model reselection cannot duplicate the cleared slot or its event.
		expect((await rpc.request(select)).success).toBe(true);
		expect(await rpc.warnings()).toEqual(before.slice(0, -1));
		expect(rpc.events.filter(type => type === "config_warnings_changed")).toHaveLength(1);
	}, 30_000);

	test("does not retract a warning on early model_changed when late selection reconciliation fails", async () => {
		await using rpc = await start("late-failure");
		const before = await rpc.warnings();
		const failed = await rpc.request(select);
		expect(failed.success).toBe(false);
		expect(failed.error).toContain("reconciliation failed");
		expect((await rpc.request({ type: "get_state" })).data?.model).toMatchObject({
			provider: "warning-fixture",
			id: "fixture-model",
		});
		expect(rpc.events).toContain("model_changed");
		expect(await rpc.warnings()).toEqual(before);
		expect(rpc.events).not.toContain("config_warnings_changed");
		expect((await rpc.request(select)).success).toBe(true);
		expect(await rpc.warnings()).toEqual(before.slice(0, -1));
		expect(rpc.events.filter(type => type === "config_warnings_changed")).toHaveLength(1);
	}, 30_000);

	test("does not republish the startup snapshot after a model settles before root notification collection", async () => {
		await using rpc = await start("startup-race");
		expect((await rpc.request({ type: "get_state" })).data?.model).toMatchObject({
			provider: "warning-fixture",
			id: "fixture-model",
		});
		expect(await rpc.warnings()).toEqual(["Fixture unrelated configuration warning"]);
	}, 30_000);

	test("restores a selected model from its persisted session after an isolated RPC restart", async () => {
		await using directory = await TempDir.create("@rpc-config-warnings-restart-");
		let sessionFile: string;
		{
			await using rpc = await start("persist", directory);
			const before = await rpc.warnings();
			expect((await rpc.request(select)).success).toBe(true);
			expect(await rpc.warnings()).toEqual(before.slice(0, -1));
			sessionFile = (await rpc.request({ type: "get_state" })).data?.sessionFile as string;
		}
		const entries = (await Bun.file(sessionFile!).text())
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(entries).toContainEqual(
			expect.objectContaining({ type: "model_change", model: "warning-fixture/fixture-model" }),
		);
		await using resumed = await start("resume", directory, sessionFile!);
		expect((await resumed.request({ type: "get_state" })).data?.model).toMatchObject({
			provider: "warning-fixture",
			id: "fixture-model",
		});
		expect(await resumed.warnings()).toEqual(["Fixture unrelated configuration warning"]);
	}, 30_000);
});
