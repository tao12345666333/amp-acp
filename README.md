# ACP adapter for AmpCode

![Screenshot](img/screenshot.png)

Use [Amp](https://ampcode.com) from [ACP](https://agentclientprotocol.com/)-compatible clients such as [Zed](https://zed.dev) or [Toad](https://github.com/batrachianai/toad).

## Prerequisites

- Node.js 18+ (the adapter will be installed automatically via `npx`)

## Installation

Add to your Zed `settings.json` (open with `cmd+,` or `ctrl+,`):

```json
{
  "agent_servers": {
    "Amp": {
      "command": "npx",
      "args": ["-y", "amp-acp"]
    }
  }
}
```

That's it! The SDK handles authentication and Amp integration automatically.

## First Use

**If you don't have Amp CLI installed**: Add the `AMP_API_KEY` environment variable to your Zed config. You can get your API key from https://ampcode.com/settings

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

**If you [have Amp CLI installed](https://ampcode.com/manual#getting-started-command-line-interface)**: Run `amp login` first to authenticate.

## How it Works

- Uses the official Amp SDK to communicate with AmpCode
- Streams Amp's responses over the Agent Client Protocol (ACP)
- Renders Amp messages and interactions natively in Zed
- Tool permissions are handled by Amp (no additional configuration needed)
- Supports conversation continuity across multiple prompts
- **MCP servers configured in Zed are automatically passed through to Amp**

## MCP Configuration Passthrough

The adapter supports passing [MCP (Model Context Protocol)](https://modelcontextprotocol.io) servers configured in Zed through to Amp. This allows you to use the same MCP tools in both Zed's native AI and Amp.

This implementation is compatible with how other ACP agents like [Claude Code](https://github.com/zed-industries/claude-code-acp) and [Codex](https://github.com/zed-industries/codex-acp) handle MCP servers. See [Zed's MCP documentation](https://zed.dev/docs/ai/mcp) for more details.

### Supported MCP Server Types

| Type | Description | Example |
|------|-------------|---------|
| **stdio** | Local command-line MCP servers | `@playwright/mcp`, `@modelcontextprotocol/server-filesystem` |
| **HTTP** | Remote HTTP MCP servers | `https://mcp.exa.ai/mcp`, `https://mcp.semgrep.ai/mcp` |
| **SSE** | Remote Server-Sent Events MCP servers | `https://mcp.monday.com/sse` |

### Example: Using Exa Search with Amp

[Exa](https://exa.ai) provides a powerful web search MCP server. Add both the agent server and context servers to your Zed `settings.json`:

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

You can configure multiple MCP servers to extend Amp's capabilities:

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

### How MCP Passthrough Works

1. When you configure `context_servers` in Zed's `settings.json`, Zed passes them to the ACP agent via the `mcpServers` parameter in the `session/new` request
2. The amp-acp adapter converts the MCP server configurations from ACP format to Amp SDK format
3. Amp connects to the MCP servers and makes their tools available during the session

For more details, see [docs/mcp-passthrough.md](docs/mcp-passthrough.md).

## Troubleshooting

**Adapter doesn't start**: Make sure you have Node.js 18 or later installed. Run `node --version` to check.

**Connection issues**: Restart Zed and try again. The adapter creates a fresh connection each time.

**Tool execution problems**: Check Zed's output panel for detailed error messages from the Amp SDK.

**MCP server not connecting**: Ensure the MCP server command is correct and any required environment variables are set. Check Zed's logs for connection errors.

