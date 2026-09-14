import { spawn } from 'node:child_process';

export interface AmpModeOption {
  value: string;
  name: string;
  description: string;
}

/** The four built-in Amp modes; always selectable. */
export const BUILTIN_AMP_MODES: AmpModeOption[] = [
  {
    value: 'low',
    name: 'Low',
    description: 'Fast and economical for simple, well-defined tasks.',
  },
  {
    value: 'medium',
    name: 'Medium',
    description: 'Balanced capability and cost for everyday coding tasks.',
  },
  {
    value: 'high',
    name: 'High',
    description: 'Greater capability and reasoning for difficult tasks.',
  },
  {
    value: 'ultra',
    name: 'Ultra',
    description: 'Maximum capability for the most demanding tasks.',
  },
];

/**
 * Returns the Amp modes selectable for a session working directory: the
 * built-in modes plus any agent modes registered by loaded Amp plugins.
 */
export type AmpModeCatalog = (cwd: string) => Promise<AmpModeOption[]>;

const PLUGIN_MODE_LINE = /^\s*agent mode:\s*(\S+)/;

/** Extracts plugin agent mode keys from `amp plugins list` output. */
export function parsePluginAgentModes(output: string): string[] {
  const keys: string[] = [];
  for (const line of output.split('\n')) {
    const match = PLUGIN_MODE_LINE.exec(line);
    if (match && !keys.includes(match[1])) keys.push(match[1]);
  }
  return keys;
}

function runAmpPluginsList(
  command: string,
  commandArgs: string[],
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...commandArgs, 'plugins', 'list'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`\`${command} plugins list\` timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString());
      } else {
        const details = Buffer.concat(stderr).toString().trim();
        reject(new Error(`\`${command} plugins list\` exited with code ${code}${details ? `: ${details}` : ''}`));
      }
    });
  });
}

export interface AmpModeCatalogOptions {
  /** Amp CLI command; defaults to AMP_CLI_PATH or `amp`. */
  command?: string;
  commandArgs?: string[];
  /** Kill `plugins list` after this long; defaults to 10s. */
  timeoutMs?: number;
  /** Cache duration per working directory; defaults to 60s. */
  cacheTtlMs?: number;
  /** Overrides the `plugins list` call; mainly for tests. */
  listPluginsOutput?: (cwd: string) => Promise<string>;
}

/**
 * Builds a mode catalog that discovers plugin-provided agent modes by running
 * `amp plugins list` in the session's working directory (project plugins are
 * per-directory). Discovery failures fall back to the built-in modes so an
 * old or missing Amp CLI never breaks session setup.
 */
export function createAmpModeCatalog(options: AmpModeCatalogOptions = {}): AmpModeCatalog {
  const command = options.command ?? process.env.AMP_CLI_PATH ?? 'amp';
  const commandArgs = options.commandArgs ?? [];
  const timeoutMs = options.timeoutMs ?? 10_000;
  const cacheTtlMs = options.cacheTtlMs ?? 60_000;
  const cache = new Map<string, { expires: number; promise: Promise<AmpModeOption[]> }>();

  const discover = async (cwd: string): Promise<AmpModeOption[]> => {
    try {
      const output = options.listPluginsOutput
        ? await options.listPluginsOutput(cwd)
        : await runAmpPluginsList(command, commandArgs, cwd, timeoutMs);
      const pluginModes = parsePluginAgentModes(output).map((key) => ({
        value: key,
        name: key,
        description: 'Custom agent mode from an Amp plugin.',
      }));
      return [...BUILTIN_AMP_MODES, ...pluginModes];
    } catch (e) {
      console.error('[acp] failed to discover Amp plugin agent modes; offering built-in modes only', e);
      return BUILTIN_AMP_MODES;
    }
  };

  return (cwd) => {
    const hit = cache.get(cwd);
    if (hit && hit.expires > Date.now()) return hit.promise;
    const promise = discover(cwd);
    cache.set(cwd, { expires: Date.now() + cacheTtlMs, promise });
    return promise;
  };
}
