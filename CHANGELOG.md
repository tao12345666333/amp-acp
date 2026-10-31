# Changelog

## Unreleased

### Added

- Add a `reasoning-effort` ACP config option for local CLI sessions with `auto`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. amp-acp passes the selection to Amp as the `--features effort:<value>` thread feature and persists it across `session/load` and `session/resume`.
- Stream Amp thinking blocks as ACP `agent_thought_chunk` updates by default. Set `AMP_ACP_DISABLE_THINKING=1` to request plain `--stream-json` output instead.
- Serialize concurrent `session/prompt` requests per session, queue up to 32 follow-up prompts, and cancel both the active turn and queued prompts on `session/cancel`.
- Stream ACP `usage_update` events for the latest model call's context usage. Set `AMP_ACP_CONTEXT_WINDOW_SIZE` to match the model's context window; the default is `200000`.
- Map Amp `max_tokens` and `error_max_turns` to the corresponding ACP stop reasons instead of always returning `end_turn`.
- Report failed, denied, or registry-blocked MCP servers and Amp permission denials as ACP `notice` updates when the client advertises `session.notices`, with an agent-message fallback otherwise.
- Publish a `session_info_update` with a title derived from the first prompt (60 characters, whitespace collapsed) and an `updatedAt` timestamp after every turn. Persist both with the session mapping and restore them on `session/load` and `session/resume`; a title exported by Amp takes precedence during load.
- Advertise and implement `session/list`, `session/delete`, and `session/close`. Listing includes new sessions before their first prompt, filters by `cwd`, sorts by `updatedAt`, and paginates with an opaque cursor. Close cancels active and queued work but keeps the mapping; delete also removes the local mapping and is idempotent. Neither operation deletes the underlying Amp thread.
- Send richer tool updates: tool names, `in_progress` status, raw output, file diffs for edit and write tools, and Amp message IDs on content chunks.
- Convert Amp todo tool calls into ACP `plan` updates with the complete todo list, status and priority mapping, duplicate suppression, and no stray todo tool result.
- Add the `_amp/session/steer` extension for steering a running local session as the next queued turn, with `_amp/session/steer_applied` and `_amp/session/steer_failed` notifications and explicit `failed` outcomes for Orb sessions.

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
