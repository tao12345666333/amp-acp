import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * An agent mode registered by an installed Amp plugin.
 *
 * Amp plugins declare custom agent modes with a static metadata comment:
 *
 *   // @amp-agent-mode {"key":"grok45","label":"Grok 4.5"}
 *
 * Amp documents these comments as the discovery mechanism for clients.
 * amp-acp also reads `amp plugins list`, which is the CLI's source of truth
 * for loaded Project, System, Personal, and Workspace plugins.
 * See https://ampcode.com/docs/customize/plugins
 */
export interface PluginAgentMode {
  /** The mode key, passed to `amp --mode <key>` and the Amp SDK `mode` option. */
  modelId: string;
  /** Human-readable label shown in clients. */
  name: string;
  /** Name of the plugin file or plugin that declared the mode, when known. */
  source?: string;
}

export interface DiscoverPluginModesOptions {
  /** Override for `amp plugins list` stdout. Return null to skip CLI discovery. */
  listPlugins?: (cwd: string) => string | null;
  /** Override for the system plugin directory. */
  systemPluginDir?: string;
}

const PLUGIN_LIST_TIMEOUT_MS = 8000;

/**
 * How long a successful `amp plugins list` result is reused. Short enough
 * that a mode plugin installed while the adapter is running shows up in new
 * sessions within about a minute, without an adapter restart; long enough
 * that `session/new` does not block the event loop on a ~1s spawn every
 * time.
 */
export const PLUGIN_LIST_CACHE_TTL_MS = 60_000;

/** Successful `amp plugins list` stdout with its expiry, keyed by cwd + CLI path. */
const pluginListCache = new Map<string, { expires: number; stdout: string }>();

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

function collectModesFromFile(filePath: string, source: string): PluginAgentMode[] {
  try {
    const contents = readFileSync(filePath, 'utf8');
    return parseAgentModeComments(contents).map((mode) => ({ ...mode, source }));
  } catch {
    return [];
  }
}

/**
 * Scan a plugin directory for `@amp-agent-mode` comments in `.ts`/`.js`
 * plugin files and directory-plugin entry files (`<name>/index.ts`).
 * Missing or unreadable directories/files contribute nothing.
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
    if (entry.isFile() && /\.(ts|js)$/i.test(entry.name)) {
      modes.push(...collectModesFromFile(path.join(dir, entry.name), entry.name));
      continue;
    }
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const indexTs = path.join(dir, entry.name, 'index.ts');
    const indexJs = path.join(dir, entry.name, 'index.js');
    if (existsSync(indexTs)) {
      modes.push(...collectModesFromFile(indexTs, entry.name));
    } else if (existsSync(indexJs)) {
      modes.push(...collectModesFromFile(indexJs, entry.name));
    }
  }
  return modes;
}

/**
 * System plugin directory used by Amp on this platform. Honors
 * `XDG_CONFIG_HOME` when set, otherwise `~/.config/amp/plugins` (macOS/Linux)
 * or `%USERPROFILE%\.config\amp\plugins` (Windows).
 * `AMP_ACP_SYSTEM_PLUGIN_DIR` overrides it, which is also what the test suite
 * uses to avoid scanning the developer's real plugins.
 */
export function getSystemPluginDir(): string {
  return process.env.AMP_ACP_SYSTEM_PLUGIN_DIR ??
    path.join(
      process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
      'amp',
      'plugins',
    );
}

/**
 * Parse `amp plugins list` text output for registered agent modes.
 *
 * Amp does not currently expose JSON for this command. Lines look like:
 *
 *   ✓ official-modes (Workspace Plugins) active
 *     agent mode: grok45
 *
 * `agent:` lines are custom agents, not selectable modes, and are ignored.
 * Modes from plugins that are not `active` are ignored. The CLI already
 * applies Amp's load order; duplicate keys keep the first occurrence.
 */
export function parseAmpPluginsList(output: string): PluginAgentMode[] {
  const modes: PluginAgentMode[] = [];
  const seen = new Set<string>();
  let currentPlugin: string | undefined;
  let active = false;
  const text = output.replace(/\x1B\[[0-9;]*m/g, '');

  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^[✓✔]\s+(\S+)\s+\(([^)]+)\)\s+(\S+)/);
    if (header) {
      currentPlugin = header[1];
      active = header[3] === 'active';
      continue;
    }
    if (!active || !currentPlugin) continue;
    const mode = line.match(/^\s+agent mode:\s+(\S+)\s*$/);
    if (!mode) continue;
    const key = mode[1].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    modes.push({ modelId: mode[1], name: mode[1], source: currentPlugin });
  }
  return modes;
}

/**
 * Run `amp plugins list` in `cwd` and return stdout, or null on any failure.
 * Successful output is cached per process for `(cwd, AMP_CLI_PATH)` and
 * reused until it is PLUGIN_LIST_CACHE_TTL_MS old, so `session/new` does
 * not block the event loop on a ~1s spawn every time. Failures are not
 * cached, so a later session can retry.
 * Set `AMP_ACP_DISABLE_PLUGIN_LIST=1` to skip the CLI (used by tests).
 */
export function readAmpPluginsList(cwd: string): string | null {
  if (process.env.AMP_ACP_DISABLE_PLUGIN_LIST === '1') return null;
  const command = process.env.AMP_CLI_PATH ?? 'amp';
  const cacheKey = `${cwd}\0${command}`;
  const cached = pluginListCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.stdout;
  try {
    const result = spawnSync(command, ['plugins', 'list'], {
      cwd,
      encoding: 'utf8',
      timeout: PLUGIN_LIST_TIMEOUT_MS,
      env: process.env,
      // stdin is the ACP stream in production; never let the child inherit it.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) return null;
    const stdout = result.stdout;
    if (typeof stdout !== 'string') return null;
    pluginListCache.set(cacheKey, { expires: Date.now() + PLUGIN_LIST_CACHE_TTL_MS, stdout });
    return stdout;
  } catch {
    return null;
  }
}

/** Drop cached `amp plugins list` output. Used by tests. */
export function clearPluginListCache(): void {
  pluginListCache.clear();
}

function addUnique(modes: PluginAgentMode[], seen: Set<string>, incoming: PluginAgentMode[]): void {
  for (const mode of incoming) {
    const key = mode.modelId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    modes.push(mode);
  }
}

/**
 * Discover plugin agent modes available for a session.
 *
 * Local comment scanning covers project (`.amp/plugins`) and system
 * (`~/.config/amp/plugins`) plugins, including labels. `amp plugins list`
 * covers every source Amp actually loads — Project, System, Personal, and
 * Workspace — which is how hosted mode plugins such as `official-modes`
 * (`grok45`, `kimi-k3`, …) show up without a local copy.
 *
 * Precedence matches Amp: project, then system, then personal/workspace
 * (whatever `amp plugins list` reports). First declaration of a key wins.
 * Built-in mode keys are filtered later by the session config builder.
 */
export function discoverPluginModes(
  cwd: string,
  options: DiscoverPluginModesOptions = {},
): PluginAgentMode[] {
  const systemDir = options.systemPluginDir ?? getSystemPluginDir();
  const listPlugins = options.listPlugins ?? readAmpPluginsList;
  const seen = new Set<string>();
  const modes: PluginAgentMode[] = [];

  addUnique(modes, seen, scanPluginDir(path.join(cwd, '.amp', 'plugins')));
  addUnique(modes, seen, scanPluginDir(systemDir));
  addUnique(modes, seen, parseAmpPluginsList(listPlugins(cwd) ?? ''));
  return modes;
}
