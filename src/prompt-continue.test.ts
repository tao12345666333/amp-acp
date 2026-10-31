import { describe, it, beforeEach, afterEach, expect, mock } from 'bun:test';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type { AmpExecutionOptions, AmpExecutionRequest, AmpTransport } from './amp-transport.js';
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
  const originalOrbProject = process.env.AMP_ACP_ORB_PROJECT;

  beforeEach(async () => {
    capturedCalls.length = 0;
    mappings.clear();
    delete process.env.AMP_ACP_CONTINUE_LATEST;
    delete process.env.AMP_ACP_ORB_PROJECT;
    // Isolate from plugin modes installed on the developer machine.
    agent = new AmpAcpAgent(mockClient, createAmpTransport('sdk'), {
      threadStore: {
        load: async (sessionId) => mappings.get(sessionId) ?? null,
        save: async (mapping) => {
          mappings.set(mapping.sessionId, mapping);
        },
      },
      discoverPluginModes: () => [],
    });
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

  it('restarts the CLI process after a config change', async () => {
    const transport: AmpTransport = {
      name: 'cli',
      async *execute() {
        yield { type: 'system', subtype: 'init', session_id: threadId };
        yield { type: 'result', subtype: 'success', is_error: false };
      },
    };
    agent = new AmpAcpAgent(mockClient, transport);
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    await expect(agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'amp-mode',
      value: 'high',
    })).resolves.toMatchObject({ configOptions: expect.any(Array) });
    expect(agent.sessions.get(session.sessionId)?.processStarted).toBe(false);
  });

  it('allows config changes after cancellation before Amp reports its thread ID', async () => {
    const transport: AmpTransport = {
      name: 'cli',
      async *execute(request) {
        await new Promise<void>((resolve) => {
          request.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('Amp CLI prompt was cancelled');
      },
    };
    agent = new AmpAcpAgent(mockClient, transport);
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    const prompt = agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    while (!agent.sessions.get(session.sessionId)?.active) await Promise.resolve();
    await agent.cancel({ sessionId: session.sessionId });
    expect((await prompt).stopReason).toBe('cancelled');

    await expect(agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'permission',
      value: 'bypass',
    })).resolves.toMatchObject({ configOptions: expect.any(Array) });
    expect(agent.sessions.get(session.sessionId)?.processStarted).toBe(false);
  });

  it('steers after cancellation before Amp reports its thread ID', async () => {
    const requests: AmpExecutionRequest[] = [];
    const transport: AmpTransport = {
      name: 'cli',
      supportsSteering: true,
      async *execute(request) {
        requests.push(request);
        if (requests.length === 1) {
          await new Promise<void>((resolve) => {
            request.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          throw new Error('Amp CLI prompt was cancelled');
        }
        yield { type: 'result', subtype: 'success', is_error: false };
      },
    };
    agent = new AmpAcpAgent(mockClient, transport);
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    const firstPrompt = agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'first' }],
    });
    while (!agent.sessions.get(session.sessionId)?.active) await Promise.resolve();
    await agent.cancel({ sessionId: session.sessionId });
    expect((await firstPrompt).stopReason).toBe('cancelled');

    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'change direction' }],
    });

    expect(requests.map(({ options, steer }) => ({ continue: options.continue, steer }))).toEqual([
      { continue: undefined, steer: false },
      { continue: undefined, steer: true },
    ]);
  });

  it('does not steer after cancellation when the transport terminates the process', async () => {
    const requests: AmpExecutionRequest[] = [];
    const transport: AmpTransport = {
      name: 'cli',
      async *execute(request) {
        requests.push(request);
        if (requests.length === 1) {
          await new Promise<void>((resolve) => {
            request.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          throw new Error('Amp CLI prompt was cancelled');
        }
        yield { type: 'result', subtype: 'success', is_error: false };
      },
    };
    agent = new AmpAcpAgent(mockClient, transport);
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    const firstPrompt = agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'first' }],
    });
    while (!agent.sessions.get(session.sessionId)?.active) await Promise.resolve();
    await agent.cancel({ sessionId: session.sessionId });
    expect((await firstPrompt).stopReason).toBe('cancelled');

    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'try again' }],
    });

    expect(requests.map(({ steer }) => steer)).toEqual([false, false]);
  });

  it('keeps an immediate steering replacement cancellable while the old prompt unwinds', async () => {
    let releaseCancelledPrompt!: () => void;
    const cancelledPromptReleased = new Promise<void>((resolve) => {
      releaseCancelledPrompt = resolve;
    });
    const requests: AmpExecutionRequest[] = [];
    const transport: AmpTransport = {
      name: 'cli',
      supportsSteering: true,
      async *execute(request) {
        requests.push(request);
        await new Promise<void>((resolve) => {
          request.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        if (requests[0] === request) await cancelledPromptReleased;
        throw new Error('Amp CLI prompt was cancelled');
      },
    };
    agent = new AmpAcpAgent(mockClient, transport);
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    const firstPrompt = agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'first' }],
    });
    while (requests.length < 1) await Promise.resolve();
    await agent.cancel({ sessionId: session.sessionId });

    const replacementPrompt = agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'change direction' }],
    });
    while (requests.length < 2) await Promise.resolve();
    releaseCancelledPrompt();
    expect((await firstPrompt).stopReason).toBe('cancelled');

    await agent.cancel({ sessionId: session.sessionId });
    expect((await replacementPrompt).stopReason).toBe('cancelled');
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

  it('streams thinking to the SDK and leaves effort to CLI thread features', async () => {
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'reasoning-effort',
      value: 'high',
    });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(capturedCalls).toHaveLength(1);
    // The SDK maps effort to `--effort`, which current Amp CLI releases reject.
    expect(capturedCalls[0]!.options.effort).toBeUndefined();
    expect(capturedCalls[0]!.options.thinking).toBe(true);
  });

  it('passes reasoning effort to a CLI transport', async () => {
    const calls: AmpExecutionOptions[] = [];
    const transport: AmpTransport = {
      name: 'cli',
      async *execute({ options }) {
        calls.push(options);
        yield { type: 'system', subtype: 'init', session_id: threadId };
        yield { type: 'result', subtype: 'success', is_error: false };
      },
    };
    const cliAgent = new AmpAcpAgent(mockClient, transport, {
      threadStore: {
        load: async (sessionId) => mappings.get(sessionId) ?? null,
        save: async (mapping) => {
          mappings.set(mapping.sessionId, mapping);
        },
      },
      discoverPluginModes: () => [],
    });
    await cliAgent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    const session = await cliAgent.newSession({ cwd: '/tmp', mcpServers: [] });
    await cliAgent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'reasoning-effort',
      value: 'xhigh',
    });
    await cliAgent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.effort).toBe('xhigh');
    expect(calls[0]!.thinking).toBe(true);
  });

  it('passes reasoning effort on local image turns that fall back from the SDK to the CLI', async () => {
    const calls: AmpExecutionOptions[] = [];
    const sdkTransport: AmpTransport = {
      name: 'sdk',
      async *execute({ options }) {
        calls.push(options);
        yield { type: 'system', subtype: 'init', session_id: threadId };
        yield { type: 'result', subtype: 'success', is_error: false };
      },
    };
    const sdkAgent = new AmpAcpAgent(mockClient, sdkTransport, {
      orbTransport: sdkTransport,
      threadStore: {
        load: async (sessionId) => mappings.get(sessionId) ?? null,
        save: async (mapping) => {
          mappings.set(mapping.sessionId, mapping);
        },
      },
      discoverPluginModes: () => [],
    });
    await sdkAgent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await sdkAgent.newSession({ cwd: '/tmp', mcpServers: [] });
    await sdkAgent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'reasoning-effort',
      value: 'high',
    });
    const image = { type: 'image' as const, mimeType: 'image/png', data: 'AQID' };

    await sdkAgent.prompt({ sessionId: session.sessionId, prompt: [image] });
    await sdkAgent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hello' }] });
    await sdkAgent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'execution-environment',
      value: 'orb',
    });
    await sdkAgent.prompt({ sessionId: session.sessionId, prompt: [image] });

    expect(calls.map((options) => options.effort)).toEqual(['high', undefined, undefined]);
  });

  it('omits effort when auto is selected and can disable thinking', async () => {
    const saved = process.env.AMP_ACP_DISABLE_THINKING;
    process.env.AMP_ACP_DISABLE_THINKING = '1';
    try {
      const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
      await agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hello' }],
      });

      expect(capturedCalls).toHaveLength(1);
      expect(capturedCalls[0]!.options.effort).toBeUndefined();
      expect(capturedCalls[0]!.options.thinking).toBe(false);
    } finally {
      if (saved === undefined) {
        delete process.env.AMP_ACP_DISABLE_THINKING;
      } else {
        process.env.AMP_ACP_DISABLE_THINKING = saved;
      }
    }
  });

  it('uses the SDK for Orb execution and omits local-only options', async () => {
    process.env.AMP_ACP_ORB_PROJECT = 'acme/widgets';
    const localTransport = {
      name: 'cli' as const,
      async *execute() {
        throw new Error('local transport should not execute an Orb prompt');
      },
    };
    agent = new AmpAcpAgent(mockClient, localTransport, {
      orbTransport: createAmpTransport('sdk'),
      discoverPluginModes: () => [],
    });
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
      continue: threadId,
    });
  });

  it('restarts the local CLI process before switching execution environment', async () => {
    process.env.AMP_ACP_ORB_PROJECT = 'acme/widgets';
    const localCalls: { options: Record<string, unknown> }[] = [];
    const localTransport = {
      name: 'cli' as const,
      async *execute({ options }: { options: Record<string, unknown> }) {
        localCalls.push({ options });
        yield { type: 'system', subtype: 'init', session_id: threadId };
        yield { type: 'result', subtype: 'success', is_error: false };
      },
    };
    agent = new AmpAcpAgent(mockClient, localTransport, {
      orbTransport: createAmpTransport('sdk'),
      discoverPluginModes: () => [],
    });
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
    await expect(agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'execution-environment',
      value: 'orb',
    })).resolves.toMatchObject({ configOptions: expect.any(Array) });
    expect(agent.sessions.get(session.sessionId)?.processStarted).toBe(false);

    expect(localCalls).toHaveLength(1);
    expect(localCalls[0]!.options).toMatchObject({
      executor: 'local',
      dangerouslyAllowAll: true,
      mcpConfig: { local: { command: 'node', args: ['server.js'] } },
    });
    expect(capturedCalls).toHaveLength(0);
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

  it('marks the prompt after cancellation as a steer into the active Amp thread', async () => {
    const requests: AmpExecutionRequest[] = [];
    const transport: AmpTransport = {
      name: 'cli',
      supportsSteering: true,
      async *execute(request) {
        requests.push(request);
        yield { type: 'system', subtype: 'init', session_id: threadId };
        if (requests.length === 1) {
          await new Promise<void>((resolve) => {
            if (request.signal.aborted) {
              resolve();
              return;
            }
            request.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          throw new Error('Amp CLI process was aborted');
        }
        yield { type: 'result', subtype: 'success', is_error: false };
      },
    };
    agent = new AmpAcpAgent(mockClient, transport, {
      threadStore: {
        load: async (sessionId) => mappings.get(sessionId) ?? null,
        save: async (mapping) => {
          mappings.set(mapping.sessionId, mapping);
        },
      },
    });
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    const firstPrompt = agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'first' }],
    });

    while (agent.sessions.get(session.sessionId)?.threadId !== threadId) {
      await Promise.resolve();
    }
    await agent.cancel({ sessionId: session.sessionId });
    expect((await firstPrompt).stopReason).toBe('cancelled');

    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'change direction' }],
    });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'later follow-up' }],
    });

    expect(requests.map(({ options, steer }) => ({ continue: options.continue, steer }))).toEqual([
      { continue: undefined, steer: false },
      { continue: threadId, steer: true },
      { continue: threadId, steer: false },
    ]);
  });
});
