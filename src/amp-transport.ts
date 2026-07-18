import { execute, type AmpOptions } from '@ampcode/sdk';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

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

export interface AmpExecutionOptions {
  cwd: string;
  env?: Record<string, string>;
  mode?: 'deep' | 'smart' | 'rush' | 'large';
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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
  message?: {
    content: unknown;
  };
}

export interface AmpExecutionRequest {
  prompt: string;
  options: AmpExecutionOptions;
  signal: AbortSignal;
}

export interface AmpTransport {
  readonly name: 'cli' | 'sdk';
  execute(request: AmpExecutionRequest): AsyncIterable<AmpStreamMessage>;
}

const sdkTransport: AmpTransport = {
  name: 'sdk',
  execute(request) {
    return execute({
      prompt: request.prompt,
      options: request.options as AmpOptions,
      signal: request.signal,
    });
  },
};

export function buildAmpCliArgs(options: AmpExecutionOptions): string[] {
  const args: string[] = [];

  if (typeof options.continue === 'string') {
    args.push('threads', 'continue', options.continue);
  } else if (options.continue) {
    args.push('threads', 'continue', '--last');
  }

  args.push('--execute', '--stream-json');
  if (options.mode) args.push('--mode', options.mode);
  if (options.effort) args.push('--effort', options.effort);
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
    async *execute({ prompt, options, signal }) {
      signal.throwIfAborted();

      const child = spawn(command, [...commandArgs, ...buildAmpCliArgs(options)], {
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
      child.stdin.end(prompt);

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
