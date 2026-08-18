import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	copyToClipboard,
	DynamicBorder,
	getMarkdownTheme,
	getSettingsListTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Markdown,
	matchesKey,
	SettingsList,
	Text,
	truncateToWidth,
	visibleWidth,
	type AutocompleteItem,
	type SettingItem,
} from "@earendil-works/pi-tui";
import {
	DEFAULT_CONFIG,
	loadConfig,
	type ChatSummaryConfig,
	type LoadedConfig,
} from "./config.ts";
import { getDiagnosticLogPath, writeDiagnosticLog } from "./logger.ts";
import {
	entriesAfter,
	getLatestTurn,
	serializeConversation,
	type ConversationOptions,
} from "./messages.ts";
import {
	conciseRecap,
	DEFAULT_SUMMARY_PROMPT_FILE,
	findSummaryState,
	generateSummaries,
	getGlobalSummaryPromptFile,
	getProjectSummaryPromptFile,
	getSummaryPromptScopePath,
	resolveSummaryPrompt,
	SUMMARY_ENTRY_TYPE,
	summaryBulletItems,
	type ResolvedSummaryPrompt,
	type SummaryState,
} from "./summaries.ts";

const STATUS_KEY = "chat-summary";
const DEMO_SUMMARY_RECAP =
	"The user wanted a small workflow improvement. The main path is working, the rough edges are smoother, and nothing appears to be on fire.";
const DEMO_SESSION_SUMMARY = [
	"The core flow now behaves as expected.",
	"Settings and common edge cases were checked.",
	"Tests pass, including the one that was definitely planned all along.",
	"The current behavior is documented in plain language.",
	"Next: give it one quick visual review and call it done.",
].join(" ");

const SUMMARY_SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "refresh", label: "refresh", description: "Regenerate the cumulative session summary" },
	{ value: "settings", label: "settings", description: "Open Chat Summary feature and privacy toggles" },
	{ value: "prompt", label: "prompt", description: "Manage project, global, or bundled summary guidance" },
	{ value: "status", label: "status", description: "Show whether the summary is ready or updating" },
	{ value: "reload", label: "reload", description: "Reload Chat Summary configuration" },
	{ value: "on", label: "on", description: "Enable Chat Summary" },
	{ value: "off", label: "off", description: "Disable Chat Summary" },
	{ value: "logs", label: "logs", description: "Show the privacy-safe diagnostic log path" },
	{ value: "help", label: "help", description: "Show Chat Summary subcommand help" },
];

const PROMPT_SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "prompt status", label: "prompt status", description: "Show active guidance provenance and fallback status" },
	...(["active", "project", "global"] as const).flatMap((target) => [
		{ value: `prompt edit ${target}`, label: `prompt edit ${target}`, description: "Edit guidance in Pi's editor" },
		{ value: `prompt open ${target}`, label: `prompt open ${target}`, description: "Open guidance externally" },
		{ value: `prompt copy-path ${target}`, label: `prompt copy-path ${target}`, description: "Copy a guidance path" },
		{ value: `prompt copy-content ${target}`, label: `prompt copy-content ${target}`, description: "Copy guidance content" },
	]),
	...(["project", "global", "builtin", "auto"] as const).map((target) => ({
		value: `prompt use ${target}`,
		label: `prompt use ${target}`,
		description: "Choose guidance precedence",
	})),
	...(["project", "global"] as const).map((target) => ({
		value: `prompt reset ${target}`,
		label: `prompt reset ${target}`,
		description: "Remove scoped guidance customization",
	})),
];

export function getSummaryArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const query = prefix.trimStart().toLowerCase();
	const source = query.startsWith("prompt ") ? PROMPT_SUBCOMMANDS : SUMMARY_SUBCOMMANDS;
	const items = source.filter((item) => item.value.startsWith(query));
	return items.length > 0 ? items : null;
}

export function promptOpenCommand(path: string, platform = process.platform): { command: string; args: string[] } {
	if (platform === "darwin") return { command: "open", args: [path] };
	if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", path] };
	return { command: "xdg-open", args: [path] };
}

export function atomicWriteText(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporaryPath, content, { mode: 0o600 });
		renameSync(temporaryPath, path);
	} catch (error) {
		rmSync(temporaryPath, { force: true });
		throw error;
	}
}

export function ensureEditablePromptFile(path: string, bundledPath = DEFAULT_SUMMARY_PROMPT_FILE): void {
	if (existsSync(path)) return;
	atomicWriteText(path, readFileSync(bundledPath, "utf8"));
}

function readJsonObject(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Could not parse Chat Summary configuration ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Configuration must contain a JSON object: ${path}`);
	}
	return value as Record<string, unknown>;
}

export function updatePromptConfig(
	path: string,
	update: (value: Record<string, unknown>) => void,
	beforeWrite?: () => void,
): void {
	const value = readJsonObject(path);
	update(value);
	beforeWrite?.();
	if (Object.keys(value).length === 0) {
		rmSync(path, { force: true });
		return;
	}
	atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function conversationOptions(config: ChatSummaryConfig): ConversationOptions {
	return {
		includeToolCalls: config.privacy.includeToolCalls,
		includeToolResults: config.privacy.includeToolResults,
		maxChars: config.summaries.maxConversationChars,
	};
}

function splitLongWord(word: string, width: number): string[] {
	const chunks: string[] = [];
	let current = "";
	for (const character of [...word]) {
		if (current && visibleWidth(`${current}${character}`) > width) {
			chunks.push(current);
			current = character;
		} else {
			current += character;
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

function wrapText(text: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
	if (words.length === 0) return [];
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		const chunks = visibleWidth(word) > safeWidth ? splitLongWord(word, safeWidth) : [word];
		for (const [index, chunk] of chunks.entries()) {
			const candidate = current && index === 0 ? `${current} ${chunk}` : chunk;
			if (visibleWidth(candidate) <= safeWidth) {
				current = candidate;
			} else {
				if (current) lines.push(current);
				current = chunk;
			}
			if (visibleWidth(current) === safeWidth) {
				lines.push(current);
				current = "";
			}
		}
	}
	if (current) lines.push(current);
	return lines;
}

export function summaryRecap(state: SummaryState): string {
	return conciseRecap(state.recap, 2) || summaryBulletItems(state.sessionSummary, 2).join(" ");
}

export function buildSummaryCardLines(
	theme: ExtensionContext["ui"]["theme"],
	state: SummaryState,
	width: number,
): string[] {
	if (width < 8) return [truncateToWidth("Summary", width, "")];
	const innerWidth = width - 2;
	const contentWidth = Math.max(1, innerWidth - 2);
	const border = (text: string): string => theme.fg("accent", text);
	const row = (content: string): string => {
		const clipped = truncateToWidth(content, contentWidth, "");
		return `${border("│")} ${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))} ${border("│")}`;
	};
	const top = truncateToWidth("─ Chat Summary ", innerWidth, "");
	const lines = [border(`╭${top}${"─".repeat(Math.max(0, innerWidth - visibleWidth(top)))}╮`)];
	const recap = summaryRecap(state);
	for (const line of wrapText(recap, contentWidth)) {
		lines.push(row(theme.fg("muted", theme.italic(line))));
	}
	const items = summaryBulletItems(state.sessionSummary);
	if (recap && items.length > 0) lines.push(row(""));
	for (const item of items) {
		const wrapped = wrapText(item, Math.max(1, contentWidth - 2));
		for (const [index, line] of wrapped.entries()) {
			const bulletLine = `${index === 0 ? "• " : "  "}${line}`;
			lines.push(row(theme.fg("dim", theme.italic(bulletLine))));
		}
	}
	lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
	return lines;
}

async function showSummaryPanel(state: SummaryState | undefined, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/summary requires TUI mode", "warning");
		return;
	}
	if (!state?.sessionSummary) {
		ctx.ui.notify("No summary is available yet. Run /summary refresh.", "warning");
		return;
	}
	const recap = summaryRecap(state);
	const markdown = recap ? `${recap}\n\n${state.sessionSummary}` : state.sessionSummary;
	await ctx.ui.custom((_tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Chat Summary")), 1, 0));
		container.addChild(new Markdown(markdown, 1, 1, getMarkdownTheme()));
		container.addChild(new Text(theme.fg("dim", "Enter or Esc closes"), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
			},
		};
	});
}

function settingValue(value: boolean): "enabled" | "disabled" {
	return value ? "enabled" : "disabled";
}

function settingsItems(config: ChatSummaryConfig): SettingItem[] {
	return [
		{ id: "enabled", label: "Chat Summary enabled", currentValue: settingValue(config.enabled), values: ["enabled", "disabled"] },
		{ id: "summaries.auto", label: "Update automatically", currentValue: settingValue(config.summaries.auto), values: ["enabled", "disabled"] },
		{ id: "privacy.includeToolCalls", label: "Include tool call names/args", currentValue: settingValue(config.privacy.includeToolCalls), values: ["enabled", "disabled"] },
		{ id: "privacy.includeToolResults", label: "Include tool result excerpts", currentValue: settingValue(config.privacy.includeToolResults), values: ["enabled", "disabled"] },
		{ id: "diagnostics.enabled", label: "Privacy-safe diagnostics", currentValue: settingValue(config.diagnostics.enabled), values: ["enabled", "disabled"] },
	];
}

function applyRawSetting(value: Record<string, unknown>, id: string, enabled: boolean): void {
	if (id === "enabled") {
		value.enabled = enabled;
		return;
	}
	const [section, key] = id.split(".");
	if (!section || !key) throw new Error(`Unknown Chat Summary setting: ${id}`);
	const current = value[section];
	const nested = typeof current === "object" && current !== null && !Array.isArray(current)
		? current as Record<string, unknown>
		: {};
	nested[key] = enabled;
	value[section] = nested;
}

export default function chatSummary(pi: ExtensionAPI): void {
	let loaded: LoadedConfig | undefined;
	let config = structuredClone(DEFAULT_CONFIG);
	let state: SummaryState | undefined;
	let isSummarizing = false;
	let controller: AbortController | undefined;
	let generation = 0;
	let sessionGeneration = 0;

	pi.registerEntryRenderer<SummaryState>(SUMMARY_ENTRY_TYPE, (entry, _options, theme) => ({
		render: (width: number) => {
			const entryState = entry.data;
			if (
				!config.enabled ||
				!entryState?.sessionSummary ||
				entryState.updatedAt !== state?.updatedAt ||
				entryState.lastProcessedEntryId !== state.lastProcessedEntryId
			) return [];
			return buildSummaryCardLines(theme, entryState, width);
		},
		invalidate: () => {},
	}));

	const reloadConfig = (ctx: ExtensionContext, announceWarnings = true): void => {
		loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		config = loaded.config;
		if (announceWarnings) for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
	};
	const persistChangedSetting = (ctx: ExtensionContext, id: string, enabled: boolean): void => {
		const trustedAtLoad = ctx.isProjectTrusted();
		const latest = loadConfig(ctx.cwd, trustedAtLoad);
		let projectTarget = trustedAtLoad && latest.projectLoaded;
		// Trust is deliberately sampled again immediately before selecting a write target.
		if (!ctx.isProjectTrusted()) projectTarget = false;
		const writeGlobal = (): void => updatePromptConfig(
			latest.globalPath,
			(value) => applyRawSetting(value, id, enabled),
			() => { ctx.isProjectTrusted(); },
		);
		if (!projectTarget) {
			writeGlobal();
		} else {
			const trustRevoked = new Error("Project trust was revoked");
			try {
				updatePromptConfig(latest.projectPath, (value) => applyRawSetting(value, id, enabled), () => {
					if (!ctx.isProjectTrusted()) throw trustRevoked;
				});
			} catch (error) {
				if (error !== trustRevoked) throw error;
				writeGlobal();
			}
		}
		reloadConfig(ctx, false);
	};
	const restoreState = (ctx: ExtensionContext): void => {
		state = findSummaryState(ctx.sessionManager.getBranch());
	};

	const refreshSummaries = async (
		ctx: ExtensionContext,
		options: { force?: boolean; notify?: boolean } = {},
	): Promise<void> => {
		// Re-evaluate trust before any automatic prompt/config resolution.
		reloadConfig(ctx, false);
		if (!config.enabled) return;
		const branch = ctx.sessionManager.getBranch();
		const previous = findSummaryState(branch);
		const turn = getLatestTurn(branch, conversationOptions(config));
		if (!turn) {
			if (options.notify) ctx.ui.notify("No completed turn was found", "warning");
			return;
		}
		if (!options.force && previous?.lastProcessedEntryId === turn.assistantEntryId) return;

		const run = ++generation;
		controller?.abort();
		const currentController = new AbortController();
		controller = currentController;
		const capturedSession = ctx.sessionManager.getSessionId();
		const capturedSessionGeneration = sessionGeneration;
		const capturedLeaf = ctx.sessionManager.getLeafId();
		const startedAt = Date.now();
		const optionsForConversation = conversationOptions(config);
		const incrementalEntries = !options.force && previous
			? entriesAfter(branch, previous.lastProcessedEntryId)
			: undefined;
		const conversationEntries: SessionEntry[] = incrementalEntries ?? ctx.sessionManager.buildContextEntries();
		const newConversationText = serializeConversation(conversationEntries, optionsForConversation) || turn.conversationText;

		isSummarizing = true;
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, "Summarizing…");
		writeDiagnosticLog(config, "summary_started", {
			sessionId: capturedSession,
			assistantEntryId: turn.assistantEntryId,
			leafId: capturedLeaf,
		});
		try {
			const generated = await generateSummaries(ctx, config, {
				previousState: previous,
				latestTurnText: turn.conversationText,
				newConversationText,
				signal: currentController.signal,
			}, loaded);
			const currentTurn = getLatestTurn(ctx.sessionManager.getBranch(), optionsForConversation);
			if (
				currentController.signal.aborted ||
				run !== generation ||
				capturedSessionGeneration !== sessionGeneration ||
				ctx.sessionManager.getSessionId() !== capturedSession ||
				currentTurn?.assistantEntryId !== turn.assistantEntryId
			) return;
			state = {
				version: 1,
				recap: generated.recap,
				sessionSummary: generated.sessionSummary,
				lastProcessedEntryId: turn.assistantEntryId,
				updatedAt: new Date().toISOString(),
			};
			pi.appendEntry<SummaryState>(SUMMARY_ENTRY_TYPE, state);
			writeDiagnosticLog(config, "summary_saved", {
				sessionId: capturedSession,
				assistantEntryId: turn.assistantEntryId,
				leafAdvancedByOtherExtensions: ctx.sessionManager.getLeafId() !== capturedLeaf,
				durationMs: Date.now() - startedAt,
			});
			if (options.notify) ctx.ui.notify("Chat Summary refreshed", "info");
		} catch (error) {
			if (currentController.signal.aborted) return;
			const message = error instanceof Error ? error.message : String(error);
			writeDiagnosticLog(config, "summary_error", {
				sessionId: capturedSession,
				assistantEntryId: turn.assistantEntryId,
				durationMs: Date.now() - startedAt,
				error: message.slice(0, 500),
			});
			ctx.ui.notify(`Chat Summary failed: ${message}`, "error");
		} finally {
			if (run === generation) {
				controller = undefined;
				isSummarizing = false;
				if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		}
	};

	const promptResolution = (ctx: ExtensionContext): ResolvedSummaryPrompt => {
		reloadConfig(ctx, false);
		if (!loaded) throw new Error("Chat Summary configuration is unavailable");
		return resolveSummaryPrompt({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted(), loaded, config });
	};

	const promptStatusText = (prompt: ResolvedSummaryPrompt): string => [
		`Active: ${prompt.scope} (${prompt.source})`,
		`Path: ${prompt.path}`,
		`Trust: ${prompt.scope === "project" ? "trusted project" : "project content not required"}`,
		`Status: ${prompt.readable ? "readable" : prompt.reason ?? "unavailable"}`,
		`Fallback: ${prompt.fallbackReason ?? "none"}`,
	].join("\n");

	const requirePromptTui = (ctx: ExtensionCommandContext): boolean => {
		if (ctx.mode === "tui") return true;
		ctx.ui.notify("Prompt changes, external open, and clipboard actions require TUI mode; print/JSON have no prompt side effects.", "warning");
		return false;
	};

	const scopedPromptPath = (
		ctx: ExtensionCommandContext,
		scope: "project" | "global",
	): string | undefined => {
		if (scope === "project" && !ctx.isProjectTrusted()) {
			ctx.ui.notify("Project prompt access is disabled until this project is trusted", "warning");
			return undefined;
		}
		if (!loaded) reloadConfig(ctx, false);
		return loaded ? getSummaryPromptScopePath(scope, loaded, ctx.cwd) : undefined;
	};

	const promptPathFor = (
		ctx: ExtensionCommandContext,
		target: "active" | "project" | "global",
		prompt: ResolvedSummaryPrompt,
	): string | undefined => target === "active"
		? prompt.path
		: scopedPromptPath(ctx, target);

	const setPromptSelection = (
		ctx: ExtensionCommandContext,
		selection: "project" | "global" | "builtin" | "auto",
	): void => {
		let trusted = ctx.isProjectTrusted();
		let latest = loadConfig(ctx.cwd, trusted);
		if (trusted && !ctx.isProjectTrusted()) {
			trusted = false;
			latest = loadConfig(ctx.cwd, false);
		}
		if (selection === "project" && !trusted) throw new Error("Project prompt access requires a trusted project");
		const configPath = trusted ? latest.projectPath : latest.globalPath;
		updatePromptConfig(configPath, (value) => {
			if (selection === "auto") delete value.promptSource;
			else value.promptSource = selection;
		}, () => {
			if (trusted && !ctx.isProjectTrusted()) {
				throw new Error("Project trust was revoked; project configuration was not changed");
			}
			if (!trusted) ctx.isProjectTrusted();
		});
	};

	const handlePromptCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const tokens = args.trim() ? args.trim().toLowerCase().split(/\s+/) : [];
		const [verb = "", rawTarget = ""] = tokens;
		const targetUsage = `Usage: /summary prompt ${verb} [active|project|global]`;
		if (verb === "status" && tokens.length !== 1) {
			ctx.ui.notify("Usage: /summary prompt status", "warning");
			return;
		}
		if (["edit", "open", "copy-path", "copy-content"].includes(verb) && tokens.length > 2) {
			ctx.ui.notify(targetUsage, "warning");
			return;
		}
		if (verb === "use" && tokens.length !== 2) {
			ctx.ui.notify("Usage: /summary prompt use project|global|builtin|auto", "warning");
			return;
		}
		if (verb === "reset" && tokens.length !== 2) {
			ctx.ui.notify("Usage: /summary prompt reset project|global", "warning");
			return;
		}
		let prompt: ResolvedSummaryPrompt;
		try {
			prompt = promptResolution(ctx);
		} catch (error) {
			ctx.ui.notify(`Could not resolve Chat Summary guidance: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		if (verb === "status") {
			ctx.ui.notify(promptStatusText(prompt), "info");
			return;
		}
		if (!verb) {
			if (!requirePromptTui(ctx)) return;
			const choice = await ctx.ui.select(`Chat Summary prompt\n${promptStatusText(prompt)}`, [
				"Edit active", "Open active", "Copy active path", "Copy active content",
				"Use project", "Use global", "Use bundled", "Use automatic precedence", "Reset project", "Reset global",
			]);
			if (!choice) return;
			const dashboardCommands: Record<string, string> = {
				"Edit active": "edit active", "Open active": "open active",
				"Copy active path": "copy-path active", "Copy active content": "copy-content active",
				"Use project": "use project", "Use global": "use global", "Use bundled": "use builtin",
				"Use automatic precedence": "use auto", "Reset project": "reset project", "Reset global": "reset global",
			};
			await handlePromptCommand(dashboardCommands[choice] ?? "status", ctx);
			return;
		}
		if (!requirePromptTui(ctx)) return;

		if (verb === "edit" || verb === "open" || verb === "copy-path" || verb === "copy-content") {
			const target = rawTarget || "active";
			if (target !== "active" && target !== "project" && target !== "global") {
				ctx.ui.notify(`Usage: /summary prompt ${verb} [active|project|global]`, "warning");
				return;
			}
			const activeIsBundled = target === "active" && (
				prompt.scope === "bundled" || prompt.path === DEFAULT_SUMMARY_PROMPT_FILE
			);
			if (verb === "open" && activeIsBundled) {
				ctx.ui.notify("Bundled Chat Summary guidance is read-only. Use /summary prompt edit active to create an editable copy, or open another scope.", "warning");
				return;
			}
			let path = promptPathFor(ctx, target, prompt);
			if (!path) return;
			const customizesBundled = verb === "edit" && activeIsBundled;
			const editsProjectGuidance = verb === "edit" && (
				target === "project" || (target === "active" && prompt.scope === "project")
			);
			if (customizesBundled && loaded) path = getGlobalSummaryPromptFile(loaded.globalPath);
			try {
				if (verb === "edit") {
					const prefill = existsSync(path) ? readFileSync(path, "utf8") : prompt.content;
					const edited = await ctx.ui.editor(`Edit Chat Summary guidance: ${path}`, prefill);
					if (edited === undefined) return;
					if (editsProjectGuidance && !ctx.isProjectTrusted()) {
						ctx.ui.notify("Project trust was revoked; project guidance was not changed", "warning");
						return;
					}
					atomicWriteText(path, edited);
					if (customizesBundled) {
						if (
							loaded &&
							typeof loaded.globalOverride.promptFile === "string" &&
							getSummaryPromptScopePath("global", loaded, ctx.cwd) === DEFAULT_SUMMARY_PROMPT_FILE
						) {
							updatePromptConfig(loaded.globalPath, (value) => { delete value.promptFile; }, () => {
								ctx.isProjectTrusted();
							});
						}
						setPromptSelection(ctx, "global");
					}
					ctx.ui.notify(`Saved Chat Summary guidance: ${path}`, "info");
				} else if (verb === "open") {
					if (!existsSync(path) && target !== "active") atomicWriteText(path, prompt.content);
					const opener = promptOpenCommand(path);
					const result = await pi.exec(opener.command, opener.args, { cwd: ctx.cwd, timeout: 10_000 });
					if (result.code !== 0) throw new Error(result.stderr || `exit ${result.code}`);
					ctx.ui.notify(`Opened Chat Summary guidance: ${path}`, "info");
				} else {
					const value = verb === "copy-path" ? path : readFileSync(path, "utf8");
					await copyToClipboard(value);
					ctx.ui.notify(`Copied Chat Summary ${verb === "copy-path" ? "path" : "guidance"}`, "info");
				}
			} catch (error) {
				ctx.ui.notify(`Could not ${verb.replace("-", " ")} Chat Summary guidance: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			return;
		}

		if (verb === "use") {
			if (rawTarget !== "project" && rawTarget !== "global" && rawTarget !== "builtin" && rawTarget !== "auto") {
				ctx.ui.notify("Usage: /summary prompt use project|global|builtin|auto", "warning");
				return;
			}
			try {
				if (rawTarget === "project" || rawTarget === "global") {
					const path = scopedPromptPath(ctx, rawTarget);
					if (!path) return;
					if (!existsSync(path)) atomicWriteText(path, prompt.content);
				}
				setPromptSelection(ctx, rawTarget);
				reloadConfig(ctx, false);
				ctx.ui.notify(`Chat Summary guidance selection: ${rawTarget}`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not change prompt selection: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			return;
		}

		if (verb === "reset") {
			if (rawTarget !== "project" && rawTarget !== "global") {
				ctx.ui.notify("Usage: /summary prompt reset project|global", "warning");
				return;
			}
			if (!loaded) return;
			if (rawTarget === "project" && !ctx.isProjectTrusted()) {
				ctx.ui.notify("Project prompt access is disabled until this project is trusted", "warning");
				return;
			}
			const canonicalPath = rawTarget === "project"
				? getProjectSummaryPromptFile(ctx.cwd)
				: getGlobalSummaryPromptFile(loaded.globalPath);
			if (!await ctx.ui.confirm(
				"Reset Chat Summary guidance?",
				`Remove ${rawTarget} prompt overrides and delete its owned guidance file ${canonicalPath} if present?`,
			)) return;
			try {
				const configPath = rawTarget === "project" ? loaded.projectPath : loaded.globalPath;
				updatePromptConfig(configPath, (value) => {
					delete value.promptFile;
					delete value.promptSource;
				}, () => {
					if (rawTarget === "project" && !ctx.isProjectTrusted()) {
						throw new Error("Project trust was revoked; project configuration was not changed");
					}
					if (rawTarget === "global") ctx.isProjectTrusted();
				});
				// Configuration parsing and mutation must succeed before prompt content is removed.
				rmSync(canonicalPath, { force: true });
				reloadConfig(ctx, false);
				ctx.ui.notify(`Reset ${rawTarget} Chat Summary guidance`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not reset guidance: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			return;
		}
		ctx.ui.notify("Usage: /summary prompt [status|edit|open|copy-path|copy-content|use|reset]", "warning");
	};

	const showSettings = async (ctx: ExtensionCommandContext): Promise<void> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/summary settings requires TUI mode", "warning");
			return;
		}
		await ctx.ui.custom((tui, theme, _keybindings, done) => {
			const items = settingsItems(config);
			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("Chat Summary settings")), 1, 0));
			const list = new SettingsList(items, Math.min(items.length + 1, 12), getSettingsListTheme(), (id, value) => {
				try {
					persistChangedSetting(ctx, id, value === "enabled");
				} catch (error) {
					ctx.ui.notify(`Could not save settings: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			}, () => done(undefined));
			container.addChild(list);
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput?.(data);
					tui.requestRender();
				},
			};
		});
	};

	pi.registerCommand("summary", {
		description: "Cumulative summary (type a subcommand for help)",
		getArgumentCompletions: getSummaryArgumentCompletions,
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (!command) {
				await showSummaryPanel(state, ctx);
				return;
			}
			if (command === "refresh") {
				await refreshSummaries(ctx, { force: true, notify: true });
				return;
			}
			if (command === "demo") {
				if (!config.enabled) {
					ctx.ui.notify("Chat Summary is off; enable it before loading the demo", "warning");
					return;
				}
				controller?.abort();
				controller = undefined;
				generation++;
				isSummarizing = false;
				if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
				const latest = getLatestTurn(ctx.sessionManager.getBranch(), conversationOptions(config));
				state = {
					version: 1,
					recap: DEMO_SUMMARY_RECAP,
					sessionSummary: DEMO_SESSION_SUMMARY,
					lastProcessedEntryId: latest?.assistantEntryId ?? ctx.sessionManager.getLeafId() ?? "chat-summary-demo",
					updatedAt: new Date().toISOString(),
				};
				pi.appendEntry<SummaryState>(SUMMARY_ENTRY_TYPE, state);
				ctx.ui.notify("Chat Summary demo loaded; the next normal update will replace it", "info");
				return;
			}
			if (command === "settings" || command === "config") {
				await showSettings(ctx);
				return;
			}
			if (command === "reload") {
				reloadConfig(ctx);
				ctx.ui.notify("Chat Summary configuration reloaded", "info");
				return;
			}
			if (command === "on" || command === "off") {
				persistChangedSetting(ctx, "enabled", command === "on");
				ctx.ui.notify(`Chat Summary ${command === "on" ? "enabled" : "disabled"}`, "info");
				return;
			}
			if (command === "status") {
				ctx.ui.notify(`Chat Summary ${config.enabled ? "on" : "off"}; ${isSummarizing ? "running" : state ? "ready" : "waiting"}`, "info");
				return;
			}
			if (command === "prompt" || command.startsWith("prompt ")) {
				await handlePromptCommand(command.slice("prompt".length).trim(), ctx);
				return;
			}
			if (command === "logs") {
				ctx.ui.notify(`Chat Summary log: ${getDiagnosticLogPath()}`, "info");
				return;
			}
			if (command === "help") {
				ctx.ui.notify("/summary refresh · settings · prompt [status|edit [active|project|global]|open [active|project|global]|copy-path [active|project|global]|copy-content [active|project|global]|use project|global|builtin|auto|reset project|global] · status · reload · on · off · logs", "info");
				return;
			}
			ctx.ui.notify("Unknown subcommand. Try /summary help, or type /summary and choose a helper item.", "warning");
		},
	});

	pi.on("session_start", (event, ctx) => {
		controller?.abort();
		generation++;
		sessionGeneration++;
		isSummarizing = false;
		reloadConfig(ctx);
		restoreState(ctx);
		writeDiagnosticLog(config, "session_started", {
			reason: event.reason,
			mode: ctx.mode,
			sessionId: ctx.sessionManager.getSessionId(),
			hasSummary: Boolean(state),
		});
		if (event.reason === "reload" && config.enabled) {
			ctx.ui.notify("Chat Summary loaded · summaries scroll with the conversation", "info");
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		controller?.abort();
		generation++;
		sessionGeneration++;
		isSummarizing = false;
		reloadConfig(ctx, false);
		restoreState(ctx);
	});

	pi.on("agent_start", () => {
		controller?.abort();
		generation++;
		isSummarizing = false;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (config.enabled && config.summaries.auto) void refreshSummaries(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		controller?.abort();
		controller = undefined;
		generation++;
		sessionGeneration++;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
