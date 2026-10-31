import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';

const BINARY_PATH = path.resolve(__dirname, '../dist/amp-acp-test');

let fixtureDir: string;
let fakeAmpPath: string;

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'amp-acp-e2e-'));
  fakeAmpPath = path.join(fixtureDir, 'amp.mjs');
  await writeFile(fakeAmpPath, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
let promptCount = 0;
createInterface({ input: process.stdin }).on('line', (line) => {
  const input = JSON.parse(line);
  const prompt = input.message.content.map((part) => part.text).join('');
  promptCount += 1;
  const continued = promptCount > 1;
  if (promptCount === 1) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'T-01a03c00-e608-7007-8181-5c1cc56757be' }));
  }
  console.log(JSON.stringify({ type: 'user', message: { content: input.message.content } }));
  if (prompt === 'cancel me') return;
  console.log(JSON.stringify({
    type: 'assistant',
    message: { content: [
      { type: 'thinking', thinking: 'Checking the request' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'README.md' } },
    ] },
  }));
  console.log(JSON.stringify({
    type: 'user',
    message: { content: [
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'fixture result', is_error: false },
    ] },
  }));
  console.log(JSON.stringify({
    type: 'assistant',
    message: {
      content: [{
        type: 'text',
        text: 'reply:' + prompt + ';continued:' + continued + ';steer:' + input.steer,
      }],
      stop_reason: 'end_turn',
    },
  }));
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

describe('ACP client to compiled amp-acp binary', () => {
  it('streams a complete CLI-backed prompt lifecycle and cancellation', async () => {
    const process = spawn(BINARY_PATH, [], {
      cwd: fixtureDir,
      env: {
        ...globalThis.process.env,
        AMP_ACP_TRANSPORT: 'cli',
        AMP_ACP_CANCEL_MODE: 'steer',
        AMP_CLI_PATH: fakeAmpPath,
        AMP_API_KEY: 'test-key',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stderr: Buffer[] = [];
    process.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));

    const updates: SessionNotification[] = [];
    const stream = ndJsonStream(
      Writable.toWeb(process.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdout!) as ReadableStream<Uint8Array>,
    );

    try {
      const result = await client({ name: 'amp-acp-e2e-client' })
        .onNotification(methods.client.session.update, (context) => {
          updates.push(context.params);
        })
        .connectWith(stream, async (agent) => {
          const initialized = await agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const session = await agent.request(methods.agent.session.new, {
            cwd: fixtureDir,
            mcpServers: [],
          });
          const first = await agent.request(methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'first prompt' }],
          });
          const second = await agent.request(methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'second prompt' }],
          });

          const cancelledPrompt = agent.request(methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'cancel me' }],
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
          await agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId });

          const cancelled = await cancelledPrompt;
          const steered = await agent.request(methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'change direction' }],
          });

          return {
            initialized,
            first,
            second,
            cancelled,
            steered,
          };
        });

      expect(result.initialized.agentInfo?.name).toBe('amp-acp');
      expect(result.first.stopReason).toBe('end_turn');
      expect(result.second.stopReason).toBe('end_turn');
      expect(result.cancelled.stopReason).toBe('cancelled');
      expect(result.steered.stopReason).toBe('end_turn');

      const sessionUpdates = updates.map((notification) => notification.update);
      expect(sessionUpdates).toContainEqual(expect.objectContaining({ sessionUpdate: 'agent_thought_chunk' }));
      expect(sessionUpdates).toContainEqual(expect.objectContaining({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
      }));
      expect(sessionUpdates).toContainEqual(expect.objectContaining({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
      }));
      expect(sessionUpdates).toContainEqual(expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'reply:first prompt;continued:false;steer:false' },
      }));
      expect(sessionUpdates).toContainEqual(expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'reply:second prompt;continued:true;steer:false' },
      }));
      expect(sessionUpdates).toContainEqual(expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'reply:change direction;continued:true;steer:true' },
      }));

      process.stdin!.end();
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => process.once('exit', () => resolve(true))),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      expect(exited).toBe(true);
    } catch (error) {
      const logs = Buffer.concat(stderr).toString().trim();
      throw new Error(`${error instanceof Error ? error.message : String(error)}${logs ? `\namp-acp stderr:\n${logs}` : ''}`);
    } finally {
      await stopProcess(process);
    }
  });
});
