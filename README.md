# ACP adapter for Amp

[![CI](https://github.com/tao12345666333/amp-acp/actions/workflows/ci.yml/badge.svg)](https://github.com/tao12345666333/amp-acp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/amp-acp)](https://www.npmjs.com/package/amp-acp)

![Screenshot](img/screenshot.png)

Use [Amp](https://ampcode.com) from [ACP](https://agentclientprotocol.com/)-compatible clients such as [Zed](https://zed.dev) or [Toad](https://github.com/batrachianai/toad).

## Installation

### Option 1: Pre-built Binary (Recommended)

Download a standalone binary from the [GitHub Releases](https://github.com/tao12345666333/amp-acp/releases) page — no runtime dependencies required.

| Platform | Architecture | Binary |
|----------|-------------|--------|
| Linux | x64 | `amp-acp-linux-x64` |
| Linux | arm64 | `amp-acp-linux-arm64` |
| macOS | x64 (Intel) | `amp-acp-darwin-x64` |
| macOS | arm64 (Apple Silicon) | `amp-acp-darwin-arm64` |
| Windows | x64 | `amp-acp-windows-x64.exe` |

Download the binary for your platform, make it executable (`chmod +x` on Linux/macOS), and add to your Zed `settings.json` (open with `cmd+,` or `ctrl+,`):

```json
{
  "agent_servers": {
    "Amp": {
      "command": "/path/to/amp-acp-darwin-arm64"
    }
  }
}
```

### Option 2: npx

```json
{
  "agent_servers": {
    "Amp": {
      "command": "npx",
      "args": ["-y", "amp-acp"],
      "env": {
        "AMP_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

Requires Node.js 18+.

### Option 3: Zed ACP Registry (Coming Soon)

A [PR to the ACP Registry](https://github.com/agentclientprotocol/registry/pull/89) is in progress. Once merged, you'll be able to install Amp directly from Zed's ACP Registry.

In the meantime, you can install it as a **Dev Extension**:

1. Clone this repository: `git clone https://github.com/tao12345666333/amp-acp.git`
2. In Zed, open the command palette and run `zed: install dev extension`
3. Select the cloned `amp-acp` directory

Zed will automatically load the extension and download the correct binary for your platform.

## Authentication

**If you [have Amp CLI installed](https://ampcode.com/manual#getting-started-command-line-interface)**: Run `amp login` first — credentials are shared automatically.

**If you don't have Amp CLI**: Run `amp-acp --setup` to configure your API key interactively. Alternatively, you can start a chat in Zed's Agent Panel — it will automatically trigger the setup flow if no credentials are found, just follow the prompts.

## Features

- **Streaming responses** — Amp messages, tool calls, and thinking are streamed in real-time via ACP
- **Image support** — Handles image content blocks from Amp (base64 and URL)
- **MCP passthrough** — MCP servers configured in Zed are automatically passed through to Amp
- **Session modes** — Switch between *Default* (prompts for tool permissions) and *Bypass* (skips permission prompts)
- **`/init` command** — Type `/init` to generate an `AGENTS.md` file for your project
- **Conversation continuity** — Thread context is preserved across multiple prompts within a session

## MCP Configuration Passthrough

MCP servers configured in Zed's `context_servers` are automatically forwarded to Amp. This is compatible with how other ACP agents like [Claude Code](https://github.com/zed-industries/claude-code-acp) and [Codex](https://github.com/zed-industries/codex-acp) handle MCP servers.

### Supported MCP Server Types

| Type | Description | Example |
|------|-------------|---------|
| **stdio** | Local command-line MCP servers | `@playwright/mcp`, `@modelcontextprotocol/server-filesystem` |
| **HTTP** | Remote HTTP MCP servers | `https://mcp.exa.ai/mcp` |
| **SSE** | Remote Server-Sent Events MCP servers | `https://mcp.monday.com/sse` |

### Example: Using Exa Search with Amp

```json
{
  "agent_servers": {
    "Amp": {
      "command": "npx",
      "args": ["-y", "amp-acp"]
    }
  },
  "context_servers": {
    "exa": {
      "url": "https://mcp.exa.ai/mcp"
    }
  }
}
```

### Example: Multiple MCP Servers

```json
{
  "agent_servers": {
    "Amp": {
      "command": "npx",
      "args": ["-y", "amp-acp"]
    }
  },
  "context_servers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--headless"]
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "your-token"
      }
    }
  }
}
```

For more details, see [docs/mcp-passthrough.md](docs/mcp-passthrough.md).

## Development

```bash
bun install
bun run build        # Bundle to dist/index.js
bun run lint         # Type-check with tsc
bun test src/        # Run unit tests
bun run test:binary  # Run binary integration tests
bun run test:all     # Run all tests
```

## Troubleshooting

**Adapter doesn't start**: Make sure you have Node.js 18+ (for `npx`) or use a pre-built binary / Zed extension instead.

**Connection issues**: Restart Zed and try again. The adapter creates a fresh connection each time.

**Tool execution problems**: Check Zed's output panel for detailed error messages from the Amp SDK.

**MCP server not connecting**: Ensure the MCP server command is correct and any required environment variables are set. Check Zed's logs for connection errors.

## License

[Apache-2.0](https://opensource.org/licenses/Apache-2.0)
