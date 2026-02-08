# AGENTS.md

## Commands
- `bun run build` — Bundle TypeScript to `dist/index.js` (single file, Bun target)
- `bun start` or `bun dist/index.js` — Run the ACP adapter
- `bun run lint` — Type-check with `tsc --noEmit`
- `bun test src/` — Run tests with Bun's built-in test runner

## Architecture
This is an ACP (Agent Client Protocol) adapter that bridges Amp Code to ACP-compatible clients like Zed.

- `src/index.ts` — Entry point, redirects console to stderr (stdout reserved for ACP stream)
- `src/run-acp.ts` — Sets up ACP connection using stdin/stdout JSON streams
- `src/server.ts` — `AmpAcpAgent` class: handles sessions, prompts, MCP config, and calls `@sourcegraph/amp-sdk`
- `src/to-acp.ts` — Converts Amp stream events to ACP `sessionUpdate` notifications
- `src/mcp-config.ts` — Converts ACP MCP server configs to Amp SDK format
- `src/utils.ts` — Node-to-Web stream converters

## Code Style
- TypeScript with ES modules (`"type": "module"` in package.json), use `.js` extension in imports
- Strict mode enabled; avoid `any` and type assertions unless necessary
- Use `console.error` for logging (stdout is for ACP protocol only)
- Error handling: throw `RequestError` from `@agentclientprotocol/sdk` for protocol errors
- Naming: camelCase for variables/functions, PascalCase for classes/interfaces
