# MCP Configuration Passthrough

This document explains how amp-acp passes MCP (Model Context Protocol) server configurations from Zed to Amp.

## Overview

The [Model Context Protocol (MCP)](https://modelcontextprotocol.io) is an open standard for connecting AI models to external data sources and tools. When you configure MCP servers in Zed, amp-acp automatically passes these configurations to Amp, allowing you to use the same tools with both Zed's built-in AI and Amp.

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            Zed Editor                                    │
│  ┌──────────────────┐    ┌───────────────────────────────────────────┐  │
│  │  settings.json   │    │              Agent Panel                   │  │
│  │  ┌────────────┐  │    │  ┌─────────────────────────────────────┐  │  │
│  │  │ context_   │  │───▶│  │  ACP Protocol (session/new)         │  │  │
│  │  │ servers    │  │    │  │  { mcpServers: [...] }              │  │  │
│  │  └────────────┘  │    │  └─────────────────────────────────────┘  │  │
│  └──────────────────┘    └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           amp-acp adapter                                │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  newSession(params) {                                           │    │
│  │    // Convert ACP format to Amp SDK format                      │    │
│  │    for (const server of params.mcpServers) {                    │    │
│  │      if (server.type === 'http' || server.type === 'sse') {     │    │
│  │        mcpConfig[server.name] = { url, headers };               │    │
│  │      } else {                                                   │    │
│  │        mcpConfig[server.name] = { command, args, env };         │    │
│  │      }                                                          │    │
│  │    }                                                            │    │
│  │  }                                                              │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                             Amp SDK                                      │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  execute({ prompt, options: { mcpConfig } })                    │    │
│  │  - Connects to configured MCP servers                           │    │
│  │  - Makes MCP tools available to the AI agent                    │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Zed Configuration**: You configure `context_servers` in your Zed `settings.json`
2. **ACP Protocol**: When creating a new session, Zed sends the `mcpServers` parameter via the ACP `session/new` request
3. **Format Conversion**: amp-acp converts the ACP format to Amp SDK's `mcpConfig` format
4. **MCP Connection**: Amp SDK connects to the configured MCP servers and loads their tools

## Supported Server Types

### stdio (Local MCP Servers)

Local MCP servers run as child processes and communicate via stdin/stdout.

**Zed Configuration:**
```json
{
  "context_servers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--headless"],
      "env": {
        "BROWSER": "chromium"
      }
    }
  }
}
```

**ACP Format (sent to agent):**
```json
{
  "name": "playwright",
  "command": "/path/to/npx",
  "args": ["-y", "@playwright/mcp@latest", "--headless"],
  "env": [
    { "name": "BROWSER", "value": "chromium" }
  ]
}
```

**Amp SDK Format (after conversion):**
```json
{
  "playwright": {
    "command": "/path/to/npx",
    "args": ["-y", "@playwright/mcp@latest", "--headless"],
    "env": {
      "BROWSER": "chromium"
    }
  }
}
```

### HTTP (Remote MCP Servers)

Remote HTTP MCP servers communicate via HTTP requests.

**Zed Configuration:**
```json
{
  "context_servers": {
    "exa": {
      "url": "https://mcp.exa.ai/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key"
      }
    }
  }
}
```

**ACP Format (sent to agent):**
```json
{
  "type": "http",
  "name": "exa",
  "url": "https://mcp.exa.ai/mcp",
  "headers": [
    { "name": "Authorization", "value": "Bearer your-api-key" }
  ]
}
```

**Amp SDK Format (after conversion):**
```json
{
  "exa": {
    "url": "https://mcp.exa.ai/mcp",
    "headers": {
      "Authorization": "Bearer your-api-key"
    }
  }
}
```

### SSE (Server-Sent Events)

SSE MCP servers use Server-Sent Events for real-time communication.

**Zed Configuration:**
```json
{
  "context_servers": {
    "monday": {
      "url": "https://mcp.monday.com/sse",
      "headers": {
        "Authorization": "Bearer your-token"
      }
    }
  }
}
```

The SSE format follows the same conversion process as HTTP.

## Compatibility

This implementation is compatible with other ACP agents:

| Feature | amp-acp | [claude-code-acp](https://github.com/zed-industries/claude-code-acp) | [codex-acp](https://github.com/zed-industries/codex-acp) |
|---------|---------|-----------------|-----------|
| stdio support | ✅ | ✅ | ✅ |
| HTTP support | ✅ | ✅ | ✅ |
| SSE support | ✅ | ✅ | ❌ |
| Headers conversion | ✅ | ✅ | ✅ |
| Environment variables | ✅ | ✅ | ✅ |

## Popular MCP Servers

Here are some popular MCP servers you can use with amp-acp:

### Web & Browser

- **[Exa Search](https://docs.exa.ai/reference/exa-mcp)** - AI-powered web search
  ```json
  "exa": {
    "command": "npx",
    "args": ["-y", "mcp-remote", "https://mcp.exa.ai/mcp"]
  }
  ```

- **[Playwright](https://github.com/anthropics/mcp-playwright)** - Browser automation
  ```json
  "playwright": {
    "command": "npx",
    "args": ["-y", "@playwright/mcp@latest", "--headless"]
  }
  ```

### Development Tools

- **[GitHub](https://github.com/github/github-mcp-server)** - GitHub API integration
  ```json
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "your-token" }
  }
  ```

- **[Semgrep](https://semgrep.dev/docs/semgrep-assistant/mcp)** - Code security scanning
  ```json
  "semgrep": {
    "url": "https://mcp.semgrep.ai/mcp"
  }
  ```

### File & Data

- **[Filesystem](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)** - Local file access
  ```json
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed"]
  }
  ```

- **[PostgreSQL](https://github.com/modelcontextprotocol/servers/tree/main/src/postgres)** - Database queries
  ```json
  "postgres": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-postgres"],
    "env": { "POSTGRES_CONNECTION_STRING": "postgresql://..." }
  }
  ```

## Troubleshooting

### MCP Server Not Loading

1. Check that the MCP server command is correct
2. Verify any required environment variables are set
3. Check Zed's output panel for error messages
4. Try running the MCP server command directly in a terminal

### Headers Not Being Sent

The ACP protocol sends headers as an array of `{ name, value }` objects:
```json
"headers": [
  { "name": "Authorization", "value": "Bearer token" }
]
```

amp-acp converts this to Amp SDK's object format:
```json
"headers": {
  "Authorization": "Bearer token"
}
```

If headers aren't working, check that both the ACP and Amp SDK formats are correct.

### Permission Errors

Some MCP servers require specific permissions. For example:
- `@modelcontextprotocol/server-filesystem` needs access to the filesystem path
- `@playwright/mcp` may need browser installation

Check the MCP server's documentation for required setup steps.

## References

- [Model Context Protocol](https://modelcontextprotocol.io)
- [Zed MCP Documentation](https://zed.dev/docs/ai/mcp)
- [Agent Client Protocol](https://agentclientprotocol.com)
- [Amp MCP Documentation](https://ampcode.com/manual#mcp)
- [claude-code-acp source](https://github.com/zed-industries/claude-code-acp)
- [codex-acp source](https://github.com/zed-industries/codex-acp)
