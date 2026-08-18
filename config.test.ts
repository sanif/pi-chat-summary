import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG, getProjectConfigPath, loadConfig, mergeConfig } from "./config.ts";

describe("Chat Summary configuration", () => {
	test("merges summary and privacy settings", () => {
		const config = mergeConfig(DEFAULT_CONFIG, {
			promptFile: "./custom-summary.txt",
			summaries: { auto: false, session: false, maxConversationChars: 10 },
			privacy: { includeToolCalls: true },
			model: { provider: "openai", id: "gpt-test" },
		});
		expect(config.promptFile).toBe("./custom-summary.txt");
		expect(config.summaries.auto).toBeFalse();
		expect("session" in config.summaries).toBeFalse();
		expect(config.summaries.maxConversationChars).toBe(4_000);
		expect(config.privacy.includeToolCalls).toBeTrue();
		expect(config.model).toMatchObject({ provider: "openai", id: "gpt-test" });
	});

	test("does not probe or read an untrusted project config", () => {
		const cwd = mkdtempSync(join(tmpdir(), "chat-summary-config-trust-"));
		const projectPath = getProjectConfigPath(cwd);
		try {
			mkdirSync(dirname(projectPath), { recursive: true });
			writeFileSync(projectPath, "{ invalid project json");
			const loaded = loadConfig(cwd, false);
			expect(loaded.projectTrusted).toBeFalse();
			expect(loaded.projectLoaded).toBeFalse();
			expect(loaded.projectOverride).toBeUndefined();
			expect(loaded.warnings.some((warning) => warning.includes(projectPath))).toBeFalse();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
