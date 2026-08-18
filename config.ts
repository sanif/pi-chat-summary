import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high";

export interface ChatSummaryConfig {
	enabled: boolean;
	promptFile?: string;
	summaries: {
		auto: boolean;
		maxConversationChars: number;
	};
	model: {
		provider?: string;
		id?: string;
		reasoningEffort: ReasoningEffort;
		maxTokens: number;
	};
	privacy: {
		includeToolCalls: boolean;
		includeToolResults: boolean;
	};
	diagnostics: {
		enabled: boolean;
		maxBytes: number;
	};
}

export interface LoadedConfig {
	config: ChatSummaryConfig;
	globalPath: string;
	projectPath: string;
	projectTrusted: boolean;
	projectLoaded: boolean;
	globalOverride: Record<string, unknown>;
	projectOverride?: Record<string, unknown>;
	warnings: string[];
}

export const DEFAULT_CONFIG: ChatSummaryConfig = {
	enabled: true,
	summaries: {
		auto: true,
		maxConversationChars: 24_000,
	},
	model: {
		reasoningEffort: "minimal",
		maxTokens: 1_200,
	},
	privacy: {
		includeToolCalls: false,
		includeToolResults: false,
	},
	diagnostics: {
		enabled: true,
		maxBytes: 262_144,
	},
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const booleanValue = (value: unknown, fallback: boolean): boolean =>
	typeof value === "boolean" ? value : fallback;
const boundedInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(minimum, Math.min(maximum, Math.round(value)));
};
const optionalString = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
};
const reasoningEffort = (value: unknown, fallback: ReasoningEffort): ReasoningEffort => {
	const allowed: ReasoningEffort[] = ["off", "minimal", "low", "medium", "high"];
	return typeof value === "string" && allowed.includes(value as ReasoningEffort)
		? (value as ReasoningEffort)
		: fallback;
};

export function mergeConfig(base: ChatSummaryConfig, override: unknown): ChatSummaryConfig {
	if (!isRecord(override)) return structuredClone(base);
	const next = structuredClone(base);
	const summaries = isRecord(override.summaries) ? override.summaries : {};
	const model = isRecord(override.model) ? override.model : {};
	const privacy = isRecord(override.privacy) ? override.privacy : {};
	const diagnostics = isRecord(override.diagnostics) ? override.diagnostics : {};

	next.enabled = booleanValue(override.enabled, next.enabled);
	if ("promptFile" in override) {
		const promptFile = optionalString(override.promptFile);
		if (promptFile) next.promptFile = promptFile;
		else delete next.promptFile;
	}
	next.summaries.auto = booleanValue(summaries.auto, next.summaries.auto);
	next.summaries.maxConversationChars = boundedInteger(
		summaries.maxConversationChars,
		next.summaries.maxConversationChars,
		4_000,
		200_000,
	);

	const provider = optionalString(model.provider);
	const id = optionalString(model.id);
	if (provider && id) {
		next.model.provider = provider;
		next.model.id = id;
	} else if ("provider" in model || "id" in model) {
		delete next.model.provider;
		delete next.model.id;
	}
	next.model.reasoningEffort = reasoningEffort(model.reasoningEffort, next.model.reasoningEffort);
	next.model.maxTokens = boundedInteger(model.maxTokens, next.model.maxTokens, 256, 8_192);
	next.privacy.includeToolCalls = booleanValue(privacy.includeToolCalls, next.privacy.includeToolCalls);
	next.privacy.includeToolResults = booleanValue(privacy.includeToolResults, next.privacy.includeToolResults);
	next.diagnostics.enabled = booleanValue(diagnostics.enabled, next.diagnostics.enabled);
	next.diagnostics.maxBytes = boundedInteger(diagnostics.maxBytes, next.diagnostics.maxBytes, 16_384, 10_485_760);
	return next;
}

export function getGlobalConfigPath(): string {
	const configRoot = process.env.PI_CONFIG_DIR?.trim() || join(homedir(), CONFIG_DIR_NAME);
	return join(configRoot, "agent", "chat-summary.json");
}

export function getProjectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "chat-summary.json");
}

function boundedError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\s+/g, " ").slice(0, 300);
}

function readConfigFile(path: string, warnings: string[]): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(parsed) ? parsed : {};
	} catch (error) {
		warnings.push(`Could not read ${path}: ${boundedError(error)}`);
		return {};
	}
}

export function loadConfig(cwd: string, allowProjectConfig = true): LoadedConfig {
	const warnings: string[] = [];
	const globalPath = getGlobalConfigPath();
	const projectPath = getProjectConfigPath(cwd);
	const globalOverride = readConfigFile(globalPath, warnings);
	let config = mergeConfig(DEFAULT_CONFIG, globalOverride);
	// Trust is checked before even probing the project-local path.
	const projectLoaded = allowProjectConfig ? existsSync(projectPath) : false;
	const projectOverride = projectLoaded ? readConfigFile(projectPath, warnings) : undefined;
	if (projectOverride) config = mergeConfig(config, projectOverride);
	return {
		config,
		globalPath,
		projectPath,
		projectTrusted: allowProjectConfig,
		projectLoaded,
		globalOverride,
		projectOverride,
		warnings,
	};
}

export function saveConfig(path: string, config: ChatSummaryConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporaryPath, path);
}
