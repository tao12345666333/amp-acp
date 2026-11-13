import { spawnSync } from 'node:child_process';

/**
 * A model Amp offers for a thread, discovered from the installed Amp CLI.
 */
export interface AmpModel {
  /** The model id, passed to the Amp CLI as `--model <provider/model>`. */
  modelId: string;
  /** Human-readable label shown in clients. */
  name: string;
}

export interface DiscoverModelsOptions {
  /** Override for `amp plugins show-agent-options` stdout. Return null to skip CLI discovery. */
  showAgentOptions?: (cwd: string) => string | null;
}

const SHOW_AGENT_OPTIONS_TIMEOUT_MS = 8000;

/**
 * How long a successful `amp plugins show-agent-options` result is reused.
 * Matches the plugin-mode discovery cache: short enough that Amp releases
 * show up in new sessions within about a minute, long enough that
 * `session/new` does not block the event loop on a spawn every time.
 */
export const SHOW_AGENT_OPTIONS_CACHE_TTL_MS = 60_000;

/** Successful `amp plugins show-agent-options` stdout with its expiry, keyed by cwd + CLI path. */
const showAgentOptionsCache = new Map<string, { expires: number; stdout: string }>();

/**
 * Parse the `Models` section of `amp plugins show-agent-options` text output.
 *
 * Amp does not currently expose JSON for this command. The section is a
 * heading followed by indented `provider/model-id (Label)` lines:
 *
 *   Models
 *     anthropic/claude-opus-5-5 (Claude Opus 5.5)
 *
 * The next non-indented heading (currently `Built-in tools`) and everything
 * after it is ignored. Malformed lines are skipped so an unexpected CLI
 * output shape cannot break session setup.
 */
export function parseShowAgentOptions(output: string): AmpModel[] {
  const text = output.replace(/\x1B\[[0-9;]*m/g, '');
  const models: AmpModel[] = [];
  const seen = new Set<string>();
  let inModels = false;

  for (const line of text.split(/\r?\n/)) {
    if (!inModels) {
      if (line.trim() === 'Models') inModels = true;
      continue;
    }
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) break;
    const model = line.match(/^\s+(\S+) \((.+)\)\s*$/);
    if (!model) continue;
    const modelId = model[1];
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    models.push({ modelId, name: model[2] });
  }
  return models;
}

/**
 * Run `amp plugins show-agent-options` in `cwd` and return stdout, or null on
 * any failure. Successful output is cached per process for
 * `(cwd, AMP_CLI_PATH)` and reused until SHOW_AGENT_OPTIONS_CACHE_TTL_MS old,
 * so `session/new` does not block the event loop on a spawn every time.
 * Failures are not cached, so a later session can retry.
 * Set `AMP_ACP_DISABLE_SHOW_AGENT_OPTIONS=1` to skip the CLI (used by tests).
 */
export function readShowAgentOptions(cwd: string): string | null {
  if (process.env.AMP_ACP_DISABLE_SHOW_AGENT_OPTIONS === '1') return null;
  const command = process.env.AMP_CLI_PATH ?? 'amp';
  const cacheKey = `${cwd}\0${command}`;
  const cached = showAgentOptionsCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.stdout;
  try {
    const result = spawnSync(command, ['plugins', 'show-agent-options'], {
      cwd,
      encoding: 'utf8',
      timeout: SHOW_AGENT_OPTIONS_TIMEOUT_MS,
      env: process.env,
      // stdin is the ACP stream in production; never let the child inherit it.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) return null;
    const stdout = result.stdout;
    if (typeof stdout !== 'string') return null;
    showAgentOptionsCache.set(cacheKey, { expires: Date.now() + SHOW_AGENT_OPTIONS_CACHE_TTL_MS, stdout });
    return stdout;
  } catch {
    return null;
  }
}

/** Drop cached `amp plugins show-agent-options` output. Used by tests. */
export function clearShowAgentOptionsCache(): void {
  showAgentOptionsCache.clear();
}

/**
 * Discover the models the installed Amp CLI offers for a thread.
 *
 * Amp replaced the built-in `low`/`medium`/`high`/`ultra` dial modes with a
 * model selector; this is its discovery command. On any failure the list is
 * empty and sessions run with Amp's own default model.
 */
export function discoverModels(cwd: string, options: DiscoverModelsOptions = {}): AmpModel[] {
  const showAgentOptions = options.showAgentOptions ?? readShowAgentOptions;
  return parseShowAgentOptions(showAgentOptions(cwd) ?? '');
}
