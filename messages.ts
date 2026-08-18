import type { SessionEntry } from "@earendil-works/pi-coding-agent";

interface ContentBlock {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

interface MessageLike {
	role?: string;
	content?: unknown;
	toolName?: string;
	isError?: boolean;
}

export interface ConversationOptions {
	includeToolCalls: boolean;
	includeToolResults: boolean;
	maxChars: number;
}

export interface LatestTurn {
	assistantEntryId: string;
	assistantText: string;
	conversationText: string;
}

export function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (!part || typeof part !== "object") return [];
			const block = part as ContentBlock;
			return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
		})
		.join("\n")
		.trim();
}

function extractToolCalls(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) => {
		if (!part || typeof part !== "object") return [];
		const block = part as ContentBlock;
		if (block.type !== "toolCall" || typeof block.name !== "string") return [];
		const args = block.arguments && typeof block.arguments === "object" ? JSON.stringify(block.arguments) : "{}";
		return [`Tool call: ${block.name} ${args}`];
	});
}

function messageFromEntry(entry: SessionEntry): MessageLike | undefined {
	return entry.type === "message" ? (entry.message as MessageLike) : undefined;
}

export function getLatestAssistantResponse(entries: SessionEntry[]): { entryId: string; text: string } | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!entry) continue;
		const message = messageFromEntry(entry);
		if (message?.role !== "assistant") continue;
		const text = extractText(message.content);
		if (text) return { entryId: entry.id, text };
	}
	return undefined;
}

export function getLatestTurn(entries: SessionEntry[], options: ConversationOptions): LatestTurn | undefined {
	const latestAssistant = getLatestAssistantResponse(entries);
	if (!latestAssistant) return undefined;
	const assistantIndex = entries.findIndex((entry) => entry.id === latestAssistant.entryId);
	if (assistantIndex < 0) return undefined;
	let userIndex = -1;
	for (let index = assistantIndex - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry && messageFromEntry(entry)?.role === "user" && extractText(messageFromEntry(entry)?.content)) {
			userIndex = index;
			break;
		}
	}
	if (userIndex < 0) return undefined;
	return {
		assistantEntryId: latestAssistant.entryId,
		assistantText: latestAssistant.text,
		conversationText: serializeConversation(entries.slice(userIndex, assistantIndex + 1), options),
	};
}

export function entriesAfter(entries: SessionEntry[], entryId: string): SessionEntry[] | undefined {
	const index = entries.findIndex((entry) => entry.id === entryId);
	return index >= 0 ? entries.slice(index + 1) : undefined;
}

export function serializeConversation(entries: SessionEntry[], options: ConversationOptions): string {
	const sections: string[] = [];
	for (const entry of entries) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			if (entry.summary.trim()) sections.push(`Earlier context summary:\n${entry.summary.trim()}`);
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message as MessageLike;
		const text = extractText(message.content);
		if (message.role === "user") {
			if (text) sections.push(`User: ${text}`);
		} else if (message.role === "assistant") {
			const lines: string[] = [];
			if (text) lines.push(`Assistant: ${text}`);
			if (options.includeToolCalls) lines.push(...extractToolCalls(message.content));
			if (lines.length > 0) sections.push(lines.join("\n"));
		} else if (message.role === "toolResult" && options.includeToolResults) {
			const resultText = text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
			if (resultText) sections.push(`Tool result${message.toolName ? ` (${message.toolName})` : ""}${message.isError ? " [error]" : ""}: ${resultText}`);
		}
	}
	return limitConversation(sections.join("\n\n"), options.maxChars);
}

export function limitConversation(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const marker = "\n\n[… middle omitted …]\n\n";
	const available = Math.max(0, maxChars - marker.length);
	const headLength = Math.floor(available * 0.3);
	return `${text.slice(0, headLength)}${marker}${text.slice(-(available - headLength))}`;
}
