# AGENTS.md

## Commands
- `npm start` or `node src/index.js` — Run the ACP adapter
- `npm run lint` — Lint (currently a no-op)
- `npm test` — Test (currently a no-op)

## Architecture
This is an ACP (Agent Client Protocol) adapter that bridges Amp Code to ACP-compatible clients like Zed.

- `src/index.js` — Entry point, redirects console to stderr (stdout reserved for ACP stream)
- `src/run-acp.js` — Sets up ACP connection using stdin/stdout JSON streams
- `src/server.js` — `AmpAcpAgent` class: handles sessions, prompts, MCP config, and calls `@sourcegraph/amp-sdk`
- `src/to-acp.js` — Converts Amp stream events to ACP `sessionUpdate` notifications
- `src/utils.js` — Node-to-Web stream converters

## Code Style
- ES modules (`"type": "module"` in package.json), use `.js` extension in imports
- No TypeScript; plain JavaScript with JSDoc if needed
- Use `console.error` for logging (stdout is for ACP protocol only)
- Error handling: throw `RequestError` from `@agentclientprotocol/sdk` for protocol errors
- Naming: camelCase for variables/functions, PascalCase for classes
