import { describe, it, beforeEach, afterEach, expect, mock } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const GROK45_PLUGIN = '// @amp-agent-mode {"key":"grok45","label":"Grok 4.5"}\nexport default function () {}\n';

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

  it('exposes plugin modes in session config options via injected discovery', async () => {
    const agent = new AmpAcpAgent(
      mockClient,
      createAmpTransport('sdk'),
      () => [{ modelId: 'grok45', name: 'Grok 4.5', source: 'grok-45-mode.ts' }],
    );
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    const ampMode = session.configOptions.find((option) => option.id === 'amp-mode');
    expect(ampMode?.options.map((option) => option.value)).toEqual([
      'low',
      'medium',
      'high',
      'ultra',
      'grok45',
    ]);
    expect(ampMode?.options.at(-1)).toMatchObject({
      value: 'grok45',
      name: 'Grok 4.5',
    });
  });

  it('accepts a plugin mode key in setSessionConfigOption and passes it to the SDK', async () => {
    const agent = new AmpAcpAgent(
      mockClient,
      createAmpTransport('sdk'),
      () => [{ modelId: 'grok45', name: 'Grok 4.5', source: 'grok-45-mode.ts' }],
    );
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'amp-mode',
      value: 'grok45',
    });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.options.mode).toBe('grok45');
  });

  it('still rejects unknown modes', async () => {
    const agent = new AmpAcpAgent(mockClient, createAmpTransport('sdk'), () => []);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    expect(
      agent.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: 'amp-mode',
        value: 'not-a-mode',
      }),
    ).rejects.toThrow('Unsupported Amp mode: not-a-mode');
  });

  it('discovers plugin modes from the system plugin dir by default', async () => {
    const systemDir = mkdtempSync(path.join(os.tmpdir(), 'amp-acp-server-'));
    writeFileSync(path.join(systemDir, 'grok-45-mode.ts'), GROK45_PLUGIN);
    process.env.AMP_ACP_SYSTEM_PLUGIN_DIR = systemDir;

    try {
      const agent = new AmpAcpAgent(mockClient, createAmpTransport('sdk'));
      await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

      const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
      const ampMode = session.configOptions.find((option) => option.id === 'amp-mode');
      expect(ampMode?.options.map((option) => option.value)).toContain('grok45');
    } finally {
      rmSync(systemDir, { recursive: true, force: true });
    }
  });

  it('exposes Workspace plugin modes from amp plugins list', async () => {
    const { discoverPluginModes } = await import('./plugin-modes.js');
    const agent = new AmpAcpAgent(
      mockClient,
      createAmpTransport('sdk'),
      (cwd) => discoverPluginModes(cwd, {
        listPlugins: () => `✓ official-modes (Workspace Plugins) active
  agent mode: grok45
`,
      }),
    );
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    const ampMode = session.configOptions.find((option) => option.id === 'amp-mode');
    expect(ampMode?.options.map((option) => option.value)).toContain('grok45');
    expect(ampMode?.options.find((option) => option.value === 'grok45')).toMatchObject({
      value: 'grok45',
      name: 'grok45',
    });
  });
});
