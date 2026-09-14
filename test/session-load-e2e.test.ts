import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';

// End-to-end coverage for session/load: after an adapter restart the client
// must receive the replayed thread history, the persisted session settings,
// and follow-up prompts must continue the exact same Amp thread.

const BINARY_PATH = path.resolve(__dirname, '../dist/amp-acp-test');
const THREAD_ID = 'T-01234567-89ab-cdef-0123-456789abcdef';
const MARKER = 'marker-alpha-4771';

let fixtureDir: string;
let stateDir: string;
let fakeAmpPath: string;
let fakeLogPath: string;
let fakeTranscriptPath: string;

interface FakeAmpInvocation {
  argv: string[];
  prompt: string | null;
}

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'amp-acp-load-e2e-'));
  stateDir = path.join(fixtureDir, 'state');
  fakeAmpPath = path.join(fixtureDir, 'amp');
  fakeLogPath = path.join(fixtureDir, 'amp-invocations.jsonl');
  fakeTranscriptPath = path.join(fixtureDir, 'amp-transcript.jsonl');
  await writeFile(fakeAmpPath, `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
const transcript = process.env.AMP_FAKE_TRANSCRIPT;
const record = (prompt) =>
  fs.appendFileSync(process.env.AMP_FAKE_LOG, JSON.stringify({ argv, prompt }) + '\\n');

// Mode discovery: simulate an Amp CLI with no plugin modes (no output, not recorded).
if (argv[0] === 'plugins' && argv[1] === 'list') {
  process.exit(0);
}

if (argv[0] === 'threads' && argv[1] === 'export') {
  record(null);
  const lines = fs.existsSync(transcript)
    ? fs.readFileSync(transcript, 'utf8').split('\\n').filter((line) => line.trim())
    : [];
  const messages = lines.map((line) => {
    const entry = JSON.parse(line);
    return { role: entry.role, content: [{ type: 'text', text: entry.text }] };
  });
  console.log(JSON.stringify({ v: 101, id: argv[2], messages }));
  process.exit(0);
}

let prompt = '';
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
  record(prompt);
  fs.appendFileSync(transcript, JSON.stringify({ role: 'user', text: prompt }) + '\\n');
  fs.appendFileSync(transcript, JSON.stringify({ role: 'assistant', text: 'echo:' + prompt }) + '\\n');
  console.log(JSON.stringify({
    type: 'system', subtype: 'init', session_id: '${THREAD_ID}',
  }));
  console.log(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'echo:' + prompt }] },
  }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }));
});
`);
  await chmod(fakeAmpPath, 0o755);
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

async function fakeAmpInvocations(): Promise<FakeAmpInvocation[]> {
  const contents = await readFile(fakeLogPath, 'utf8');
  return contents
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as FakeAmpInvocation);
}

function spawnAdapter() {
  const child = spawn(BINARY_PATH, [], {
    cwd: fixtureDir,
    env: {
      ...globalThis.process.env,
      AMP_ACP_TRANSPORT: 'cli',
      AMP_CLI_PATH: fakeAmpPath,
      AMP_ACP_STATE_DIR: stateDir,
      AMP_FAKE_LOG: fakeLogPath,
      AMP_FAKE_TRANSCRIPT: fakeTranscriptPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr: Buffer[] = [];
  child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
  const updates: SessionNotification[] = [];
  const connection = client({ name: 'amp-acp-load-e2e-client' })
    .onNotification(methods.client.session.update, (context) => {
      updates.push(context.params);
    });
  return { process: child, updates, stderr, connection };
}

function killProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return Promise.resolve();
  process.kill('SIGKILL');
  return Promise.race([
    new Promise<void>((resolve) => process.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]);
}

function streamOf(process: ChildProcess) {
  return ndJsonStream(
    Writable.toWeb(process.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdout!) as ReadableStream<Uint8Array>,
  );
}

function stderrOf(adapter: { stderr: Buffer[] }): string {
  return Buffer.concat(adapter.stderr).toString().trim();
}

describe('session/load across adapter restarts', () => {
  it('replays history, restores settings, and continues the same Amp thread', async () => {
    const first = spawnAdapter();
    let sessionId = '';

    try {
      await first.connection.connectWith(streamOf(first.process), async (agent) => {
        const init = await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        expect(init.agentCapabilities.loadSession).toBe(true);

        const session = await agent.request(methods.agent.session.new, {
          cwd: fixtureDir,
          mcpServers: [],
        });
        sessionId = session.sessionId;

        await agent.request(methods.agent.session.setConfigOption, {
          sessionId,
          configId: 'amp-mode',
          value: 'high',
        });

        const turn = await agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: MARKER }],
        });
        expect(turn.stopReason).toBe('end_turn');
      });
    } catch (error) {
      const logs = stderrOf(first);
      throw new Error(`${error instanceof Error ? error.message : String(error)}${logs ? `\namp-acp stderr:\n${logs}` : ''}`);
    } finally {
      await killProcess(first.process);
    }

    // Settings must have been persisted alongside the thread mapping.
    const mappingPath = path.join(stateDir, 'sessions', `${sessionId}.json`);
    const mapping = JSON.parse(await readFile(mappingPath, 'utf8')) as Record<string, unknown>;
    expect(mapping).toEqual({
      sessionId,
      threadId: THREAD_ID,
      mode: 'default',
      model: 'high',
      executor: 'local',
      cwd: fixtureDir,
    });

    // Second adapter process, same state dir: load must reattach and replay.
    const second = spawnAdapter();
    try {
      await second.connection.connectWith(streamOf(second.process), async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });

        const loaded = await agent.request(methods.agent.session.load, {
          sessionId,
          cwd: fixtureDir,
          mcpServers: [],
        });
        const byId = new Map(
          (loaded.configOptions ?? []).map((option) => [option.id, option.currentValue]),
        );
        expect(byId.get('amp-mode')).toBe('high');
        expect(byId.get('permission')).toBe('default');

        // The pre-restart transcript must have been replayed as updates.
        const replayed = second.updates
          .filter((update) => update.sessionId === sessionId)
          .map((update) => update.update);
        const textOf = (update: (typeof replayed)[number]): string =>
          'content' in update && update.content && 'text' in update.content
            ? String(update.content.text)
            : '';
        const userChunks = replayed.filter((u) => u.sessionUpdate === 'user_message_chunk');
        const agentChunks = replayed.filter((u) => u.sessionUpdate === 'agent_message_chunk');
        expect(userChunks.some((u) => textOf(u).includes(MARKER))).toBe(true);
        expect(agentChunks.some((u) => textOf(u).includes(`echo:${MARKER}`))).toBe(true);

        const turn = await agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'second turn' }],
        });
        expect(turn.stopReason).toBe('end_turn');

        // Unknown sessions must be rejected.
        const unknown = await agent
          .request(methods.agent.session.load, {
            sessionId: 'S-nonexistent-abc123',
            cwd: fixtureDir,
            mcpServers: [],
          })
          .then(() => null)
          .catch((error: unknown) => error);
        expect(unknown).toBeTruthy();
      });
    } catch (error) {
      const logs = stderrOf(second);
      throw new Error(`${error instanceof Error ? error.message : String(error)}${logs ? `\namp-acp stderr:\n${logs}` : ''}`);
    } finally {
      await killProcess(second.process);
    }

    // The follow-up prompt must continue the mapped thread with the persisted mode.
    const invocations = await fakeAmpInvocations();
    const executes = invocations.filter((i) => i.prompt !== null);
    expect(executes).toHaveLength(2);
    const followUp = executes[1]!;
    expect(followUp.argv).toContain('continue');
    expect(followUp.argv).toContain(THREAD_ID);
    const modeIndex = followUp.argv.indexOf('--mode');
    expect(modeIndex).toBeGreaterThanOrEqual(0);
    expect(followUp.argv[modeIndex + 1]).toBe('high');

    // The load must have exported exactly the mapped thread's history.
    const exports = invocations.filter((i) => i.argv[0] === 'threads' && i.argv[1] === 'export');
    expect(exports).toHaveLength(1);
    expect(exports[0]!.argv[2]).toBe(THREAD_ID);
  });
});
