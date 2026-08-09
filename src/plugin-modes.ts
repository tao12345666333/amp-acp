import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * An agent mode registered by an installed Amp plugin.
 *
 * Amp plugins declare custom agent modes with a static metadata comment:
 *
 *   // @amp-agent-mode {"key":"grok45","label":"Grok 4.5"}
 *
 * Amp documents these comments as the discovery mechanism for clients, so
 * amp-acp scans plugin sources to surface plugin modes alongside the built-in
 * low/medium/high/ultra modes. See https://ampcode.com/manual#plugins
 */
export interface PluginAgentMode {
  /** The mode key, passed to `amp --mode <key>` and the Amp SDK `mode` option. */
  modelId: string;
  /** Human-readable label shown in clients. */
  name: string;
  /** Name of the plugin file that declared the mode, when known. */
  source?: string;
}

/**
 * Parse `// @amp-agent-mode {...}` metadata comments out of a plugin source
 * file. A single plugin file may register multiple modes. Malformed comments
 * are ignored so a broken plugin cannot break session setup.
 */
export function parseAgentModeComments(source: string): PluginAgentMode[] {
  const modes: PluginAgentMode[] = [];
  const comment = /@amp-agent-mode\s*(\{.*\})/g;
  for (const match of source.matchAll(comment)) {
    try {
      const parsed = JSON.parse(match[1]) as { key?: unknown; label?: unknown };
      if (
        typeof parsed.key === 'string' && parsed.key.length > 0 &&
        typeof parsed.label === 'string' && parsed.label.length > 0
      ) {
        modes.push({ modelId: parsed.key, name: parsed.label });
      }
    } catch {
      // Malformed metadata comment; skip it.
    }
  }
  return modes;
}

/**
 * Scan a plugin directory for `@amp-agent-mode` comments in `.ts`/`.js`
 * plugin files. Missing or unreadable directories/files contribute nothing.
 */
export function scanPluginDir(dir: string): PluginAgentMode[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const modes: PluginAgentMode[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(ts|js)$/i.test(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const source = readFileSync(filePath, 'utf8');
      for (const mode of parseAgentModeComments(source)) {
        modes.push({ ...mode, source: entry.name });
      }
    } catch {
      // Unreadable plugin file; skip it.
    }
  }
  return modes;
}

/**
 * System plugin directory used by Amp on this platform:
 * `~/.config/amp/plugins` (macOS/Linux) or `%USERPROFILE%\.config\amp\plugins`
 * (Windows). `AMP_ACP_SYSTEM_PLUGIN_DIR` overrides it, which is also what the
 * test suite uses to avoid scanning the developer's real plugins.
 */
export function getSystemPluginDir(): string {
  return process.env.AMP_ACP_SYSTEM_PLUGIN_DIR ??
    path.join(os.homedir(), '.config', 'amp', 'plugins');
}

/**
 * Discover all plugin agent modes available for a session: modes from the
 * system plugin directory plus modes from the project's `.amp/plugins`
 * directory. System modes win over project modes with the same key, matching
 * Amp's plugin precedence (a local plugin masks a system plugin).
 */
export function discoverPluginModes(cwd: string): PluginAgentMode[] {
  const dirs = [getSystemPluginDir(), path.join(cwd, '.amp', 'plugins')];
  const seen = new Set<string>();
  const modes: PluginAgentMode[] = [];
  for (const dir of dirs) {
    for (const mode of scanPluginDir(dir)) {
      if (seen.has(mode.modelId)) continue;
      seen.add(mode.modelId);
      modes.push(mode);
    }
  }
  return modes;
}
