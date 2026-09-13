import { describe, it, beforeEach, afterEach, expect, mock } from 'bun:test';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const capturedCalls: { options: Record<string, unknown> }[] = [];

mock.module('@ampcode/sdk', () => ({
  execute: ({ options }: { options: Record<string, unknown> }) => {
    capturedCalls.push({ options });
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'T-01234567-89ab-cdef-0123-456789abcdef' };
      yield { type: 'result', subtype: 'success', is_error: false };
    })();
  },
}));

const [{ AmpAcpAgent }, { createAmpTransport }] = await Promise.all([
  import('./server.js'),
  import('./amp-transport.js'),
]);

const mockClient = {
  sessionUpdate: async () => {},
  readTextFile: async () => ({ text: '' }),
  writeTextFile: async () => ({}),
  requestPermission: async () => ({ optionId: '' }),
  createTerminal: async () => ({ id: '' }),
  extMethod: async () => ({}),
  extNotification: async () => {},
} as unknown as AgentSideConnection;

const noHistory = async () => [];

function createAgent(): InstanceType<typeof AmpAcpAgent> {
  return new AmpAcpAgent(mockClient, createAmpTransport('sdk'), {
    exportThread: noHistory,
    replayRetry: { attempts: 1, delayMs: 0 },
  });
}

describe('AmpAcpAgent session/load', () => {
  let stateDir: string;

  beforeEach(() => {
    capturedCalls.length = 0;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-acp-state-'));
    process.env.AMP_ACP_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env.AMP_ACP_STATE_DIR;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('advertises the loadSession capability', async () => {
    const agent = createAgent();
    const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    expect(response.agentCapabilities?.loadSession).toBe(true);
  });

  it('rejects loading an unknown session', async () => {
    const agent = createAgent();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    await expect(
      agent.loadSession({ sessionId: 'S-unknown-000000', cwd: '/tmp', mcpServers: [] }),
    ).rejects.toThrow('Invalid params');
  });

  it('resumes the Amp thread across agent restarts', async () => {
    const first = createAgent();
    await first.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await first.newSession({ cwd: '/tmp', mcpServers: [] });
    await first.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.options.continue).toBeUndefined();

    // Simulate a fresh amp-acp process: new agent instance, empty session map.
    const second = createAgent();
    await second.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const loaded = await second.loadSession({
      sessionId: session.sessionId,
      cwd: '/tmp',
      mcpServers: [],
    });
    expect(loaded.configOptions).toBeDefined();

    await second.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'continue please' }],
    });

    expect(capturedCalls).toHaveLength(2);
    expect(capturedCalls[1]!.options.continue).toBe('T-01234567-89ab-cdef-0123-456789abcdef');
  });

  it('restores persisted permission mode and Amp mode', async () => {
    const first = createAgent();
    await first.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await first.newSession({ cwd: '/tmp', mcpServers: [] });
    await first.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    await first.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'amp-mode',
      value: 'high',
    });
    await first.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'permission',
      value: 'bypass',
    });

    const second = createAgent();
    await second.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const loaded = await second.loadSession({
      sessionId: session.sessionId,
      cwd: '/tmp',
      mcpServers: [],
    });

    const byId = new Map(loaded.configOptions?.map((option) => [option.id, option]));
    expect(byId.get('amp-mode')?.currentValue).toBe('high');
    expect(byId.get('permission')?.currentValue).toBe('bypass');

    await second.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'continue' }],
    });
    const lastCall = capturedCalls.at(-1)!;
    expect(lastCall.options.mode).toBe('high');
    expect(lastCall.options.dangerouslyAllowAll).toBe(true);
  });

  it('replays thread history as session/update notifications on load', async () => {
    const first = createAgent();
    await first.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await first.newSession({ cwd: '/tmp', mcpServers: [] });
    await first.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    const updates: unknown[] = [];
    const capturingClient = {
      ...mockClient,
      sessionUpdate: async (notification: unknown) => {
        updates.push(notification);
      },
    } as unknown as AgentSideConnection;

    const exportedThreads: string[] = [];
    const fakeExport = async (threadId: string) => {
      exportedThreads.push(threadId);
      return [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'pondering' }, { type: 'text', text: 'hi there' }] },
        { role: 'info', content: [{ type: 'summary', summary: 'skip me' }] },
      ];
    };

    const second = new AmpAcpAgent(capturingClient, createAmpTransport('sdk'), { exportThread: fakeExport });
    await second.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await second.loadSession({ sessionId: session.sessionId, cwd: '/tmp', mcpServers: [] });

    expect(exportedThreads).toEqual(['T-01234567-89ab-cdef-0123-456789abcdef']);
    const kinds = (updates as { update: { sessionUpdate: string } }[]).map((u) => u.update.sessionUpdate);
    expect(kinds).toEqual(['user_message_chunk', 'agent_thought_chunk', 'agent_message_chunk']);
    const texts = (updates as { update: { content?: { text?: string } } }[])
      .map((u) => u.update.content?.text)
      .filter(Boolean);
    expect(texts).toEqual(['hello', 'pondering', 'hi there']);
  });

  it('still loads the session when history export fails', async () => {
    const first = createAgent();
    await first.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await first.newSession({ cwd: '/tmp', mcpServers: [] });
    await first.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    const failingExport = async () => {
      throw new Error('export unavailable');
    };
    const second = new AmpAcpAgent(mockClient, createAmpTransport('sdk'), { exportThread: failingExport });
    await second.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const loaded = await second.loadSession({ sessionId: session.sessionId, cwd: '/tmp', mcpServers: [] });
    expect(loaded.configOptions).toBeDefined();
  });

  it('keeps sessions loadable before the first prompt completes', async () => {
    const agent = createAgent();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });

    // In-memory sessions without a thread yet are still valid to load.
    const loaded = await agent.loadSession({
      sessionId: session.sessionId,
      cwd: '/tmp',
      mcpServers: [],
    });
    expect(loaded.configOptions).toBeDefined();
  });

  it('restores persisted settings on session/resume too', async () => {
    const first = createAgent();
    await first.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await first.newSession({ cwd: '/tmp', mcpServers: [] });
    await first.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    await first.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'amp-mode',
      value: 'ultra',
    });

    const second = createAgent();
    await second.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const resumed = await second.resumeSession({
      sessionId: session.sessionId,
      cwd: '/tmp',
      mcpServers: [],
    });

    const byId = new Map(resumed.configOptions?.map((option) => [option.id, option]));
    expect(byId.get('amp-mode')?.currentValue).toBe('ultra');
  });
});
