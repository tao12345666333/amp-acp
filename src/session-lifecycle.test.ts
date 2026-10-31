import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AmpStreamMessage, AmpTransport } from './amp-transport.js';
import { AmpAcpAgent } from './server.js';

const threadId = 'T-01234567-89ab-cdef-0123-456789abcdef';

function createClient(): AgentSideConnection {
  return {
    sessionUpdate: async () => {},
    readTextFile: async () => ({ text: '' }),
    writeTextFile: async () => ({}),
    requestPermission: async () => ({ optionId: '' }),
    createTerminal: async () => ({ id: '' }),
    extMethod: async () => ({}),
    extNotification: async () => {},
  } as unknown as AgentSideConnection;
}

function fastTransport(): AmpTransport {
  return {
    name: 'cli',
    async *execute(): AsyncIterable<AmpStreamMessage> {
      yield { type: 'system', subtype: 'init', session_id: threadId };
      yield { type: 'result', subtype: 'success', is_error: false };
    },
  };
}

describe('session list, delete, and close', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-acp-state-'));
    process.env.AMP_ACP_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env.AMP_ACP_STATE_DIR;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function createAgent(transport = fastTransport()) {
    return new AmpAcpAgent(createClient(), transport, {
      exportThread: async () => [],
      replayRetry: { attempts: 1, delayMs: 0 },
      discoverPluginModes: () => [],
    });
  }

  it('lists a new session before its first prompt and after the turn completes', async () => {
    const agent = createAgent();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });

    const before = await agent.listSessions({ cwd: '/tmp' });
    expect(before.sessions).toHaveLength(1);
    expect(before.sessions[0]!.sessionId).toBe(session.sessionId);
    expect(before.sessions[0]!.cwd).toBe('/tmp');
    expect(before.sessions[0]!.title).toBeUndefined();

    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'List this session' }],
    });

    const after = await agent.listSessions({ cwd: '/tmp' });
    expect(after.sessions[0]!.title).toBe('List this session');
    expect(after.sessions[0]!.updatedAt).toBeString();
  });

  it('lists sessions across adapter restarts and filters by cwd', async () => {
    const first = createAgent();
    await first.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await first.newSession({ cwd: '/tmp', mcpServers: [] });
    await first.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Persisted listing' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await first.newSession({ cwd: '/var/tmp', mcpServers: [] });

    const second = createAgent();
    await second.initialize({ protocolVersion: 1, clientCapabilities: {} });

    const filtered = await second.listSessions({ cwd: '/tmp' });
    expect(filtered.sessions.map((entry) => entry.sessionId)).toEqual([session.sessionId]);
    expect(filtered.sessions[0]!.title).toBe('Persisted listing');

    const all = await second.listSessions({});
    expect(all.sessions).toHaveLength(2);
    expect(all.sessions[0]!.cwd).toBe('/var/tmp');
  });

  it('rejects an invalid list cursor', async () => {
    const agent = createAgent();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await agent.newSession({ cwd: '/tmp', mcpServers: [] });

    await expect(agent.listSessions({ cwd: '/tmp', cursor: 'not-a-cursor' }))
      .rejects.toThrow('Invalid session list cursor');
  });

  it('deletes mappings idempotently and keeps load and resume unavailable afterwards', async () => {
    const agent = createAgent();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Delete me' }],
    });

    await agent.deleteSession({ sessionId: session.sessionId });
    await agent.deleteSession({ sessionId: session.sessionId });
    await agent.deleteSession({ sessionId: 'S-unknown-000000' });
    await agent.closeSession({ sessionId: 'S-unknown-000000' });

    expect((await agent.listSessions({})).sessions).toEqual([]);
    await expect(agent.loadSession({ sessionId: session.sessionId, cwd: '/tmp', mcpServers: [] }))
      .rejects.toThrow('No durable Amp thread mapping');
    await expect(agent.resumeSession({ sessionId: session.sessionId, cwd: '/tmp', mcpServers: [] }))
      .rejects.toThrow('No durable Amp thread mapping');
  });

  it('closes an in-memory session but keeps its mapping for load', async () => {
    const agent = createAgent();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Close keeps me' }],
    });

    await agent.closeSession({ sessionId: session.sessionId });
    await agent.closeSession({ sessionId: session.sessionId });
    expect(agent.sessions.has(session.sessionId)).toBe(false);
    expect((await agent.listSessions({})).sessions[0]!.title).toBe('Close keeps me');

    const restarted = createAgent();
    await restarted.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const loaded = await restarted.loadSession({ sessionId: session.sessionId, cwd: '/tmp', mcpServers: [] });
    expect(loaded.configOptions).toBeDefined();
  });

  it('cancels active and queued turns when a session is deleted', async () => {
    let started!: () => void;
    const turnStarted = new Promise<void>((resolve) => { started = resolve; });
    const slow: AmpTransport = {
      name: 'cli',
      async *execute({ signal }): AsyncIterable<AmpStreamMessage> {
        yield { type: 'system', subtype: 'init', session_id: threadId };
        started();
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    };

    const agent = createAgent(slow);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });

    const active = agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'active' }],
    });
    await turnStarted;
    const queued = agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'queued' }],
    });

    await agent.deleteSession({ sessionId: session.sessionId });

    await expect(active).resolves.toEqual({ stopReason: 'cancelled' });
    await expect(queued).resolves.toEqual({ stopReason: 'cancelled' });
    expect((await agent.listSessions({})).sessions).toEqual([]);
  });
});
