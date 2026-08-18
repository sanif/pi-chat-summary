# Changelog

All notable user-facing changes to Chat Summary will be documented here.

## [Unreleased]

### Added

- `/summary prompt` dashboard plus deterministic status, edit, open, copy, use, and confirmed reset subcommands for project, global, and bundled guidance.
- Prompt provenance, trust/readability status, safe fallback reasons, canonical completions, and `/summary help` guidance.
- Global user guidance under the Pi agent configuration directory and automatic trusted-project → global → bundled precedence.

### Changed

- The npm package now uses the scoped name `@sanif/pi-chat-summary`, matching the `@sanif` namespace used by Turnstamp.
- `/summary settings` now has two clear summary controls: `Chat Summary enabled` and `Update automatically`; the redundant `Overall session summary` toggle was removed.
- Bundled summary guidance now separates recap instructions from bullet-point instructions for easier customization.
- Automatic summaries no longer create prompt files. Missing optional canonical guidance falls back silently while configured missing paths and existing invalid files emit bounded warnings.
- Project prompt/config access is disabled for untrusted projects, including automatic generation and prompt-management commands; trust is rechecked before configuration writes.
- Summary generation now uses a dedicated immutable system contract. Editable guidance is an optional preference followed only when compatible with that contract, while conversation, previous-summary, and runtime fields are structured untrusted data and never instructions.
- Legacy `promptFile` values remain supported, with relative paths resolved against the owning project or global configuration scope and provenance preserved during unrelated setting changes.
- Prompt edits and scoped configuration changes are atomic, cancel-safe, and preserve unrelated configuration. Reset never deletes external, shared, or bundled guidance targets.
- Session summaries now begin with a one- or two-sentence recap of the goal and completed work, followed by up to five concise bullet points instead of a paragraph.

## [0.1.0] - 2026-08-11

### Added

- Responsive bordered overall session summary rendered inside Pi's scrolling conversation transcript, with older summary states hidden.
- Session summaries capped at five concise bullet points without TURN or SESSION labels.
- Cumulative updates merge prior beginning-to-current context with each new prompt and response while preserving relevant features and key decisions.
- Summary output uses non-technical product language and omits file paths, filenames, line numbers, code symbols, and low-level implementation details.
- Full-height wrapping without visual truncation.
- Branch-aware state, global and project configuration, diagnostics, and privacy controls.

[Unreleased]: https://github.com/sanif/pi-chat-summary/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sanif/pi-chat-summary/releases/tag/v0.1.0
