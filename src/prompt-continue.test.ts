import { describe, it, beforeEach, afterEach, expect, mock } from 'bun:test';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type { AmpThreadMapping } from './thread-mapping-store.js';

const capturedCalls: { options: Record<string, unknown> }[] = [];
const threadId = 'T-01a03c00-e608-7007-8181-5c1cc56757be';
const mappings = new Map<string, AmpThreadMapping>();

mock.module('@ampcode/sdk', () => ({
  execute: ({ options }: { options: Record<string, unknown> }) => {
    capturedCalls.push({ options });
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: threadId };
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

describe('AmpAcpAgent prompt() continue option', () => {
  let agent: InstanceType<typeof AmpAcpAgent>;
  const originalEnv = process.env.AMP_ACP_CONTINUE_LATEST;

  beforeEach(async () => {
    capturedCalls.length = 0;
    mappings.clear();
    delete process.env.AMP_ACP_CONTINUE_LATEST;
    agent = new AmpAcpAgent(mockClient, createAmpTransport('sdk'), {
      threadStore: {
        load: async (sessionId) => mappings.get(sessionId) ?? null,
        save: async (mapping) => {
          mappings.set(mapping.sessionId, mapping);
        },
      },
    });
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AMP_ACP_CONTINUE_LATEST;
    } else {
      process.env.AMP_ACP_CONTINUE_LATEST = originalEnv;
    }
  });

  it('does not set continue on first prompt when env var is unset (default)', async () => {
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.options.continue).toBeUndefined();
    expect(capturedCalls[0]!.options.mode).toBe('medium');
  });

  it('passes selected Amp mode to the SDK', async () => {
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.setSessionConfigOption({ sessionId: session.sessionId, configId: 'amp-mode', value: 'ultra' });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.options.mode).toBe('ultra');
  });

  it('passes low mode to the SDK', async () => {
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.setSessionConfigOption({ sessionId: session.sessionId, configId: 'amp-mode', value: 'low' });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.options.mode).toBe('low');
  });

  it('passes selected permission config to the SDK', async () => {
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.setSessionConfigOption({ sessionId: session.sessionId, configId: 'permission', value: 'bypass' });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.options.dangerouslyAllowAll).toBe(true);
  });

  it('sets continue=true on first prompt when AMP_ACP_CONTINUE_LATEST is set', async () => {
    process.env.AMP_ACP_CONTINUE_LATEST = '1';
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.options.continue).toBe(true);
  });

  it('passes captured threadId on subsequent prompts regardless of env var', async () => {
    process.env.AMP_ACP_CONTINUE_LATEST = '1';
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'first' }],
    });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'second' }],
    });

    expect(capturedCalls).toHaveLength(2);
    expect(capturedCalls[0]!.options.continue).toBe(true);
    expect(capturedCalls[1]!.options.continue).toBe(threadId);
  });
});
