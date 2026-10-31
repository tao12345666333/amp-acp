import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { AgentSideConnection, SessionNotification } from '@agentclientprotocol/sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AmpStreamMessage, AmpTransport } from './amp-transport.js';
import { AmpAcpAgent } from './server.js';
import type { ExportedThreadMessage } from './thread-history.js';

const threadId = 'T-01234567-89ab-cdef-0123-456789abcdef';
const MESSAGE: ExportedThreadMessage = {
  role: 'user',
  content: [{ type: 'text', text: 'hello' }],
};

function createTransport(): AmpTransport {
  return {
    name: 'cli',
    async *execute(): AsyncIterable<AmpStreamMessage> {
      yield { type: 'system', subtype: 'init', session_id: threadId };
      yield { type: 'result', subtype: 'success', is_error: false };
    },
  };
}

function createClient(updates: SessionNotification[]): AgentSideConnection {
  return {
    sessionUpdate: async (notification: SessionNotification) => {
      updates.push(notification);
    },
    readTextFile: async () => ({ text: '' }),
    writeTextFile: async () => ({}),
    requestPermission: async () => ({ optionId: '' }),
    createTerminal: async () => ({ id: '' }),
    extMethod: async () => ({}),
    extNotification: async () => {},
  } as unknown as AgentSideConnection;
}

function sessionInfoUpdates(updates: SessionNotification[]) {
  return updates.flatMap((notification) => {
    const update = notification.update;
    return update.sessionUpdate === 'session_info_update' ? [update] : [];
  });
}

describe('session title and updatedAt', () => {
  let stateDir: string;
  let updates: SessionNotification[];

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-acp-state-'));
    process.env.AMP_ACP_STATE_DIR = stateDir;
    updates = [];
  });

  afterEach(() => {
    delete process.env.AMP_ACP_STATE_DIR;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function createAgent(exportThread = async () => [MESSAGE]) {
    return new AmpAcpAgent(createClient(updates), createTransport(), {
      exportThread,
      replayRetry: { attempts: 1, delayMs: 0 },
      discoverPluginModes: () => [],
    });
  }

  it('derives a title from the first prompt and updates it on later turns', async () => {
    const agent = createAgent();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });

    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: '  Fix   the\nlogin bug  ' }],
    });

    const first = sessionInfoUpdates(updates);
    expect(first).toHaveLength(1);
    expect(first[0]!.title).toBe('Fix the login bug');
    expect(first[0]!.updatedAt).toBeString();
    expect(new Date(first[0]!.updatedAt!).toISOString()).toBe(first[0]!.updatedAt);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Now add a test' }],
    });

    const second = sessionInfoUpdates(updates);
    expect(second).toHaveLength(2);
    expect(second[1]!.title).toBe('Fix the login bug');
    expect(second[1]!.updatedAt).not.toBe(first[0]!.updatedAt);
  });

  it('truncates a long first prompt to 60 characters', async () => {
    const agent = createAgent();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });

    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'x'.repeat(80) }],
    });

    expect(sessionInfoUpdates(updates)[0]!.title).toHaveLength(60);
  });

  it('uses a fallback title when the first turn has no text', async () => {
    const agent = createAgent();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });

    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }],
    });

    expect(sessionInfoUpdates(updates)[0]!.title).toBe('Amp session');
  });

  it('restores the persisted title and timestamp on load', async () => {
    const first = createAgent();
    await first.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await first.newSession({ cwd: '/tmp', mcpServers: [] });
    await first.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Persist this title' }],
    });
    const persisted = sessionInfoUpdates(updates)[0]!;
    updates.length = 0;

    const second = createAgent();
    await second.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await second.loadSession({ sessionId: session.sessionId, cwd: '/tmp', mcpServers: [] });

    const restored = sessionInfoUpdates(updates);
    expect(restored.at(-1)?.title).toBe('Persist this title');
    expect(restored.at(-1)?.updatedAt).toBe(persisted.updatedAt);
  });

  it('prefers the title and timestamp exported by Amp', async () => {
    const first = createAgent();
    await first.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await first.newSession({ cwd: '/tmp', mcpServers: [] });
    await first.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Local title' }],
    });
    updates.length = 0;

    const second = createAgent(async () => ({
      messages: [MESSAGE],
      title: 'Amp exported title',
      updatedAt: '2026-10-31T12:00:00.000Z',
    }));
    await second.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await second.loadSession({ sessionId: session.sessionId, cwd: '/tmp', mcpServers: [] });

    const restored = sessionInfoUpdates(updates);
    expect(restored.at(-1)?.title).toBe('Amp exported title');
    expect(restored.at(-1)?.updatedAt).toBe('2026-10-31T12:00:00.000Z');
  });

  it('publishes the persisted title on resume', async () => {
    const first = createAgent();
    await first.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await first.newSession({ cwd: '/tmp', mcpServers: [] });
    await first.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Resume title' }],
    });
    updates.length = 0;

    const second = createAgent();
    await second.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await second.resumeSession({ sessionId: session.sessionId, cwd: '/tmp', mcpServers: [] });

    expect(sessionInfoUpdates(updates).at(-1)?.title).toBe('Resume title');
  });
});
