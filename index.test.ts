import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import {
	atomicWriteText,
	buildSummaryCardLines,
	ensureEditablePromptFile,
	getSummaryArgumentCompletions,
	promptOpenCommand,
	summaryRecap,
	updatePromptConfig,
} from "./index.ts";
import chatSummary from "./index.ts";
import { DEFAULT_SUMMARY_PROMPT_FILE, resolveSummaryPrompt, type SummaryState } from "./summaries.ts";

const state: SummaryState = {
	version: 1,
	recap: "The user wanted separate summary and suggestion experiences. Both experiences are now implemented.",
	sessionSummary:
		"The goal is a split extension architecture. Chat Summary owns summaries. Chat Suggest owns prompts. Keyboard behavior is complete. Final validation remains.",
	lastProcessedEntryId: "a1",
	updatedAt: "2026-08-11T00:00:00.000Z",
};

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
} as unknown as ExtensionContext["ui"]["theme"];

describe("summary command helpers", () => {
	test("describes and filters subcommands", () => {
		const all = getSummaryArgumentCompletions("") ?? [];
		expect(all.map((item) => item.value)).toContain("prompt");
		expect(all.map((item) => item.value)).not.toContain("demo");
		expect(all.find((item) => item.value === "settings")?.description).toContain("toggles");
		expect(getSummaryArgumentCompletions("pro")?.map((item) => item.value)).toEqual(["prompt"]);
	});

	test("loads deterministic generic demo content without exposing the hidden command", async () => {
		const harness = promptCommandHarness(tmpdir(), "tui", false);
		await harness.run("demo");
		expect(harness.appendedEntries).toHaveLength(1);
		const demo = harness.appendedEntries[0]?.data as SummaryState;
		expect(demo.recap).toContain("nothing appears to be on fire");
		expect(demo.sessionSummary).toContain("common edge cases");
		expect(demo.sessionSummary).toContain("definitely planned all along");
		expect(demo.lastProcessedEntryId).toBe("leaf-demo");
		expect(harness.notifications.join("\n")).toContain("next normal update will replace it");
	});

	test("builds platform file-open commands", () => {
		expect(promptOpenCommand("/tmp/prompt.txt", "darwin")).toEqual({ command: "open", args: ["/tmp/prompt.txt"] });
		expect(promptOpenCommand("C:\\prompt.txt", "win32")).toEqual({ command: "cmd", args: ["/c", "start", "", "C:\\prompt.txt"] });
		expect(promptOpenCommand("/tmp/prompt.txt", "linux")).toEqual({ command: "xdg-open", args: ["/tmp/prompt.txt"] });
	});

	test("token-completes every documented prompt-management target", () => {
		const values = getSummaryArgumentCompletions("prompt ")?.map((item) => item.value) ?? [];
		expect(values).toContain("prompt status");
		for (const verb of ["edit", "open", "copy-path", "copy-content"]) {
			for (const target of ["active", "project", "global"]) {
				expect(values).toContain(`prompt ${verb} ${target}`);
			}
		}
		for (const target of ["project", "global", "builtin", "auto"]) {
			expect(values).toContain(`prompt use ${target}`);
		}
		expect(values).toContain("prompt reset project");
		expect(values).toContain("prompt reset global");
		expect(getSummaryArgumentCompletions("prompt edit p")?.map((item) => item.value)).toEqual(["prompt edit project"]);
		expect(getSummaryArgumentCompletions("prompt open g")?.map((item) => item.value)).toEqual(["prompt open global"]);
		expect(getSummaryArgumentCompletions("prompt use p")?.map((item) => item.value)).toEqual(["prompt use project"]);
		expect(getSummaryArgumentCompletions("prompt use g")?.map((item) => item.value)).toEqual(["prompt use global"]);
		expect(getSummaryArgumentCompletions("prompt use b")?.map((item) => item.value)).toEqual(["prompt use builtin"]);
		expect(getSummaryArgumentCompletions("prompt reset g")?.map((item) => item.value)).toEqual(["prompt reset global"]);
	});

	test("creates a missing custom prompt from the bundled template", () => {
		const directory = mkdtempSync(join(tmpdir(), "chat-summary-open-"));
		const bundled = join(directory, "bundled.txt");
		const target = join(directory, "nested", "prompt.txt");
		try {
			writeFileSync(bundled, "Editable prompt");
			ensureEditablePromptFile(target, bundled);
			expect(existsSync(target)).toBeTrue();
			expect(readFileSync(target, "utf8")).toBe("Editable prompt");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("atomically writes prompt content and minimal config overrides", () => {
		const directory = mkdtempSync(join(tmpdir(), "chat-summary-atomic-"));
		const prompt = join(directory, "prompt.txt");
		const config = join(directory, "config.json");
		try {
			atomicWriteText(prompt, "first");
			atomicWriteText(prompt, "second");
			writeFileSync(config, '{"enabled":false,"unrelated":{"keep":true},"promptFile":"old"}');
			updatePromptConfig(config, (value) => {
				delete value.promptFile;
				value.promptSource = "global";
			});
			expect(readFileSync(prompt, "utf8")).toBe("second");
			expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
				enabled: false,
				unrelated: { keep: true },
				promptSource: "global",
			});
			expect([...new Bun.Glob("*.tmp").scanSync(directory)]).toEqual([]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

function promptCommandHarness(
	directory: string,
	mode: "tui" | "rpc" | "json" | "print",
	trusted: boolean | (() => boolean),
	editorResult?: string,
	confirmResult = true,
	onEditor?: () => void,
) {
	let command: any;
	let execCalls = 0;
	let editorCalls = 0;
	let confirmCalls = 0;
	const notifications: string[] = [];
	const appendedEntries: Array<{ type: string; data: unknown }> = [];
	const pi = {
		registerEntryRenderer: () => {},
		registerCommand: (_name: string, definition: unknown) => { command = definition; },
		on: () => {},
		exec: async () => { execCalls++; return { code: 0, stdout: "", stderr: "" }; },
		appendEntry: (type: string, data: unknown) => appendedEntries.push({ type, data }),
	} as any;
	chatSummary(pi);
	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		cwd: join(directory, "project"),
		isProjectTrusted: () => typeof trusted === "function" ? trusted() : trusted,
		sessionManager: {
			getBranch: () => [],
			getLeafId: () => "leaf-demo",
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => {},
			editor: async () => {
				editorCalls++;
				onEditor?.();
				return editorResult;
			},
			select: async () => undefined,
			confirm: async () => { confirmCalls++; return confirmResult; },
		},
	} as any;
	return {
		run: (args: string) => command.handler(args, ctx),
		notifications,
		appendedEntries,
		get execCalls() { return execCalls; },
		get editorCalls() { return editorCalls; },
		get confirmCalls() { return confirmCalls; },
	};
}

describe("settings persistence provenance and trust", () => {
	test("persists only the changed project setting without materializing a global promptFile", async () => {
		const directory = mkdtempSync(join(tmpdir(), "chat-summary-setting-provenance-"));
		const previous = process.env.PI_CONFIG_DIR;
		process.env.PI_CONFIG_DIR = join(directory, "pi-config");
		const cwd = join(directory, "project");
		const globalConfig = join(directory, "pi-config", "agent", "chat-summary.json");
		const globalPrompt = join(directory, "pi-config", "agent", "guidance", "global.txt");
		const projectConfig = join(cwd, ".pi", "chat-summary.json");
		try {
			mkdirSync(join(directory, "pi-config", "agent", "guidance"), { recursive: true });
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			writeFileSync(globalPrompt, "GLOBAL RELATIVE");
			writeFileSync(globalConfig, JSON.stringify({ promptFile: "guidance/global.txt", unrelatedGlobal: true }));
			writeFileSync(projectConfig, JSON.stringify({ summaries: { auto: false }, unrelatedProject: true }));
			const harness = promptCommandHarness(directory, "tui", true);
			await harness.run("off");
			expect(JSON.parse(readFileSync(globalConfig, "utf8"))).toEqual({
				promptFile: "guidance/global.txt",
				unrelatedGlobal: true,
			});
			expect(JSON.parse(readFileSync(projectConfig, "utf8"))).toEqual({
				summaries: { auto: false },
				unrelatedProject: true,
				enabled: false,
			});
			const loaded = loadConfig(cwd, true);
			expect(resolveSummaryPrompt({ cwd, trusted: true, loaded })).toMatchObject({
				scope: "global",
				path: globalPrompt,
				content: "GLOBAL RELATIVE",
			});
		} finally {
			if (previous === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("falls back to global configuration when project trust is revoked before the write", async () => {
		const directory = mkdtempSync(join(tmpdir(), "chat-summary-setting-revoked-"));
		const previous = process.env.PI_CONFIG_DIR;
		process.env.PI_CONFIG_DIR = join(directory, "pi-config");
		const projectConfig = join(directory, "project", ".pi", "chat-summary.json");
		const globalConfig = join(directory, "pi-config", "agent", "chat-summary.json");
		try {
			mkdirSync(join(directory, "project", ".pi"), { recursive: true });
			writeFileSync(projectConfig, JSON.stringify({ projectOnly: true }));
			let trustChecks = 0;
			const harness = promptCommandHarness(directory, "tui", () => ++trustChecks <= 2);
			await harness.run("off");
			expect(JSON.parse(readFileSync(projectConfig, "utf8"))).toEqual({ projectOnly: true });
			expect(JSON.parse(readFileSync(globalConfig, "utf8"))).toEqual({ enabled: false });
		} finally {
			if (previous === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("prompt command side-effect boundaries", () => {
	test("does not write explicit or active project guidance when trust is revoked during editing", async () => {
		for (const target of ["project", "active"] as const) {
			const directory = mkdtempSync(join(tmpdir(), `chat-summary-edit-revoked-${target}-`));
			const previous = process.env.PI_CONFIG_DIR;
			process.env.PI_CONFIG_DIR = join(directory, "pi-config");
			const projectPrompt = join(directory, "project", ".pi", "chat-summary-prompt.txt");
			try {
				if (target === "active") {
					mkdirSync(dirname(projectPrompt), { recursive: true });
					writeFileSync(projectPrompt, "ORIGINAL PROJECT GUIDANCE");
				}
				let trusted = true;
				const harness = promptCommandHarness(
					directory,
					"tui",
					() => trusted,
					"WRITTEN AFTER REVOCATION",
					true,
					() => { trusted = false; },
				);
				await harness.run(`prompt edit ${target}`);
				expect(trusted).toBeFalse();
				expect(harness.notifications.join("\n")).toContain("trust was revoked");
				if (target === "active") {
					expect(readFileSync(projectPrompt, "utf8")).toBe("ORIGINAL PROJECT GUIDANCE");
				} else {
					expect(existsSync(projectPrompt)).toBeFalse();
				}
			} finally {
				if (previous === undefined) delete process.env.PI_CONFIG_DIR;
				else process.env.PI_CONFIG_DIR = previous;
				rmSync(directory, { recursive: true, force: true });
			}
		}
	});

	test("TUI edit saves on submit and leaves a missing file unchanged on cancel", async () => {
		const directory = mkdtempSync(join(tmpdir(), "chat-summary-edit-"));
		const previous = process.env.PI_CONFIG_DIR;
		process.env.PI_CONFIG_DIR = join(directory, "pi-config");
		const globalPrompt = join(directory, "pi-config", "agent", "chat-summary-prompt.txt");
		try {
			const cancelled = promptCommandHarness(directory, "tui", false, undefined);
			await cancelled.run("prompt edit global");
			expect(cancelled.editorCalls).toBe(1);
			expect(existsSync(globalPrompt)).toBeFalse();
			const submitted = promptCommandHarness(directory, "tui", false, "CUSTOM GUIDANCE");
			await submitted.run("prompt edit global");
			expect(readFileSync(globalPrompt, "utf8")).toBe("CUSTOM GUIDANCE");
		} finally {
			if (previous === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("TUI open creates explicit customization and reports active status provenance", async () => {
		const directory = mkdtempSync(join(tmpdir(), "chat-summary-open-status-"));
		const previous = process.env.PI_CONFIG_DIR;
		process.env.PI_CONFIG_DIR = join(directory, "pi-config");
		try {
			const harness = promptCommandHarness(directory, "tui", false);
			await harness.run("prompt status");
			expect(harness.notifications.join("\n")).toContain("Active: bundled");
			expect(harness.notifications.join("\n")).toContain("Path:");
			await harness.run("prompt open global");
			expect(harness.execCalls).toBe(1);
			expect(existsSync(join(directory, "pi-config", "agent", "chat-summary-prompt.txt"))).toBeTrue();
		} finally {
			if (previous === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("TUI use/reset creates only scoped prompt overrides and confirms reset", async () => {
		const directory = mkdtempSync(join(tmpdir(), "chat-summary-use-reset-"));
		const previous = process.env.PI_CONFIG_DIR;
		process.env.PI_CONFIG_DIR = join(directory, "pi-config");
		try {
			const harness = promptCommandHarness(directory, "tui", true);
			await harness.run("prompt use project");
			const projectPrompt = join(directory, "project", ".pi", "chat-summary-prompt.txt");
			const projectConfig = join(directory, "project", ".pi", "chat-summary.json");
			expect(existsSync(projectPrompt)).toBeTrue();
			expect(JSON.parse(readFileSync(projectConfig, "utf8"))).toEqual({ promptSource: "project" });
			await harness.run("prompt use builtin");
			expect(JSON.parse(readFileSync(projectConfig, "utf8"))).toEqual({ promptSource: "builtin" });
			await harness.run("prompt use auto");
			expect(existsSync(projectConfig)).toBeFalse();
			await harness.run("prompt use project");
			await harness.run("prompt reset project");
			expect(existsSync(projectPrompt)).toBeFalse();
			expect(existsSync(projectConfig)).toBeFalse();
		} finally {
			if (previous === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("refuses to open active bundled guidance and rejects extra use/reset tokens before side effects", async () => {
		const directory = mkdtempSync(join(tmpdir(), "chat-summary-arity-bundled-"));
		const previous = process.env.PI_CONFIG_DIR;
		process.env.PI_CONFIG_DIR = join(directory, "pi-config");
		try {
			const harness = promptCommandHarness(directory, "tui", false);
			await harness.run("prompt open active");
			await harness.run("prompt use global extra");
			await harness.run("prompt reset global extra");
			expect(harness.execCalls).toBe(0);
			expect(harness.confirmCalls).toBe(0);
			expect(existsSync(join(directory, "pi-config"))).toBeFalse();
			expect(harness.notifications.join("\n")).toContain("read-only");
			expect(harness.notifications.filter((message) => message.startsWith("Usage:"))).toHaveLength(2);
		} finally {
			if (previous === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("reset cancellation leaves scoped configuration and canonical content unchanged", async () => {
		const directory = mkdtempSync(join(tmpdir(), "chat-summary-reset-cancel-"));
		const previous = process.env.PI_CONFIG_DIR;
		process.env.PI_CONFIG_DIR = join(directory, "pi-config");
		const configPath = join(directory, "project", ".pi", "chat-summary.json");
		const promptPath = join(directory, "project", ".pi", "chat-summary-prompt.txt");
		try {
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(configPath, JSON.stringify({ promptSource: "project", keep: true }));
			writeFileSync(promptPath, "KEEP PROJECT");
			const harness = promptCommandHarness(directory, "tui", true, undefined, false);
			await harness.run("prompt reset project");
			expect(harness.confirmCalls).toBe(1);
			expect(readFileSync(promptPath, "utf8")).toBe("KEEP PROJECT");
			expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ promptSource: "project", keep: true });
		} finally {
			if (previous === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("malformed configuration prevents reset from deleting canonical content", async () => {
		const directory = mkdtempSync(join(tmpdir(), "chat-summary-reset-malformed-"));
		const previous = process.env.PI_CONFIG_DIR;
		process.env.PI_CONFIG_DIR = join(directory, "pi-config");
		const configPath = join(directory, "pi-config", "agent", "chat-summary.json");
		const promptPath = join(directory, "pi-config", "agent", "chat-summary-prompt.txt");
		try {
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(configPath, "{ malformed");
			writeFileSync(promptPath, "KEEP GLOBAL");
			const harness = promptCommandHarness(directory, "tui", false);
			await harness.run("prompt reset global");
			expect(readFileSync(configPath, "utf8")).toBe("{ malformed");
			expect(readFileSync(promptPath, "utf8")).toBe("KEEP GLOBAL");
			expect(harness.notifications.join("\n")).toContain("Could not reset guidance");
		} finally {
			if (previous === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("reset removes only owned canonical content and preserves shared and bundled targets", async () => {
		const directory = mkdtempSync(join(tmpdir(), "chat-summary-reset-targets-"));
		const previous = process.env.PI_CONFIG_DIR;
		process.env.PI_CONFIG_DIR = join(directory, "pi-config");
		const globalConfig = join(directory, "pi-config", "agent", "chat-summary.json");
		const projectConfig = join(directory, "project", ".pi", "chat-summary.json");
		const canonical = join(directory, "pi-config", "agent", "chat-summary-prompt.txt");
		const shared = join(directory, "shared.txt");
		const bundledBefore = readFileSync(DEFAULT_SUMMARY_PROMPT_FILE, "utf8");
		try {
			mkdirSync(dirname(globalConfig), { recursive: true });
			mkdirSync(dirname(projectConfig), { recursive: true });
			writeFileSync(shared, "SHARED");
			writeFileSync(canonical, "OWNED");
			writeFileSync(globalConfig, JSON.stringify({ promptFile: shared, promptSource: "global", keep: true }));
			writeFileSync(projectConfig, JSON.stringify({ promptFile: shared }));
			const sharedHarness = promptCommandHarness(directory, "tui", true);
			await sharedHarness.run("prompt reset global");
			expect(readFileSync(shared, "utf8")).toBe("SHARED");
			expect(existsSync(canonical)).toBeFalse();
			expect(JSON.parse(readFileSync(globalConfig, "utf8"))).toEqual({ keep: true });
			expect(JSON.parse(readFileSync(projectConfig, "utf8"))).toEqual({ promptFile: shared });

			writeFileSync(canonical, "OWNED AGAIN");
			writeFileSync(globalConfig, JSON.stringify({ promptFile: DEFAULT_SUMMARY_PROMPT_FILE, promptSource: "global", keep: true }));
			const bundledHarness = promptCommandHarness(directory, "tui", false);
			await bundledHarness.run("prompt reset global");
			expect(readFileSync(DEFAULT_SUMMARY_PROMPT_FILE, "utf8")).toBe(bundledBefore);
			expect(existsSync(canonical)).toBeFalse();
			expect(JSON.parse(readFileSync(globalConfig, "utf8"))).toEqual({ keep: true });
		} finally {
			if (previous === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("RPC, JSON, and print prompt mutations do not edit, open, or create files", async () => {
		for (const mode of ["rpc", "json", "print"] as const) {
			const directory = mkdtempSync(join(tmpdir(), `chat-summary-${mode}-`));
			const previous = process.env.PI_CONFIG_DIR;
			process.env.PI_CONFIG_DIR = join(directory, "pi-config");
			try {
				const harness = promptCommandHarness(directory, mode, true, "SHOULD NOT SAVE");
				await harness.run("prompt edit project");
				await harness.run("prompt open global");
				await harness.run("prompt use project");
				expect(harness.editorCalls).toBe(0);
				expect(harness.execCalls).toBe(0);
				expect(existsSync(join(directory, "project", ".pi"))).toBeFalse();
				expect(existsSync(join(directory, "pi-config"))).toBeFalse();
			} finally {
				if (previous === undefined) delete process.env.PI_CONFIG_DIR;
				else process.env.PI_CONFIG_DIR = previous;
				rmSync(directory, { recursive: true, force: true });
			}
		}
	});
});

describe("summary card", () => {
	test("wraps the complete session summary without a height cap", () => {
		const lines = buildSummaryCardLines(theme, state, 42);
		const rendered = lines.join("\n");
		const compact = rendered.replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " ");
		expect(lines[0]).toContain("╭─ Chat Summary");
		expect(compact).toContain("Both experiences are now implemented.");
		expect(rendered.match(/•/g)?.length).toBe(5);
		expect(rendered).not.toContain("TURN");
		expect(rendered).not.toContain("SESSION");
		expect(compact).toContain("Final validation remains.");
		expect(rendered).not.toContain("…");
		expect(lines.at(-1)).toContain("╰");
	});

	test("wraps long unbroken content instead of truncating it", () => {
		const longToken = "A".repeat(120);
		const rendered = buildSummaryCardLines(
			theme,
			{ ...state, sessionSummary: `${longToken}.` },
			24,
		).join("\n");
		expect(rendered.match(/A/g)?.length).toBe(120);
		expect(rendered).not.toContain("…");
	});

	test("derives a recap for legacy states and shows no section label", () => {
		const legacy = { ...state, recap: undefined };
		expect(summaryRecap(legacy)).toContain("Chat Summary owns summaries.");
		const rendered = buildSummaryCardLines(theme, legacy, 42).join("\n");
		const compact = rendered.replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " ");
		expect(rendered).not.toContain("TURN");
		expect(rendered).not.toContain("SESSION");
		expect(compact).toContain("Final validation remains.");
	});
});
