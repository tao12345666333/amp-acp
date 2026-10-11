import { execute, type AmpOptions } from '@ampcode/sdk';
import { rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const attachmentDirs = new Set<string>();
let attachmentCleanupInstalled = false;

function cleanupAttachmentDirs(): void {
  for (const dir of attachmentDirs) {
    attachmentDirs.delete(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort during shutdown */ }
  }
}

function installAttachmentCleanup(): void {
  if (attachmentCleanupInstalled) return;
  attachmentCleanupInstalled = true;
  process.once('exit', cleanupAttachmentDirs);
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    process.once(signal, () => {
      cleanupAttachmentDirs();
      process.exit(code);
    });
  }
}

export type AmpMcpServerConfig =
  | {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      disabled?: boolean;
    }
  | {
      url: string;
      headers?: Record<string, string>;
      disabled?: boolean;
      transport?: string;
    };

export type AmpMcpConfig = Record<string, AmpMcpServerConfig>;

/**
 * Amp agent mode: one of the built-in modes (`low`, `medium`, `high`,
 * `ultra`) or an agent mode registered by an installed Amp plugin
 * (e.g. "grok45"), referenced by key. Amp resolves the actual model routing;
 * both the CLI --mode flag and the Amp SDK accept the mode key as a string.
 */
export type AmpMode = 'low' | 'medium' | 'high' | 'ultra' | (string & {});

/**
 * Amp reasoning effort. Effort is separate from `--mode`: mode selects the
 * model/routing tier, effort selects how much reasoning the model performs.
 * The Amp CLI accepts it as the `--features effort:<level>` thread feature;
 * there is no standalone `--effort` flag.
 */
export type AmpEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AmpExecutionOptions {
  cwd: string;
  env?: Record<string, string>;
  mode?: AmpMode;
  effort?: AmpEffort;
  /** Include Amp thinking blocks in the stream (`--stream-json-thinking`). */
  thinking?: boolean;
  executor?: 'local' | 'orb';
  project?: string;
  dangerouslyAllowAll?: boolean;
  mcpConfig?: AmpMcpConfig;
  continue?: boolean | string;
}

export interface AmpStreamMessage {
  type: string;
  session_id?: string;
  subtype?: string;
  is_error?: boolean;
  error?: string;
  /** Token usage, reported on `assistant` and `result` messages; shape is Amp's Claude Code-compatible usage object. */
  usage?: unknown;
  message?: {
    content: unknown;
  };
}

export interface AmpExecutionRequest {
  prompt: string;
  /** Ordered multimodal input; omitted for text-only turns. */
  content?: AmpPromptContent[];
  options: AmpExecutionOptions;
  signal: AbortSignal;
}

export type AmpPromptContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export interface AmpTransport {
  readonly name: 'cli' | 'sdk';
  execute(request: AmpExecutionRequest): AsyncIterable<AmpStreamMessage>;
}

export interface AmpThreadLifecycleOptions {
  command?: string;
  commandArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

const AMP_THREAD_ID_PATTERN = /^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAmpThreadId(value: unknown): value is string {
  return typeof value === 'string' && AMP_THREAD_ID_PATTERN.test(value);
}

export function buildAmpArchiveArgs(threadId: string, archived: boolean): string[] {
  if (!isAmpThreadId(threadId)) {
    throw new Error(`Invalid Amp thread ID: ${threadId}`);
  }
  return archived
    ? ['threads', 'archive', threadId]
    : ['threads', 'archive', '--unarchive', threadId];
}

export async function setAmpThreadArchived(
  threadId: string,
  archived: boolean,
  options: AmpThreadLifecycleOptions = {},
): Promise<void> {
  const command = options.command ?? process.env.AMP_CLI_PATH ?? 'amp';
  const child = spawn(command, [
    ...(options.commandArgs ?? []),
    ...buildAmpArchiveArgs(threadId, archived),
  ], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

  const { code, processSignal } = await new Promise<{
    code: number | null;
    processSignal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, processSignal) => resolve({ code, processSignal }));
  });

  if (code === null) {
    throw new Error(`Amp CLI process was killed by signal ${processSignal ?? 'unknown'}`);
  }
  if (code !== 0) {
    const details = Buffer.concat(stderr).toString().trim();
    throw new Error(`Amp CLI process exited with code ${code}${details ? `: ${details}` : ''}`);
  }
}

const sdkTransport: AmpTransport = {
  name: 'sdk',
  execute(request) {
    // The pinned SDK validates streaming input as text-only, and remote
    // executors reject streaming input altogether. Use the CLI image routes.
    if (request.content) return createCliTransport().execute(request);
    return execute({
      prompt: request.prompt,
      options: buildAmpSdkOptions(request.options),
      signal: request.signal,
    });
  },
};

export function buildAmpSdkOptions(options: AmpExecutionOptions): AmpOptions {
  return {
    cwd: options.cwd,
    env: options.env,
    mode: options.mode,
    // `effort` is intentionally omitted: the Amp SDK maps it to a bare
    // `--effort` flag, which current Amp CLI releases reject. Effort is a
    // thread feature on the CLI transport (`--features effort:<level>`); the
    // SDK transport (Orb) follows the mode's routing instead.
    ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
    executor: options.executor,
    project: options.project,
    noArchiveAfterExecute: true,
    dangerouslyAllowAll: options.dangerouslyAllowAll,
    mcpConfig: options.mcpConfig,
    continue: options.continue,
  };
}

export function buildAmpCliArgs(options: AmpExecutionOptions): string[] {
  const args: string[] = [];

  if (typeof options.continue === 'string') {
    args.push('threads', 'continue', options.continue);
  } else if (options.continue) {
    args.push('threads', 'continue', '--last');
  }

  args.push(
    '--execute',
    options.thinking ? '--stream-json-thinking' : '--stream-json',
    '--no-archive-after-execute',
  );
  if (options.executor === 'orb') {
    args.push('--orb-execute');
    if (options.project) args.push('--project', options.project);
  }
  if (options.mode) args.push('--mode', options.mode);
  if (options.effort) args.push('--features', `effort:${options.effort}`);
  if (options.dangerouslyAllowAll) args.push('--dangerously-allow-all');
  if (options.mcpConfig) args.push('--mcp-config', JSON.stringify(options.mcpConfig));

  return args;
}

export function createCliTransport(
  command = process.env.AMP_CLI_PATH ?? 'amp',
  commandArgs: string[] = [],
): AmpTransport {
  return {
    name: 'cli',
    async *execute({ prompt, content, options, signal }) {
      signal.throwIfAborted();

      const args = [...commandArgs, ...buildAmpCliArgs(options)];
      let attachmentDir: string | undefined;
      try {
        if (content && options.executor === 'orb') {
          // Remote execute uploads attachments; local paths alone would not
          // be readable in the orb. Keep files private and remove on all exits.
          attachmentDir = await mkdtemp(path.join(os.tmpdir(), 'amp-acp-images-'));
          attachmentDirs.add(attachmentDir);
          installAttachmentCleanup();
          for (const block of content) {
            if (block.type !== 'image') continue;
            const extension = block.source.media_type.split('/')[1];
            const file = path.join(attachmentDir, `${args.length}.${extension}`);
            await writeFile(file, Buffer.from(block.source.data, 'base64'), { mode: 0o600 });
            args.push('--attach', file);
          }
        } else if (content) {
          args.push('--stream-json-input');
        }
        signal.throwIfAborted();
        const child = spawn(command, args, {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const stderr: Buffer[] = [];
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

        const completion = new Promise<{ code: number | null; processSignal: NodeJS.Signals | null }>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, processSignal) => resolve({ code, processSignal }));
        });
        const abort = () => child.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
        signal.addEventListener('abort', abort, { once: true });

        child.stdin.on('error', () => {});
        child.stdin.end(content && options.executor !== 'orb'
          ? JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
          : prompt);

        try {
          const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
          for await (const line of lines) {
            if (!line.trim()) continue;
            try {
              yield JSON.parse(line) as AmpStreamMessage;
            } catch {
              throw new Error(`Failed to parse JSON response, raw line: ${line}`);
            }
          }

          const { code, processSignal } = await completion;
          if (signal.aborted) throw new Error('Amp CLI process was aborted');
          if (code === null) throw new Error(`Amp CLI process was killed by signal ${processSignal ?? 'unknown'}`);
          if (code !== 0) {
            const details = Buffer.concat(stderr).toString().trim();
            throw new Error(`Amp CLI process exited with code ${code}${details ? `: ${details}` : ''}`);
          }
        } finally {
          signal.removeEventListener('abort', abort);
          if (!child.killed && child.exitCode === null) child.kill();
        }
      } finally {
        if (attachmentDir) {
          attachmentDirs.delete(attachmentDir);
          await rm(attachmentDir, { recursive: true, force: true });
        }
      }
    },
  };
}

export function createAmpTransport(name = process.env.AMP_ACP_TRANSPORT ?? 'cli'): AmpTransport {
  switch (name) {
    case 'sdk':
      return sdkTransport;
    case 'cli':
      return createCliTransport();
    default:
      throw new Error(`Unsupported AMP_ACP_TRANSPORT: ${name}`);
  }
}
