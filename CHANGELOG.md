# Changelog

## Unreleased

## 0.10.0 - 2026-10-09

### Added

- Run Amp threads in a remote Amp Orb by selecting **Orb** under **Execution Environment** in the ACP session configuration. Orb sessions always use the `@ampcode/sdk` transport; set `AMP_ACP_ORB_PROJECT` to override the project inferred from the session directory's git remote.
- Discover agent modes registered by Amp plugins (project, system, personal, and workspace — such as `grok45`) and list them in the Amp Mode selector alongside the built-in `low`, `medium`, `high`, and `ultra` modes. The `amp plugins list` discovery cache expires after 60 seconds per working directory, so a mode plugin installed while the adapter is running shows up in new sessions without a restart.
- Accept any non-empty Amp mode value and pass it through to Amp unchanged (`--mode <key>` or the SDK mode option); Amp is the authority on mode resolution and rejects unknown modes when the prompt runs. A session restored via `session/load` or `session/resume` keeps its persisted mode even when the mode's plugin is temporarily unloaded.
- Resume earlier sessions across amp-acp restarts with `session/load`: the persisted mapping restores the session's permission mode, Amp mode, and execution environment, replays prior messages from `amp threads export` (best-effort), and continues the same Amp thread.
- Persist the exact ACP `S-...` session to Amp `T-...` thread mapping so `session/resume` continues the same thread after an amp-acp restart.
- Advertise lifecycle protocol v1 in ACP capability metadata and expose custom native-metadata and archive/unarchive methods.
- Store mappings atomically in owner-only state storage without prompts, responses, credentials, or Amp settings.
- Answer each `session/prompt` with the turn's token usage (`PromptResponse.usage`), counted from the `usage` Amp reports on each model response. A response streamed as several messages that share an id is counted once. ACP marks the field experimental, and clients that do not read it are unaffected.

### Compatibility and migration

- Existing ACP clients can ignore the extension and continue using standard session and prompt methods.
- Sessions created before 0.10.0 do not have a durable mapping and therefore cannot use restart resume or lifecycle archival. A new session records its mapping on the first successful Amp thread initialization.
- Missing or mismatched mappings fail safely. amp-acp never infers lifecycle ownership from the latest thread, working directory, title, timestamp, or thread listing because those signals can select another CLI, editor, or concurrent session's thread.

### Verification

- Add protocol, persistence, restart-resume, archive/unarchive validation, CLI argument, security, and legacy-session coverage.
- Keep compiled-binary ACP client coverage aligned with real durable Amp thread ID syntax.
