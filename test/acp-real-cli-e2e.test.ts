import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';

const RUN_LIVE_E2E = process.env.AMP_ACP_LIVE_E2E === '1';
const BINARY_PATH = path.resolve(__dirname, '../dist/amp-acp-test');
const REAL_CLI_PATH = process.env.AMP_ACP_REAL_CLI_PATH ?? 'amp';
const CONTINUATION_TOKEN = 'Kestrel-4179-Cobalt';
const CUSTOM_MODE_KEY = 'acp-flash';
const liveDescribe = RUN_LIVE_E2E ? describe : describe.skip;

// Registers a plugin-defined agent mode pinned to a non-default model.
// Requires the model to be usable by the Amp account running the test
// (zhipuai/glm-5.3-flash via BYOK or credits).
const CUSTOM_MODE_PLUGIN = `// @amp-agent-mode {"key":"${CUSTOM_MODE_KEY}","label":"${CUSTOM_MODE_KEY}"}

import type { PluginAPI } from '@ampcode/plugin'

export default function (amp: PluginAPI) {
	const flash = amp.createAgent({
		name: '${CUSTOM_MODE_KEY}',
		model: 'zhipuai/glm-5.3-flash',
		instructions: 'You are ${CUSTOM_MODE_KEY}, a custom Amp agent mode used to test the amp-acp adapter. Answer briefly and directly.',
		tools: 'all',
		reasoningEffort: 'low',
		display: { label: '${CUSTOM_MODE_KEY}', color: '#0ea5e9' },
	})

	amp.registerAgentMode({
		key: '${CUSTOM_MODE_KEY}',
		description: 'Fast GLM-5.3-Flash test mode for amp-acp adapter verification.',
		agent: flash.definition,
	})
}
`;

let fixtureDir = '';

beforeAll(async () => {
  if (!RUN_LIVE_E2E) return;

  const version = spawnSync(REAL_CLI_PATH, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) {
    const detail = version.error
      ? String(version.error)
      : (version.stderr ?? version.stdout ?? 'unknown error').trim();
    throw new Error(`Unable to run real Amp CLI at ${REAL_CLI_PATH}: ${detail}`);
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

  it('discovers and runs a plugin-defined custom agent mode', async () => {
    const pluginDir = path.join(fixtureDir, '.amp', 'plugins');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(path.join(pluginDir, 'acp-flash-mode.ts'), CUSTOM_MODE_PLUGIN);

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
            value: CUSTOM_MODE_KEY,
          });
          const prompt = await agent.request(methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{
              type: 'text',
              text: 'Reply with exactly AMP_ACP_MODE_E2E_OK and nothing else. Do not use tools or modify files.',
            }],
          });

          return { session, config, prompt };
        });

      const ampMode = result.session.configOptions?.find((option) => option.id === 'amp-mode');
      const modeValues = (ampMode?.options ?? []).map((option) => option.value);
      expect(modeValues).toContain(CUSTOM_MODE_KEY);
      expect(result.config.configOptions.find((option) => option.id === 'amp-mode')?.currentValue)
        .toBe(CUSTOM_MODE_KEY);
      expect(result.prompt.stopReason).toBe('end_turn');

      const assistantText = updates
        .map((notification) => notification.update)
        .filter((update) => update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
        .map((update) => update.content.text)
        .join('');
      expect(assistantText).toContain('AMP_ACP_MODE_E2E_OK');

      const logs = Buffer.concat(stderr).toString();
      const threadId = logs.match(/\[amp\] thread (T-[^\s]+)/)?.[1];
      expect(threadId).toBeDefined();

      // The custom mode pins zhipuai/glm-5.3-flash, so the thread's usage
      // report must show that model served the main request.
      const usage = spawnSync(REAL_CLI_PATH, ['threads', 'usage', threadId!, '--details'], {
        encoding: 'utf8',
      });
      expect(usage.status).toBe(0);
      expect(usage.stdout).toMatch(/glm-5\.3-flash/i);
      console.error(`[real-e2e] verified custom mode ${CUSTOM_MODE_KEY} on ${threadId}`);
    } catch (error) {
      const logs = Buffer.concat(stderr).toString().trim();
      throw new Error(`${error instanceof Error ? error.message : String(error)}${logs ? `\namp-acp stderr:\n${logs}` : ''}`);
    } finally {
      await stopProcess(process);
    }
  }, 180_000);
});
