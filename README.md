# ACP adapter for Amp

Use Amp from ACP-compatible clients such as Zed.

## Install / Run

- Ensure `amp` CLI is installed and logged in.
- Run the adapter:

```
amp-acp
```

Then connect from Zed via External Agents (ACP) and start a new Amp thread.

## Notes

- Streams Amp's Claude Code–compatible JSON over ACP and renders messages in Zed.
- Minimal adapter: tool permissions are handled by Amp.