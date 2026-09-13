import { beforeAll, describe, expect, it } from 'bun:test';
import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import path from 'node:path';

const RUN_ORB_E2E = process.env.AMP_ACP_ORB_LIVE_E2E === '1';
const BINARY_PATH = path.resolve(__dirname, '../dist/amp-acp-test');
const REPO_ROOT = path.resolve(__dirname, '..');
const ORB_TOKEN = 'AMP_ACP_ORB_E2E_OK';
const orbDescribe = RUN_ORB_E2E ? describe : describe.skip;

beforeAll(() => {
  if (!RUN_ORB_E2E) return;

  // The orb project is inferred from the git remote of the session cwd, so the
  // session must run in this repository and the signed-in account needs orb
  // access to it.
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (remote.status !== 0) {
    throw new Error('Orb e2e requires a git origin remote to infer the Amp project');
  }
  console.error(`[orb-e2e] origin remote ${remote.stdout.trim()}`);
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

orbDescribe('ACP client to Amp Orb execution', () => {
  it('runs a low-mode turn in an orb after switching execution-environment', async () => {
    const process = spawn(BINARY_PATH, [], {
      cwd: REPO_ROOT,
      env: { ...globalThis.process.env },
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
      const result = await client({ name: 'amp-acp-orb-e2e-client' })
        .onNotification(methods.client.session.update, (context) => {
          updates.push(context.params);
        })
        .connectWith(stream, async (agent) => {
          await agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const session = await agent.request(methods.agent.session.new, {
            cwd: REPO_ROOT,
            mcpServers: [],
          });
          const config = await agent.request(methods.agent.session.setConfigOption, {
            sessionId: session.sessionId,
            configId: 'execution-environment',
            value: 'orb',
          });
          await agent.request(methods.agent.session.setConfigOption, {
            sessionId: session.sessionId,
            configId: 'amp-mode',
            value: 'low',
          });
          const prompt = await agent.request(methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{
              type: 'text',
              text: `Reply with exactly ${ORB_TOKEN} and nothing else. Do not use tools or modify files.`,
            }],
          });
          return { config, prompt };
        });

      const assistantText = updates
        .map((notification) => notification.update)
        .filter((update) => update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
        .map((update) => update.content.text)
        .join('');

      expect(result.config.configOptions.find((option) => option.id === 'execution-environment')?.currentValue).toBe('orb');
      expect(result.prompt.stopReason).toBe('end_turn');
      expect(assistantText).toContain(ORB_TOKEN);

      const logs = Buffer.concat(stderr).toString();
      const threadId = logs.match(/\[amp\] thread (T-[^\s]+)/)?.[1];
      expect(threadId).toBeDefined();
      console.error(`[orb-e2e] verified orb turn on ${threadId}`);
    } catch (error) {
      const logs = Buffer.concat(stderr).toString().trim();
      throw new Error(`${error instanceof Error ? error.message : String(error)}${logs ? `\namp-acp stderr:\n${logs}` : ''}`);
    } finally {
      await stopProcess(process);
    }
  }, 180_000);
});
