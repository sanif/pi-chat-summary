import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChatSummaryConfig } from "./config.ts";
import { getGlobalConfigPath } from "./config.ts";

export type DiagnosticDetails = Record<string, boolean | number | string | null | undefined>;

export function getDiagnosticLogPath(): string {
	return join(dirname(getGlobalConfigPath()), "chat-summary.log");
}

function rotateLog(path: string, maxBytes: number): void {
	if (!existsSync(path) || statSync(path).size < maxBytes) return;
	const previous = `${path}.1`;
	if (existsSync(previous)) unlinkSync(previous);
	renameSync(path, previous);
}

/** Append privacy-safe lifecycle metadata. Never pass conversation or summary text. */
export function writeDiagnosticLog(
	config: ChatSummaryConfig,
	event: string,
	details: DiagnosticDetails = {},
): void {
	if (!config.diagnostics.enabled) return;
	try {
		const path = getDiagnosticLogPath();
		mkdirSync(dirname(path), { recursive: true });
		rotateLog(path, config.diagnostics.maxBytes);
		appendFileSync(path, `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
	} catch {
		// Diagnostics must never affect user-facing behavior.
	}
}
