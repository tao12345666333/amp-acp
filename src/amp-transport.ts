import { execute, type AmpOptions } from '@ampcode/sdk';
import { rmSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
  /** MCP server connection reports from the `system` init message. */
  mcp_servers?: unknown;
  /** Tool calls blocked by project permissions in the `result` message. */
  permission_denials?: unknown;
  /** Set for subagent messages; their text is not the parent prompt echo. */
  parent_tool_use_id?: string | null;
  message?: {
    content: unknown;
    stop_reason?: unknown;
    usage?: unknown;
  };
}

export interface AmpExecutionRequest {
  sessionId: string;
  prompt: string;
  /** Ordered multimodal input; omitted for text-only turns. */
  content?: AmpPromptContent[];
  options: AmpExecutionOptions;
  signal: AbortSignal;
  /** Inject this input into the live Amp process as a steer instruction. */
  steer?: boolean;
}

export type AmpPromptContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export interface AmpTransport {
  readonly name: 'cli' | 'sdk';
  /** Preserves the Amp process across ACP cancellation for cancel-then-prompt steering. */
  readonly supportsSteering?: boolean;
  execute(request: AmpExecutionRequest): AsyncIterable<AmpStreamMessage>;
  closeSession?(sessionId: string): void;
  closeAll?(): void;
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
    if (request.content) {
      const cli = createCliTransport();
      return (async function* () {
        try {
          yield* cli.execute(request);
        } finally {
          cli.closeAll?.();
        }
      })();
    }
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
    // thread feature on the CLI transport (`--features effort:<level>`);
    // the SDK transport (Orb) follows the mode's routing instead.
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

  args.push('--execute', options.thinking ? '--stream-json-thinking' : '--stream-json');
  if (options.executor === 'orb') {
    args.push('--orb-execute');
    if (options.project) args.push('--project', options.project);
  } else {
    // Streaming input keeps one local Amp process alive across turns and lets
    // a later prompt set Amp's top-level `steer` marker.
    args.push('--stream-json-input');
  }
  args.push('--no-archive-after-execute');
  if (options.mode) args.push('--mode', options.mode);
  if (options.effort) args.push('--features', `effort:${options.effort}`);
  if (options.dangerouslyAllowAll) args.push('--dangerously-allow-all');
  if (options.mcpConfig) args.push('--mcp-config', JSON.stringify(options.mcpConfig));

  return args;
}

function formatPromptInput(
  prompt: string,
  steer: boolean,
  content?: AmpPromptContent[],
): string {
  const blocks = content ?? [{ type: 'text', text: prompt }];
  return `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: blocks,
    },
    steer,
  })}\n`;
}

interface QueuedMessage {
  message: AmpStreamMessage;
  promptSequence?: number;
}

interface QueueWaiter {
  resolve(message: QueuedMessage): void;
  reject(error: Error): void;
}

class MessageQueue {
  private messages: QueuedMessage[] = [];
  private waiters: QueueWaiter[] = [];
  private error: Error | null = null;

  push(message: QueuedMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(message);
    } else {
      this.messages.push(message);
    }
  }

  fail(error: Error): void {
    if (this.error) return;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  shift(signal: AbortSignal): Promise<QueuedMessage> {
    if (signal.aborted) return Promise.reject(abortedError());
    const message = this.messages.shift();
    if (message) return Promise.resolve(message);
    if (this.error) return Promise.reject(this.error);

    return new Promise((resolve, reject) => {
      const waiter: QueueWaiter = {
        resolve: (next) => {
          signal.removeEventListener('abort', onAbort);
          resolve(next);
        },
        reject: (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(abortedError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }
}

interface CliSession {
  child: ChildProcessWithoutNullStreams;
  queue: MessageQueue;
  stderr: Buffer[];
  nextPromptSequence: number;
  pendingPromptEchoes: { prompt: string; sequence: number }[];
}

function abortedError(): Error {
  const error = new Error('Amp CLI prompt was cancelled');
  error.name = 'AbortError';
  return error;
}

function processExitError(
  code: number | null,
  processSignal: NodeJS.Signals | null,
  stderr: Buffer[],
): Error {
  if (code === null) return new Error(`Amp CLI process was killed by signal ${processSignal ?? 'unknown'}`);
  const details = Buffer.concat(stderr).toString().trim();
  return new Error(`Amp CLI process exited with code ${code}${details ? `: ${details}` : ''}`);
}

function getPromptText(prompt: string, content?: AmpPromptContent[]): string {
  if (!content) return prompt;
  return content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function isPromptEcho(message: AmpStreamMessage, prompt: string): boolean {
  if (message.type !== 'user' || message.parent_tool_use_id != null || !Array.isArray(message.message?.content)) return false;
  if (message.message.content.some((part) => (
    typeof part === 'object' && part !== null &&
    'type' in part && part.type === 'tool_result'
  ))) return false;
  const text = message.message.content
    .filter((part): part is { type: 'text'; text: string } => (
      typeof part === 'object' && part !== null &&
      'type' in part && part.type === 'text' &&
      'text' in part && typeof part.text === 'string'
    ))
    .map((part) => part.text)
    .join('');
  return text === prompt;
}

function isPromptComplete(message: AmpStreamMessage): boolean {
  const stopReason = message.message?.stop_reason;
  return message.type === 'result' || (
    message.type === 'assistant' &&
    message.parent_tool_use_id == null &&
    typeof stopReason === 'string' &&
    stopReason !== 'tool_use' &&
    stopReason !== 'pause_turn'
  );
}

async function* runOneShot(
  command: string,
  commandArgs: string[],
  request: AmpExecutionRequest,
): AsyncIterable<AmpStreamMessage> {
  const { prompt, content, options, signal } = request;
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
}

export function createCliTransport(
  command = process.env.AMP_CLI_PATH ?? 'amp',
  commandArgs: string[] = [],
  preserveCancelledProcess = process.env.AMP_ACP_CANCEL_MODE === 'steer',
): AmpTransport {
  const sessions = new Map<string, CliSession>();

  const terminateSession = (sessionId: string): Promise<void> => {
    const session = sessions.get(sessionId);
    if (!session) return Promise.resolve();
    sessions.delete(sessionId);
    if (session.child.exitCode !== null || session.child.signalCode !== null) return Promise.resolve();
    const closed = new Promise<void>((resolve) => session.child.once('close', () => resolve()));
    session.child.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
    return closed;
  };

  const closeSession = (sessionId: string): void => {
    void terminateSession(sessionId);
  };

  const startSession = (sessionId: string, options: AmpExecutionOptions): CliSession => {
    const child = spawn(command, [...commandArgs, ...buildAmpCliArgs(options)], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const session: CliSession = {
      child,
      queue: new MessageQueue(),
      stderr: [],
      nextPromptSequence: 0,
      pendingPromptEchoes: [],
    };
    sessions.set(sessionId, session);
    const failSession = (error: Error): void => {
      session.queue.fail(error);
      if (sessions.get(sessionId) === session) closeSession(sessionId);
    };
    child.stderr.on('data', (chunk: Buffer) => session.stderr.push(chunk));
    child.stdin.on('error', failSession);

    void (async () => {
      try {
        const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
        for await (const line of lines) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line) as AmpStreamMessage;
            const pendingIndex = session.pendingPromptEchoes.findIndex(
              (pending) => isPromptEcho(message, pending.prompt),
            );
            const promptSequence = pendingIndex === -1
              ? undefined
              : session.pendingPromptEchoes.splice(0, pendingIndex + 1).at(-1)?.sequence;
            session.queue.push({ message, promptSequence });
          } catch {
            throw new Error(`Failed to parse JSON response, raw line: ${line}`);
          }
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        failSession(failure);
      }
    })();

    child.once('error', failSession);
    child.once('close', (code, processSignal) => {
      if (sessions.get(sessionId) === session) sessions.delete(sessionId);
      session.queue.fail(processExitError(code, processSignal, session.stderr));
    });
    return session;
  };

  const writePrompt = async (
    session: CliSession,
    request: AmpExecutionRequest,
    promptText: string,
    steer: boolean,
  ): Promise<number> => {
    const sequence = ++session.nextPromptSequence;
    session.pendingPromptEchoes.push({ prompt: promptText, sequence });
    try {
      await new Promise<void>((resolve, reject) => {
        session.child.stdin.write(
          formatPromptInput(request.prompt, steer, request.content),
          (error) => error ? reject(error) : resolve(),
        );
      });
      return sequence;
    } catch (error) {
      const index = session.pendingPromptEchoes.findIndex((pending) => pending.sequence === sequence);
      if (index !== -1) session.pendingPromptEchoes.splice(index, 1);
      throw error;
    }
  };

  const transport: AmpTransport = {
    name: 'cli',
    supportsSteering: preserveCancelledProcess,
    async *execute(request) {
      if (request.options.executor === 'orb') {
        yield* runOneShot(command, commandArgs, request);
        return;
      }

      request.signal.throwIfAborted();
      const promptText = getPromptText(request.prompt, request.content);

      let session = sessions.get(request.sessionId);
      let inputSteer = request.steer === true;
      if (session?.pendingPromptEchoes.some((pending) => pending.prompt === promptText)) {
        await terminateSession(request.sessionId);
        request.signal.throwIfAborted();
        session = undefined;
        inputSteer = false;
      }
      session ??= startSession(request.sessionId, request.options);

      const promptSequence = await writePrompt(session, request, promptText, inputSteer);

      try {
        let promptEchoed = false;
        let lastEchoedSequence = 0;
        for (;;) {
          const queued = await session.queue.shift(request.signal);
          const { message } = queued;
          if (queued.promptSequence !== undefined && queued.promptSequence >= promptSequence) {
            promptEchoed = true;
            lastEchoedSequence = queued.promptSequence;
          } else if (!promptEchoed) {
            if (message.type === 'system') yield message;
            continue;
          }
          yield message;
          if (promptEchoed && lastEchoedSequence === session.nextPromptSequence && isPromptComplete(message)) return;
        }
      } catch (error) {
        if (request.signal.aborted) {
          if (!preserveCancelledProcess) await terminateSession(request.sessionId);
          throw abortedError();
        }
        throw error;
      }
    },
    closeSession,
    closeAll() {
      for (const sessionId of [...sessions.keys()]) closeSession(sessionId);
    },
  };

  return transport;
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
