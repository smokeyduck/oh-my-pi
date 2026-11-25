/** Paint upstream reactive surfaces into WISA's RPC virtual terminals, not the process terminal. */
import { createSurface, type JSXNode, type Signal, signal, type Surface, type UiNode } from "@oh-my-pi/pi-tui";
import { detectTerminal } from "@oh-my-pi/pi-tui/driver/caps/detect";
import type { FramePlan, InputEvent, TerminalDriver } from "@oh-my-pi/pi-tui/driver/contract";
import { InputDecoder } from "@oh-my-pi/pi-tui/driver/input/decoder";
import { FrameWriter } from "@oh-my-pi/pi-tui/driver/output/writer";
import { TermBackend } from "@oh-my-pi/pi-tui/term/backend";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { logger } from "@oh-my-pi/pi-utils";
import { KeybindingsManager } from "../../config/keybindings/keybindings";
import type { ExtensionCustomFactory, ExtensionCustomOptions } from "../../extensibility/extensions/types";
import { extensionOutput, extensionTheme, singleNode } from "../../ui/extensions/render-output";
import { extensionOverlay } from "../controllers/extension-ui-blocks";
import { firstOfKind, fullscreenMenuView } from "../controllers/selector-views";
import type { RpcTerminalHost, VirtualTerminalHandle } from "./rpc-terminal";

const CAPABILITIES = detectTerminal({ TERM: "xterm-256color", COLORTERM: "truecolor" }, { platform: "linux" }).capabilities;

/** The normal decoder, renderer and frame writer; each virtual terminal owns only its own transport. */
class HostedTerminal implements TerminalDriver {
	readonly capabilities = CAPABILITIES;
	readonly #handle: VirtualTerminalHandle;
	readonly #writer: FrameWriter;
	readonly #decoder = new InputDecoder({
		input: event => {
			for (const listener of this.#input) listener(event);
		},
		reply: () => {}, // No terminal probes on a virtual view.
	});
	readonly #input = new Set<(event: InputEvent) => void>();
	readonly #resize = new Set<(columns: number, rows: number) => void>();
	readonly #replay = new Set<() => void>();
	#running = false;

	constructor(handle: VirtualTerminalHandle) {
		this.#handle = handle;
		this.#writer = new FrameWriter({
			sink: { write: data => handle.write(data), flush: () => Promise.resolve() },
			columns: handle.cols,
			rows: handle.rows,
			synchronizedOutput: () => this.capabilities.synchronizedOutput,
			multiplexer: () => false,
			hostOwnsGrid: () => true,
			onInvalidate: kind => {
				if (kind === "replay") {
					for (const listener of this.#replay) listener();
				} else this.#sendResize();
			},
		});
	}

	get columns(): number {
		return this.#handle.cols;
	}
	get rows(): number {
		return this.#handle.rows;
	}
	feed(data: string): void {
		if (this.#running) this.#decoder.process(data);
	}
	resize(columns: number, rows: number): void {
		this.#writer.resize(columns, rows);
		this.#sendResize();
	}
	#sendResize(): void {
		for (const listener of this.#resize) listener(this.columns, this.rows);
	}
	async start(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		this.#writer.start({ row: 0, col: 0 });
		this.writeRaw("\x1b[2J\x1b[H\x1b[?2004h\x1b[?1000h\x1b[?1006h");
	}
	async stop(): Promise<void> {
		if (!this.#running) return;
		this.#running = false;
		this.#decoder.clear();
		this.#writer.stop();
		this.writeRaw("\x1b[?1006l\x1b[?1000l\x1b[?2004l");
	}
	present(frame: FramePlan): number | undefined {
		return this.#writer.present(frame);
	}
	viewportRow(row: number): number | null {
		return this.#writer.viewportRow(row);
	}
	writeRaw(data: string): void {
		this.#writer.writeRaw(data);
	}
	onInput(listener: (event: InputEvent) => void): () => void {
		this.#input.add(listener);
		return () => this.#input.delete(listener);
	}
	onResize(listener: (columns: number, rows: number) => void): () => void {
		this.#resize.add(listener);
		return () => this.#resize.delete(listener);
	}
	onCapabilities(): () => void {
		return () => {}; // Virtual-terminal capabilities are fixed.
	}
	onReplay(listener: () => void): () => void {
		this.#replay.add(listener);
		return () => this.#replay.delete(listener);
	}
	resetDisplay(): void {
		this.#writer.resetDisplay();
	}
	setTitle(title: string): void {
		this.writeRaw(`\x1b]2;${title.replace(/[\x00-\x1f\x7f-\x9f]/g, "")}\x07`);
	}
}

interface HostedView {
	/** The view is created inside the surface's reactive owner. */
	mount(): { main?: JSXNode; dock?: JSXNode; layer?: JSXNode; focus: UiNode };
	discard?(): void;
}

interface HostedViewContext<T> {
	done(value: T): void;
	revision: Signal<number>;
	size(): { columns: number; rows: number };
	suspend<R>(run: () => Promise<R>): Promise<R>;
}

function showHostedView<T>(
	host: RpcTerminalHost,
	title: string,
	prepare: (context: HostedViewContext<T>) => HostedView | Promise<HostedView>,
	options?: ExtensionCustomOptions,
): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	if (options?.signal?.aborted) {
		return Promise.reject(options.signal.reason ?? new DOMException("Dialog aborted", "AbortError"));
	}
	const revision = signal(0);
	let surface: Surface | undefined;
	let backend: TermBackend | undefined;
	let closed = false;
	const unmount = () => {
		backend?.stop();
		backend = undefined;
		void terminal.stop();
		surface?.dispose();
		surface = undefined;
	};
	const finish = (settle: () => void) => {
		if (closed) return;
		closed = true;
		options?.signal?.removeEventListener("abort", onAbort);
		try {
			unmount();
		} finally {
			try {
				handle.finish();
			} finally {
				settle();
			}
		}
	};
	const onAbort = () => finish(() => reject(options?.signal?.reason ?? new DOMException("Dialog aborted", "AbortError")));
	const handle = host.openVirtual(title, {
		onInput: data => terminal.feed(data),
		onResize: (columns, rows) => {
			size.set({ columns, rows });
			terminal.resize(columns, rows);
		},
		onClose: () => finish(() => resolve(undefined as T)),
	});
	const terminal = new HostedTerminal(handle);
	const size = signal({ columns: handle.cols, rows: handle.rows });
	options?.signal?.addEventListener("abort", onAbort, { once: true });
	Promise.try(() =>
		prepare({
			done: value => finish(() => resolve(value)),
			revision,
			size,
			suspend: async run => {
				const active = backend;
				active?.stop();
				await terminal.stop();
				try {
					return await run();
				} finally {
					if (active && backend === active) {
						await terminal.start();
						if (backend === active) active.start();
					}
				}
			},
		}),
	)
		.then(async view => {
			if (closed) {
				view.discard?.();
				return;
			}
			// Register the same terminal-only styles as the interactive shell, lazily.
			require("../../ui/styles");
			let focus: UiNode | undefined;
			surface = createSurface(() => {
				const { focus: node, ...regions } = view.mount();
				focus = node;
				return regions;
			});
			if (closed) {
				surface.dispose();
				surface = undefined;
				return;
			}
			surface.focus(focus ?? null);
			backend = new TermBackend({ surface, driver: terminal, theme: currentTheme });
			await terminal.start();
			backend?.start();
			if (options?.overlay && backend) {
				options.onHandle?.({
					get closed() {
						return !backend;
					},
					close: unmount,
				});
			}
		})
		.catch((error: unknown) => finish(() => reject(error)));
	return promise;
}

/** Render upstream extension nodes or rows in a revealed host terminal. */
export function showHostedComponent<T>(
	host: RpcTerminalHost,
	title: string,
	factory: ExtensionCustomFactory<T>,
	options?: ExtensionCustomOptions,
): Promise<T> {
	return showHostedView<T>(host, title, async ({ done, revision, size, suspend }) => {
		const output = await factory(
			{ requestRender: () => revision.set(revision.peek() + 1), size, suspend },
			extensionTheme(currentTheme()),
			KeybindingsManager.inMemory(),
			done,
		);
		return {
			mount: () => {
				const node = singleNode(
					extensionOutput(output, {
						revision,
						input: true,
						onError: error => logger.warn("Hosted extension view failed", { error }),
					}) ?? [],
				);
				if (options?.overlay) {
					return { layer: extensionOverlay(node, options.fullscreen === true, false), focus: node };
				}
				return { dock: node, focus: node };
			},
			discard: () => {
				if (output && typeof output === "object" && "dispose" in output) output.dispose?.();
			},
		};
	}, options);
}

/** Open one of the coding agent's native screens in a host terminal. */
export function showHostedOverlay(
	host: RpcTerminalHost,
	title: string,
	prepare: (close: () => void) => Promise<() => JSXNode>,
	focusKind: string,
): Promise<void> {
	return showHostedView<void>(host, title, async ({ done }) => {
		const render = await prepare(() => done(undefined));
		return {
			mount: () => {
				const node = singleNode(render());
				return { layer: fullscreenMenuView("rpc-hosted", node), focus: firstOfKind(node, focusKind) };
			},
		};
	});
}
