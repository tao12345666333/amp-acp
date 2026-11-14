import type { AcpClient } from './acp-client.js';
import { describe, it, beforeEach, afterEach, expect, mock } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AmpThreadMapping } from './thread-mapping-store.js';
import type { AmpExecutionRequest, AmpStreamMessage, AmpTransport } from './amp-transport.js';

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
} as unknown as AcpClient;

const GROK45_PLUGIN = '// @amp-agent-mode {"key":"grok45","label":"Grok 4.5"}\nexport default function () {}\n';

const SAMPLE_MODELS = [
  { modelId: 'anthropic/claude-opus-5-5', name: 'Claude Opus 5.5' },
  { modelId: 'openai/gpt-6-sol', name: 'GPT-6 Sol' },
];

/** Transport that captures the execution options of each turn. */
function capturingCliTransport(name: AmpTransport['name'] = 'cli'): AmpTransport {
  return {
    name,
    async *execute(request: AmpExecutionRequest): AsyncIterable<AmpStreamMessage> {
      capturedCalls.push({ options: request.options as Record<string, unknown> });
      yield { type: 'system', subtype: 'init', session_id: 'T-01234567-89ab-cdef-0123-456789abcdef' };
      yield { type: 'result', subtype: 'success', is_error: false };
    },
  };
}

describe('AmpAcpAgent with plugin agent modes', () => {
  const originalEnv = process.env.AMP_ACP_SYSTEM_PLUGIN_DIR;
  const originalDisable = process.env.AMP_ACP_DISABLE_PLUGIN_LIST;

  beforeEach(() => {
    process.env.AMP_ACP_DISABLE_PLUGIN_LIST = '1';
  });

  afterEach(() => {
    capturedCalls.length = 0;
    if (originalEnv === undefined) {
      delete process.env.AMP_ACP_SYSTEM_PLUGIN_DIR;
    } else {
      process.env.AMP_ACP_SYSTEM_PLUGIN_DIR = originalEnv;
    }
    if (originalDisable === undefined) {
      delete process.env.AMP_ACP_DISABLE_PLUGIN_LIST;
    } else {
      process.env.AMP_ACP_DISABLE_PLUGIN_LIST = originalDisable;
    }
  });

  it('lists discovered models before plugin agent modes in the Model selector', async () => {
    const agent = new AmpAcpAgent(
      mockClient,
      createAmpTransport('sdk'),
      {
        discoverModels: () => SAMPLE_MODELS,
        discoverPluginModes: () => [{ modelId: 'grok45', name: 'Grok 4.5', source: 'grok-45-mode.ts' }],
      },
    );
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    const model = session.configOptions.find((option) => option.id === 'amp-model');
    expect(model?.options.map((option) => option.value)).toEqual([
      'default',
      'anthropic/claude-opus-5-5',
      'openai/gpt-6-sol',
      'grok45',
    ]);
    expect(model?.currentValue).toBe('default');
    expect(model?.options.at(-1)).toMatchObject({
      value: 'grok45',
      name: 'Grok 4.5',
    });
  });

  it('passes a selected plugin mode key to the SDK as the agent mode', async () => {
    const agent = new AmpAcpAgent(
      mockClient,
      createAmpTransport('sdk'),
      {
        discoverModels: () => SAMPLE_MODELS,
        discoverPluginModes: () => [{ modelId: 'grok45', name: 'Grok 4.5', source: 'grok-45-mode.ts' }],
      },
    );
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'amp-model',
      value: 'grok45',
    });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.options.mode).toBe('grok45');
    expect(capturedCalls[0]!.options.model).toBeUndefined();
  });

  it.each(['cli', 'sdk', 'orb'] as const)('passes a selected model id through %s execution', async (execution) => {
    const transport = capturingCliTransport(execution === 'cli' ? 'cli' : 'sdk');
    const agent = new AmpAcpAgent(
      mockClient,
      transport,
      {
        orbTransport: transport,
        discoverModels: () => SAMPLE_MODELS,
        discoverPluginModes: () => [],
      },
    );
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'amp-model',
      value: 'anthropic/claude-opus-5-5',
    });
    if (execution === 'orb') {
      await agent.setSessionConfigOption({ sessionId: session.sessionId, configId: 'execution-environment', value: 'orb' });
    }
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.options.model).toBe('anthropic/claude-opus-5-5');
    expect(capturedCalls[0]!.options.agentMode).toBeUndefined();
    expect(capturedCalls[0]!.options.executor).toBe(execution === 'orb' ? 'orb' : 'local');
  });

  it('selecting Default clears the model and agent mode', async () => {
    const agent = new AmpAcpAgent(
      mockClient,
      capturingCliTransport(),
      {
        discoverModels: () => SAMPLE_MODELS,
        discoverPluginModes: () => [],
      },
    );
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'amp-model',
      value: 'openai/gpt-6-sol',
    });
    const reset = await agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'amp-model',
      value: 'default',
    });

    const model = reset.configOptions.find((option) => option.id === 'amp-model');
    expect(model?.currentValue).toBe('default');
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    expect(capturedCalls[0]!.options.model).toBeUndefined();
    expect(capturedCalls[0]!.options.mode).toBeUndefined();
  });

  it('lists a plugin mode even when it shares a name with a model', async () => {
    const agent = new AmpAcpAgent(
      mockClient,
      createAmpTransport('sdk'),
      {
        discoverModels: () => [{ modelId: 'low-tier/model', name: 'Low' }],
        discoverPluginModes: () => [{ modelId: 'Low', name: 'Plugin Low', source: 'plugin.ts' }],
      },
    );
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    const model = session.configOptions.find((option) => option.id === 'amp-model');
    expect(model?.options.map((option) => option.value)).toEqual([
      'default',
      'low-tier/model',
      'Low',
    ]);
  });

  it('passes an unknown but non-empty selection through to Amp as an agent mode', async () => {
    const agent = new AmpAcpAgent(
      mockClient,
      createAmpTransport('sdk'),
      { discoverModels: () => SAMPLE_MODELS, discoverPluginModes: () => [] },
    );
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    const result = await agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'amp-model',
      value: 'some-future-mode',
    });

    // Amp is the authority on selection resolution, so unknown values are
    // accepted here and stay visible in the selector.
    const model = result.configOptions.find((option) => option.id === 'amp-model');
    expect(model?.currentValue).toBe('some-future-mode');
    expect(model?.options.map((option) => option.value)).toContain('some-future-mode');

    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.options.mode).toBe('some-future-mode');
  });

  it('rejects an empty Model selection', async () => {
    const agent = new AmpAcpAgent(
      mockClient,
      createAmpTransport('sdk'),
      { discoverModels: () => SAMPLE_MODELS, discoverPluginModes: () => [] },
    );
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    expect(
      agent.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: 'amp-model',
        value: '   ',
      }),
    ).rejects.toThrow('Model must be a non-empty string');
  });

  it('keeps the persisted agent mode on resume when its plugin is not discovered', async () => {
    const mappings = new Map<string, AmpThreadMapping>();
    const agent = new AmpAcpAgent(
      mockClient,
      createAmpTransport('sdk'),
      {
        discoverModels: () => SAMPLE_MODELS,
        discoverPluginModes: () => [],
        threadStore: {
          load: async (sessionId) => mappings.get(sessionId) ?? null,
          save: async (mapping) => {
            mappings.set(mapping.sessionId, mapping);
          },
        },
      },
    );
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    mappings.set('S-restore-custom', {
      sessionId: 'S-restore-custom',
      threadId: 'T-01234567-89ab-cdef-0123-456789abcdef',
      mode: 'default',
      agentMode: 'acp-flash',
      executor: 'local',
      cwd: '/tmp',
    });

    const resumed = await agent.resumeSession({ sessionId: 'S-restore-custom', cwd: '/tmp', mcpServers: [] });
    const model = resumed.configOptions.find((option) => option.id === 'amp-model');
    expect(model?.currentValue).toBe('acp-flash');
    expect(model?.options.map((option) => option.value)).toContain('acp-flash');
  });

  it('treats legacy dial values persisted before the model selector as unselected', async () => {
    const mappings = new Map<string, AmpThreadMapping>();
    const agent = new AmpAcpAgent(
      mockClient,
      createAmpTransport('sdk'),
      {
        discoverModels: () => SAMPLE_MODELS,
        discoverPluginModes: () => [],
        threadStore: {
          load: async (sessionId) => mappings.get(sessionId) ?? null,
          save: async (mapping) => {
            mappings.set(mapping.sessionId, mapping);
          },
        },
      },
    );
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    mappings.set('S-restore-dial', {
      sessionId: 'S-restore-dial',
      threadId: 'T-01234567-89ab-cdef-0123-456789abcdef',
      mode: 'default',
      model: 'medium',
      executor: 'local',
      cwd: '/tmp',
    });

    const resumed = await agent.resumeSession({ sessionId: 'S-restore-dial', cwd: '/tmp', mcpServers: [] });
    const model = resumed.configOptions.find((option) => option.id === 'amp-model');
    expect(model?.currentValue).toBe('default');
  });

  it('selects and restores a model id even when discovery does not list it', async () => {
    const mappings = new Map<string, AmpThreadMapping>();
    const agent = new AmpAcpAgent(
      mockClient,
      capturingCliTransport(),
      {
        discoverModels: () => [],
        discoverPluginModes: () => [],
        threadStore: {
          load: async (sessionId) => mappings.get(sessionId) ?? null,
          save: async (mapping) => {
            mappings.set(mapping.sessionId, mapping);
          },
        },
      },
    );
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'amp-model',
      value: 'openai/gpt-6-sol',
    });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'first turn' }],
    });
    expect(capturedCalls[0]!.options.model).toBe('openai/gpt-6-sol');
    expect(mappings.get(session.sessionId)?.model).toBe('openai/gpt-6-sol');

    agent.close();
    const restarted = new AmpAcpAgent(mockClient, capturingCliTransport(), {
      discoverModels: () => [],
      discoverPluginModes: () => [],
      threadStore: {
        load: async (sessionId) => mappings.get(sessionId) ?? null,
        save: async (mapping) => { mappings.set(mapping.sessionId, mapping); },
      },
    });
    const resumed = await restarted.resumeSession({ sessionId: session.sessionId, cwd: '/tmp', mcpServers: [] });
    const model = resumed.configOptions.find((option) => option.id === 'amp-model');
    expect(model?.currentValue).toBe('openai/gpt-6-sol');

    await restarted.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    expect(capturedCalls[1]!.options.model).toBe('openai/gpt-6-sol');
    expect(capturedCalls[1]!.options.agentMode).toBeUndefined();
    expect(mappings.get(session.sessionId)?.model).toBe('openai/gpt-6-sol');
    expect(mappings.get(session.sessionId)?.agentMode).toBeUndefined();
  });

  it('classifies a legacy persisted plugin agent key as an agent mode', async () => {
    const mappings = new Map<string, AmpThreadMapping>();
    const agent = new AmpAcpAgent(
      mockClient,
      createAmpTransport('sdk'),
      {
        discoverModels: () => SAMPLE_MODELS,
        discoverPluginModes: () => [],
        threadStore: {
          load: async (sessionId) => mappings.get(sessionId) ?? null,
          save: async (mapping) => {
            mappings.set(mapping.sessionId, mapping);
          },
        },
      },
    );
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    // Mappings written before the model/agent-mode split stored agent keys
    // in the `model` field.
    mappings.set('S-restore-legacy-agent', {
      sessionId: 'S-restore-legacy-agent',
      threadId: 'T-01234567-89ab-cdef-0123-456789abcdef',
      mode: 'default',
      model: 'acp-flash',
      executor: 'local',
      cwd: '/tmp',
    });

    const resumed = await agent.resumeSession({ sessionId: 'S-restore-legacy-agent', cwd: '/tmp', mcpServers: [] });
    const model = resumed.configOptions.find((option) => option.id === 'amp-model');
    expect(model?.currentValue).toBe('acp-flash');

    await agent.prompt({
      sessionId: 'S-restore-legacy-agent',
      prompt: [{ type: 'text', text: 'hello' }],
    });
    expect(capturedCalls[0]!.options.mode).toBe('acp-flash');
    expect(capturedCalls[0]!.options.model).toBeUndefined();
  });

  it('discovers plugin modes from the system plugin dir by default', async () => {
    const systemDir = mkdtempSync(path.join(os.tmpdir(), 'amp-acp-server-'));
    writeFileSync(path.join(systemDir, 'grok-45-mode.ts'), GROK45_PLUGIN);
    process.env.AMP_ACP_SYSTEM_PLUGIN_DIR = systemDir;

    try {
      const agent = new AmpAcpAgent(
        mockClient,
        createAmpTransport('sdk'),
        { discoverModels: () => SAMPLE_MODELS },
      );
      await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

      const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
      const model = session.configOptions.find((option) => option.id === 'amp-model');
      expect(model?.options.map((option) => option.value)).toContain('grok45');
    } finally {
      rmSync(systemDir, { recursive: true, force: true });
    }
  });

  it('exposes Workspace plugin modes from amp plugins list', async () => {
    const { discoverPluginModes } = await import('./plugin-modes.js');
    const agent = new AmpAcpAgent(
      mockClient,
      createAmpTransport('sdk'),
      {
        discoverModels: () => SAMPLE_MODELS,
        discoverPluginModes: (cwd) => discoverPluginModes(cwd, {
          listPlugins: () => `✓ official-modes (Workspace Plugins) active
  agent mode: grok45
`,
        }),
      },
    );
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    const model = session.configOptions.find((option) => option.id === 'amp-model');
    expect(model?.options.map((option) => option.value)).toContain('grok45');
    expect(model?.options.find((option) => option.value === 'grok45')).toMatchObject({
      value: 'grok45',
      name: 'grok45',
    });
  });
});
