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

// End-to-end coverage for the durable thread lifecycle: ACP session -> Amp
// thread mapping must survive an adapter process restart so that
// session/resume can continue the exact same Amp thread.

const BINARY_PATH = path.resolve(__dirname, '../dist/amp-acp-test');
const THREAD_ID = 'T-01234567-89ab-cdef-0123-456789abcdef';

let fixtureDir: string;
let stateDir: string;
let fakeAmpPath: string;
let fakeLogPath: string;

interface FakeAmpInvocation {
  argv: string[];
  prompt: string | null;
}

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'amp-acp-resume-e2e-'));
  stateDir = path.join(fixtureDir, 'state');
  fakeAmpPath = path.join(fixtureDir, 'amp');
  fakeLogPath = path.join(fixtureDir, 'amp-invocations.jsonl');
  await writeFile(fakeAmpPath, `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
const record = (prompt) =>
  fs.appendFileSync(process.env.AMP_FAKE_LOG, JSON.stringify({ argv, prompt }) + '\\n');

if (argv[0] === 'threads' && argv[1] === 'archive') {
  record(null);
  process.exit(0);
}

let prompt = '';
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
  record(prompt);
  const continued = argv.includes('continue');
  console.log(JSON.stringify({
    type: 'system', subtype: 'init', session_id: '${THREAD_ID}',
  }));
  console.log(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'echo:' + prompt + ';continued:' + continued }] },
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
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr: Buffer[] = [];
  child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
  const updates: SessionNotification[] = [];
  const connection = client({ name: 'amp-acp-resume-e2e-client' })
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

describe('durable session resume across adapter restarts', () => {
  it('resumes the mapped Amp thread after the adapter process is killed', async () => {
    const first = spawnAdapter();
    let sessionId = '';

    try {
      await first.connection.connectWith(streamOf(first.process), async (agent) => {
        const init = await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        expect(init.agentCapabilities.sessionCapabilities?.resume).toEqual({});
        expect(
          init.agentCapabilities._meta?.['amp-acp/thread-lifecycle'],
        ).toEqual({
          version: 1,
          methods: {
            nativeMetadata: 'amp-acp/session/native-metadata',
            setArchived: 'amp-acp/thread/set-archived',
          },
        });

        const session = await agent.request(methods.agent.session.new, {
          cwd: fixtureDir,
          mcpServers: [],
        });
        sessionId = session.sessionId;

        const turn = await agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'first turn' }],
        });
        expect(turn.stopReason).toBe('end_turn');

        const meta = await agent.request<Record<string, unknown>>(
          'amp-acp/session/native-metadata',
          { sessionId },
        );
        expect(meta.ampThreadId).toBe(THREAD_ID);
      });
    } catch (error) {
      const logs = Buffer.concat(first.stderr).toString().trim();
      throw new Error(`${error instanceof Error ? error.message : String(error)}${logs ? `\namp-acp stderr:\n${logs}` : ''}`);
    } finally {
      await killProcess(first.process);
    }

    // The mapping must have been persisted while the first process was alive.
    const mappingPath = path.join(stateDir, 'sessions', `${sessionId}.json`);
    const mapping = JSON.parse(await readFile(mappingPath, 'utf8')) as {
      sessionId: string;
      threadId: string;
    };
    expect(mapping).toEqual({ sessionId, threadId: THREAD_ID });

    // Second adapter process, same state dir: resume must reattach.
    const second = spawnAdapter();
    try {
      await second.connection.connectWith(streamOf(second.process), async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });

        const resume = await agent.request(methods.agent.session.resume, {
          sessionId,
          cwd: fixtureDir,
          mcpServers: [],
        });
        expect(Array.isArray(resume.configOptions)).toBe(true);

        const turn = await agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'second turn' }],
        });
        expect(turn.stopReason).toBe('end_turn');

        // Unknown sessions must be rejected.
        const unknown = await agent
          .request(methods.agent.session.resume, {
            sessionId: 'S-nonexistent-abc123',
            cwd: fixtureDir,
            mcpServers: [],
          })
          .then(() => null)
          .catch((error: unknown) => error);
        expect(unknown).not.toBeNull();

        // Lifecycle: archive the mapped thread through the extension method.
        const archived = await agent.request<Record<string, unknown>>(
          'amp-acp/thread/set-archived',
          { sessionId, threadId: THREAD_ID, archived: true },
        );
        expect(archived.archived).toBe(true);

        // Archiving a thread that does not belong to this session must fail.
        const mismatched = await agent
          .request<Record<string, unknown>>('amp-acp/thread/set-archived', {
            sessionId,
            threadId: 'T-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            archived: true,
          })
          .then(() => null)
          .catch((error: unknown) => error);
        expect(mismatched).not.toBeNull();
      });
    } catch (error) {
      const logs = Buffer.concat(second.stderr).toString().trim();
      throw new Error(`${error instanceof Error ? error.message : String(error)}${logs ? `\namp-acp stderr:\n${logs}` : ''}`);
    } finally {
      await killProcess(second.process);
    }

    const invocations = await fakeAmpInvocations();
    const executions = invocations.filter((entry) => entry.prompt !== null);
    const archives = invocations.filter(
      (entry) => entry.argv[0] === 'threads' && entry.argv[1] === 'archive',
    );

    // Turn 1 ran a fresh thread; turn 2 must continue the persisted thread.
    expect(executions.length).toBe(2);
    expect(executions[0]!.argv).not.toContain('continue');
    expect(executions[1]!.argv.slice(0, 3)).toEqual(['threads', 'continue', THREAD_ID]);
    expect(executions[1]!.prompt).toBe('second turn');
    expect(archives.map((entry) => entry.argv)).toContainEqual([
      'threads',
      'archive',
      THREAD_ID,
    ]);
  }, 30_000);
});
