import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const BINARY_PATH = path.resolve(__dirname, '../dist/amp-acp-test');

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

let fixtureDir: string;
let fakeAmpPath: string;

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'amp-acp-v2-e2e-'));
  fakeAmpPath = path.join(fixtureDir, 'amp.mjs');
  await writeFile(fakeAmpPath, `#!/usr/bin/env node
import { createInterface } from 'node:readline';

createInterface({ input: process.stdin }).on('line', (line) => {
  const input = JSON.parse(line);
  const prompt = input.message.content.map((part) => part.text ?? '').join('');
  console.log(JSON.stringify({ type: 'user', message: { content: input.message.content } }));
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'T-01a03c00-e608-7007-8181-5c1cc56757be' }));
  console.log(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'v2 reply: ' + prompt }] },
  }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }));
});
`);
  await chmod(fakeAmpPath, 0o755);
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

async function stopProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return;
  process.stdin?.end();
  process.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => process.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]);
}

describe('ACP v2 adapter', () => {
  it('answers initialize with protocol version 2 and streams an idle turn', async () => {
    const process = spawn(BINARY_PATH, [], {
      cwd: fixtureDir,
      env: {
        ...globalThis.process.env,
        AMP_ACP_PROTOCOL: 'v2',
        AMP_ACP_TRANSPORT: 'cli',
        AMP_CLI_PATH: fakeAmpPath,
        AMP_API_KEY: 'test-key',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const messages: JsonRpcMessage[] = [];
    let buffer = '';
    process.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        if (line.trim()) messages.push(JSON.parse(line) as JsonRpcMessage);
      }
    });

    const send = (id: number, method: string, params: Record<string, unknown>): void => {
      process.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    };
    const waitFor = async (predicate: (message: JsonRpcMessage) => boolean): Promise<JsonRpcMessage> => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const message = messages.find(predicate);
        if (message) return message;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('timed out waiting for ACP v2 message');
    };

    try {
      send(1, 'initialize', {
        protocolVersion: 2,
        info: { name: 'v2-e2e', version: '0.0.0' },
        capabilities: {},
      });
      const initialized = await waitFor((message) => message.id === 1);
      expect(initialized.result?.protocolVersion).toBe(2);
      expect(initialized.result?.info).toMatchObject({ name: 'amp-acp' });

      send(2, 'session/new', { cwd: fixtureDir, mcpServers: [] });
      const created = await waitFor((message) => message.id === 2);
      const sessionId = created.result?.sessionId;
      expect(typeof sessionId).toBe('string');
      const configOptions = created.result?.configOptions as Array<Record<string, unknown>>;
      expect(configOptions.every((option) => typeof option.configId === 'string')).toBe(true);

      send(3, 'session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'hello v2' }],
      });
      const prompted = await waitFor((message) => message.id === 3);
      const messageId = prompted.result?.messageId;
      expect(typeof messageId).toBe('string');

      const userMessage = await waitFor(
        (message) =>
          message.method === 'session/update' &&
          (message.params?.update as { sessionUpdate?: string }).sessionUpdate === 'user_message_chunk',
      );
      expect((userMessage.params?.update as { messageId?: string }).messageId).toBe(messageId);

      const idle = await waitFor(
        (message) =>
          message.method === 'session/update' &&
          (message.params?.update as { sessionUpdate?: string; state?: string }).sessionUpdate === 'state_update' &&
          (message.params?.update as { state?: string }).state === 'idle',
      );
      expect((idle.params?.update as { stopReason?: string }).stopReason).toBe('end_turn');
      expect(
        messages.some(
          (message) =>
            message.method === 'session/update' &&
            (message.params?.update as { content?: { text?: string } }).content?.text === 'v2 reply: hello v2',
        ),
      ).toBe(true);
    } finally {
      await stopProcess(process);
    }
  });
});
