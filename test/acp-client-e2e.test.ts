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
  fakeAmpPath = path.join(fixtureDir, 'amp');
  await writeFile(fakeAmpPath, `#!/usr/bin/env node
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;

const continued = process.argv.includes('continue');
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'T-acp-e2e' }));
if (prompt === 'cancel me') await new Promise((resolve) => setTimeout(resolve, 30000));
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
  message: { content: [{ type: 'text', text: 'reply:' + prompt + ';continued:' + continued }] },
}));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }));
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

          return {
            initialized,
            first,
            second,
            cancelled: await cancelledPrompt,
          };
        });

      expect(result.initialized.agentInfo?.name).toBe('amp-acp');
      expect(result.first.stopReason).toBe('end_turn');
      expect(result.second.stopReason).toBe('end_turn');
      expect(result.cancelled.stopReason).toBe('cancelled');

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
        content: { type: 'text', text: 'reply:first prompt;continued:false' },
      }));
      expect(sessionUpdates).toContainEqual(expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'reply:second prompt;continued:true' },
      }));
    } catch (error) {
      const logs = Buffer.concat(stderr).toString().trim();
      throw new Error(`${error instanceof Error ? error.message : String(error)}${logs ? `\namp-acp stderr:\n${logs}` : ''}`);
    } finally {
      await stopProcess(process);
    }
  });
});
