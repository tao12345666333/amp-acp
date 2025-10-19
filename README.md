# ACP adapter for AmpCode

Use [Amp](https://ampcode.com) from [ACP](https://agentclientprotocol.com/)-compatible clients such as [Zed](https://zed.dev).

## Prerequisites

- [Amp CLI](https://ampcode.com) installed and authenticated (`amp login`)
- Node.js (for running the adapter)

## Installation

Add to your Zed `settings.json` (open with `cmd+,` or `ctrl+,`):

```json
{
  "agent_servers": {
    "Amp": {
      "command": "npx",
      "args": ["-y", "amp-acp"],
      "env": {
        "AMP_EXECUTABLE": "path of AMP bin",
        "AMP_PREFER_SYSTEM_PATH": "1"
      }
    }
  }
}
```

Replace `"path of AMP bin"` with your Amp CLI path (e.g., `/usr/local/bin/amp`).

## How it Works

- Streams Amp's JSON over ACP
- Renders Amp messages and interactions in Zed
- Tool permissions are handled by Amp (no additional configuration needed)

## Troubleshooting

**Connection fails**: Ensure `amp login` was successful and the CLI is in your `AMP_EXECUTABLE`.
