import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';

const RUN_LIVE_E2E = process.env.AMP_ACP_LIVE_E2E === '1';
const BINARY_PATH = path.resolve(__dirname, '../dist/amp-acp-test');
const REAL_CLI_PATH = process.env.AMP_ACP_REAL_CLI_PATH ?? 'amp';
const CONTINUATION_TOKEN = 'Kestrel-4179-Cobalt';
const liveDescribe = RUN_LIVE_E2E ? describe : describe.skip;

let fixtureDir = '';

beforeAll(async () => {
  if (!RUN_LIVE_E2E) return;

  const version = spawnSync(REAL_CLI_PATH, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) {
    throw new Error(`Unable to run real Amp CLI at ${REAL_CLI_PATH}: ${version.stderr.trim()}`);
  }
  console.error(`[real-e2e] Amp CLI ${version.stdout.trim()}`);
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'amp-acp-real-e2e-'));
});

afterAll(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
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

liveDescribe('ACP client to real Amp CLI', () => {
  it('streams two low-mode turns on the same real Amp thread', async () => {
    const process = spawn(BINARY_PATH, [], {
      cwd: fixtureDir,
      env: {
        ...globalThis.process.env,
        AMP_ACP_TRANSPORT: 'cli',
        AMP_CLI_PATH: REAL_CLI_PATH,
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
      const result = await client({ name: 'amp-acp-real-e2e-client' })
        .onNotification(methods.client.session.update, (context) => {
          updates.push(context.params);
        })
        .connectWith(stream, async (agent) => {
          await agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const session = await agent.request(methods.agent.session.new, {
            cwd: fixtureDir,
            mcpServers: [],
          });
          const config = await agent.request(methods.agent.session.setConfigOption, {
            sessionId: session.sessionId,
            configId: 'amp-mode',
            value: 'low',
          });

          const first = await agent.request(methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{
              type: 'text',
              text: `Remember the token ${CONTINUATION_TOKEN} for my next message. Reply with exactly AMP_ACP_REAL_E2E_OK and nothing else. Do not use tools or modify files.`,
            }],
          });
          const firstUpdateCount = updates.length;
          const second = await agent.request(methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{
              type: 'text',
              text: 'Reply with exactly the token I asked you to remember in my previous message. Do not use tools or modify files.',
            }],
          });

          return { config, first, second, firstUpdateCount };
        });

      const assistantText = (from: number, to?: number) => updates
        .slice(from, to)
        .map((notification) => notification.update)
        .filter((update) => update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
        .map((update) => update.content.text)
        .join('');

      expect(result.config.configOptions.find((option) => option.id === 'amp-mode')?.currentValue).toBe('low');
      expect(result.first.stopReason).toBe('end_turn');
      expect(result.second.stopReason).toBe('end_turn');
      expect(assistantText(0, result.firstUpdateCount)).toContain('AMP_ACP_REAL_E2E_OK');
      expect(assistantText(result.firstUpdateCount)).toContain(CONTINUATION_TOKEN);

      const logs = Buffer.concat(stderr).toString();
      const threadId = logs.match(/\[amp\] thread (T-[^\s]+)/)?.[1];
      expect(threadId).toBeDefined();
      console.error(`[real-e2e] verified continuation on ${threadId}`);
    } catch (error) {
      const logs = Buffer.concat(stderr).toString().trim();
      throw new Error(`${error instanceof Error ? error.message : String(error)}${logs ? `\namp-acp stderr:\n${logs}` : ''}`);
    } finally {
      await stopProcess(process);
    }
  }, 180_000);
});
