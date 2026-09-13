# Changelog

## 0.10.0 - 2026-08-27

### Added

- Persist the exact ACP `S-...` session to Amp `T-...` thread mapping so `session/resume` continues the same thread after an amp-acp restart.
- Advertise lifecycle protocol v1 in ACP capability metadata and expose custom native-metadata and archive/unarchive methods.
- Store mappings atomically in owner-only state storage without prompts, responses, credentials, or Amp settings.

### Compatibility and migration

- Existing ACP clients can ignore the extension and continue using standard session and prompt methods.
- Sessions created before 0.10.0 do not have a durable mapping and therefore cannot use restart resume or lifecycle archival. A new session records its mapping on the first successful Amp thread initialization.
- Missing or mismatched mappings fail safely. amp-acp never infers lifecycle ownership from the latest thread, working directory, title, timestamp, or thread listing because those signals can select another CLI, editor, or concurrent session's thread.

### Verification

- Add protocol, persistence, restart-resume, archive/unarchive validation, CLI argument, security, and legacy-session coverage.
- Keep compiled-binary ACP client coverage aligned with real durable Amp thread ID syntax.
