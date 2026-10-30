import { readAmpCliListing, type PluginAgentMode } from './plugin-modes.js';

/**
 * Parse `amp config external-agents list --json` output into selectable
 * modes. External agents, such as Claude Code, run a third-party agent
 * inside an Amp thread and are selected by their mode key
 * (`amp --mode external-agent:claude-code`).
 * See https://ampcode.com/docs/the-dial#use-your-claude-subscription
 *
 * Entries without a mode key and agents reported as inactive are skipped.
 * Malformed output yields no modes so it cannot break session setup.
 */
export function parseExternalAgentsList(output: string): PluginAgentMode[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const modes: PluginAgentMode[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { modeKey, name, active } = entry as { modeKey?: unknown; name?: unknown; active?: unknown };
    if (typeof modeKey !== 'string' || modeKey.length === 0 || active === false) continue;
    const label = typeof name === 'string' && name.length > 0 ? name : modeKey;
    modes.push({
      modelId: modeKey,
      name: label,
      description: `Runs ${label} as an external agent inside the Amp thread.`,
    });
  }
  return modes;
}

/**
 * Discover external agent modes through the Amp CLI. Amp CLIs that predate
 * external agents fail the command, which yields no modes. Shares the
 * `amp plugins list` cache TTL and the `AMP_ACP_DISABLE_PLUGIN_LIST` switch.
 */
export function discoverExternalAgentModes(cwd: string): PluginAgentMode[] {
  const output = readAmpCliListing(cwd, ['config', 'external-agents', 'list', '--json']);
  return output === null ? [] : parseExternalAgentsList(output);
}
