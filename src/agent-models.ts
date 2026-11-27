import { spawnSync } from 'node:child_process';

/**
 * A model Amp offers for a thread, discovered from the installed Amp CLI.
 */
export interface AmpModel {
  /** The model id, passed to the Amp CLI as `--model <provider/model>`. */
  modelId: string;
  /** Human-readable label shown in clients. */
  name: string;
  /** Efforts the model accepts as `--effort`; empty when it has none, unset when unknown. */
  efforts?: string[];
}

export interface DiscoverModelsOptions {
  /** Override for `amp plugins show-agent-options --json` stdout. Return null to skip CLI discovery. */
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

/** Successful `amp plugins show-agent-options --json` stdout with its expiry, keyed by cwd + CLI path. */
const showAgentOptionsCache = new Map<string, { expires: number; stdout: string }>();

interface ShowAgentOptionsModel {
  id?: unknown;
  name?: unknown;
  displayName?: unknown;
  capabilities?: { efforts?: unknown };
}

interface ShowAgentOptionsPayload {
  models?: unknown;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Parse `amp plugins show-agent-options --json` output.
 *
 * The payload is an object with a `models` array. Each model exposes an `id`
 * such as `anthropic/claude-opus-5-5` and a `displayName`; older payloads may
 * only include `name`. Entries without an id are skipped, duplicate ids keep
 * their first occurrence, and malformed JSON produces an empty list so an
 * unexpected CLI response cannot break session setup.
 */
export function parseShowAgentOptions(output: string): AmpModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }

  const rawModels: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as ShowAgentOptionsPayload).models)
      ? (parsed as ShowAgentOptionsPayload).models as unknown[]
      : [];

  const models: AmpModel[] = [];
  const seen = new Set<string>();
  for (const raw of rawModels) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as ShowAgentOptionsModel;
    const modelId = stringField(entry.id);
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    const efforts = entry.capabilities?.efforts;
    models.push({
      modelId,
      name: stringField(entry.displayName) || stringField(entry.name) || modelId,
      ...(Array.isArray(efforts)
        ? { efforts: efforts.filter((effort): effort is string => typeof effort === 'string') }
        : entry.capabilities ? { efforts: [] } : {}),
    });
  }
  return models;
}

/**
 * Run `amp plugins show-agent-options --json` in `cwd` and return stdout, or
 * null on any failure. Successful output is cached per process for
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
    const result = spawnSync(command, ['plugins', 'show-agent-options', '--json'], {
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

/** Drop cached `amp plugins show-agent-options --json` output. Used by tests. */
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
