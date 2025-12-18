# ACP adapter for AmpCode

![Screenshot](img/screenshot.png)

Use [Amp](https://ampcode.com) from [ACP](https://agentclientprotocol.com/)-compatible clients such as [Zed](https://zed.dev).

## Prerequisites

- An Amp account (Note: [Amp Free](https://ampcode.com/free) is not supported)
- Node.js (for running the adapter)
- Authenticated Amp session (via `AMP_API_KEY` or `amp login`)

## Installation

Add to your Zed `settings.json` (open with `cmd+,` or `ctrl+,`):

```json
{
  "agent_servers": {
    "Amp": {
      "command": "npx",
      "args": ["-y", "amp-acp"],
      "env": {
        "AMP_API_KEY": "sgamp_your_api_key_here"
      }
    }
  }
}
```

Replace `"sgamp_your_api_key_here"` with your Amp API Key (get it from [ampcode.com/settings](https://ampcode.com/settings)).

Alternatively, if you have the Amp CLI installed and authenticated globally (`amp login`), you can omit the `env` block.

## How it Works

- Streams Amp's JSON over ACP
- Renders Amp messages and interactions in Zed
- Tool permissions are handled by Amp (no additional configuration needed)

## Troubleshooting

**Connection fails**: Ensure your `AMP_API_KEY` is correct or you are logged in via `amp login`.
