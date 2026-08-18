import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { extractText, getLatestTurn } from "./messages.ts";

function message(id: string, parentId: string | null, role: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: { role, content: [{ type: "text", text }], timestamp: Date.now() },
	} as SessionEntry;
}

describe("conversation extraction", () => {
	test("extracts text blocks and the latest completed turn", () => {
		const entries = [message("u1", null, "user", "First"), message("a1", "u1", "assistant", "Done")];
		expect(extractText([{ type: "text", text: "hello" }])).toBe("hello");
		const turn = getLatestTurn(entries, { includeToolCalls: false, includeToolResults: false, maxChars: 10_000 });
		expect(turn?.assistantEntryId).toBe("a1");
		expect(turn?.conversationText).toContain("User: First");
		expect(turn?.conversationText).toContain("Assistant: Done");
	});
});
