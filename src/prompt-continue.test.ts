import { describe, it, beforeEach, afterEach, expect, mock } from 'bun:test';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';

const capturedCalls: { options: Record<string, unknown> }[] = [];

mock.module('@ampcode/sdk', () => ({
  execute: ({ options }: { options: Record<string, unknown> }) => {
    capturedCalls.push({ options });
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'T-test-thread-id' };
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
  const originalOrbProject = process.env.AMP_ACP_ORB_PROJECT;

  beforeEach(async () => {
    capturedCalls.length = 0;
    delete process.env.AMP_ACP_CONTINUE_LATEST;
    delete process.env.AMP_ACP_ORB_PROJECT;
    agent = new AmpAcpAgent(mockClient, createAmpTransport('sdk'));
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AMP_ACP_CONTINUE_LATEST;
    } else {
      process.env.AMP_ACP_CONTINUE_LATEST = originalEnv;
    }
    if (originalOrbProject === undefined) {
      delete process.env.AMP_ACP_ORB_PROJECT;
    } else {
      process.env.AMP_ACP_ORB_PROJECT = originalOrbProject;
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

  it('uses the SDK for Orb execution and omits local-only options', async () => {
    process.env.AMP_ACP_ORB_PROJECT = 'acme/widgets';
    const localTransport = {
      name: 'cli' as const,
      async *execute() {
        throw new Error('local transport should not execute an Orb prompt');
      },
    };
    agent = new AmpAcpAgent(mockClient, localTransport, createAmpTransport('sdk'));
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await agent.newSession({
      cwd: '/tmp',
      mcpServers: [{ name: 'local', command: 'node', args: ['server.js'], env: [] }],
    });
    await agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'permission',
      value: 'bypass',
    });
    await agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'execution-environment',
      value: 'orb',
    });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello from Orb' }],
    });

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.options).toMatchObject({
      executor: 'orb',
      project: 'acme/widgets',
      mode: 'medium',
    });
    expect(capturedCalls[0]!.options.dangerouslyAllowAll).toBeUndefined();
    expect(capturedCalls[0]!.options.mcpConfig).toBeUndefined();
  });

  it('continues the same Orb thread on subsequent prompts', async () => {
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'execution-environment',
      value: 'orb',
    });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'first' }],
    });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'second' }],
    });

    expect(capturedCalls).toHaveLength(2);
    expect(capturedCalls[0]!.options.executor).toBe('orb');
    expect(capturedCalls[1]!.options).toMatchObject({
      executor: 'orb',
      continue: 'T-test-thread-id',
    });
  });

  it('preserves thread and local-only options when switching between local and Orb', async () => {
    process.env.AMP_ACP_ORB_PROJECT = 'acme/widgets';
    const localCalls: { options: Record<string, unknown> }[] = [];
    const localTransport = {
      name: 'cli' as const,
      async *execute({ options }: { options: Record<string, unknown> }) {
        localCalls.push({ options });
        yield { type: 'system', subtype: 'init', session_id: 'T-local-thread' };
        yield { type: 'result', subtype: 'success', is_error: false };
      },
    };
    agent = new AmpAcpAgent(mockClient, localTransport, createAmpTransport('sdk'));
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await agent.newSession({
      cwd: '/tmp',
      mcpServers: [{ name: 'local', command: 'node', args: ['server.js'], env: [] }],
    });
    await agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'permission',
      value: 'bypass',
    });

    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'local' }] });
    await agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'execution-environment',
      value: 'orb',
    });
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'orb' }] });
    await agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'execution-environment',
      value: 'local',
    });
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'local again' }] });

    expect(localCalls).toHaveLength(2);
    expect(localCalls[0]!.options).toMatchObject({
      executor: 'local',
      dangerouslyAllowAll: true,
      mcpConfig: { local: { command: 'node', args: ['server.js'] } },
    });
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.options).toMatchObject({
      executor: 'orb',
      project: 'acme/widgets',
      continue: 'T-local-thread',
    });
    expect(capturedCalls[0]!.options.dangerouslyAllowAll).toBeUndefined();
    expect(capturedCalls[0]!.options.mcpConfig).toBeUndefined();
    expect(localCalls[1]!.options).toMatchObject({
      executor: 'local',
      continue: 'T-local-thread',
      dangerouslyAllowAll: true,
      mcpConfig: { local: { command: 'node', args: ['server.js'] } },
    });
    expect(localCalls[1]!.options.project).toBeUndefined();
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
    expect(capturedCalls[1]!.options.continue).toBe('T-test-thread-id');
  });
});
