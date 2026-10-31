import { describe, it, beforeEach, expect } from 'bun:test';
import { ClientSideConnection, AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { AmpAcpAgent } from './server.js';
import { toAcpNotifications } from './to-acp.js';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { AmpExecutionRequest, AmpTransport } from './amp-transport.js';

class TestClient {
  notifications: SessionNotification[] = [];
  async writeTextFile() { return {}; }
  async readTextFile() { return { content: 'test' }; }
  async requestPermission() { return { outcome: { outcome: 'selected' as const, optionId: 'allow' } }; }
  async sessionUpdate(notification: SessionNotification) {
    this.notifications.push(notification);
  }
}

describe('ACP Protocol End-to-End', () => {
  let clientToAgent: TransformStream;
  let agentToClient: TransformStream;
  let agentConnection: ClientSideConnection;
  let testClient: TestClient;
  let prompts: AmpExecutionRequest[];

  beforeEach(() => {
    prompts = [];
    const transport: AmpTransport = {
      name: 'cli',
      async *execute(request) {
        prompts.push(request);
        yield { type: 'result', is_error: false };
      },
    };
    clientToAgent = new TransformStream();
    agentToClient = new TransformStream();
    testClient = new TestClient();

    agentConnection = new ClientSideConnection(
      () => testClient,
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );
    new AgentSideConnection(
      // Isolate from plugin modes installed on the developer machine.
      (client) => new AmpAcpAgent(client, transport, { orbTransport: transport, discoverPluginModes: () => [] }),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );
  });

  it.each([{}, { auth: { terminal: false } }, { terminal: true }])(
    'should return correct capabilities and legacy auth for client capabilities %j',
    async (clientCapabilities) => {
      const response = await agentConnection.initialize({
        protocolVersion: 1,
        clientCapabilities,
      });

      expect(response.protocolVersion).toBe(1);
      expect(response.agentInfo?.name).toBe('amp-acp');
      expect(response.agentInfo?.version).toBeDefined();
      expect(response.agentCapabilities?.promptCapabilities?.image).toBe(true);
      expect(response.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(true);
      expect(response.agentCapabilities?.mcpCapabilities?.http).toBe(true);
      expect(response.agentCapabilities?.mcpCapabilities?.sse).toBe(true);
      expect(response.agentCapabilities?.sessionCapabilities?.resume).toEqual({});
      expect(response.agentCapabilities?.sessionCapabilities?.list).toEqual({});
      expect(response.agentCapabilities?.sessionCapabilities?.delete).toEqual({});
      expect(response.agentCapabilities?.sessionCapabilities?.close).toEqual({});
      expect(response.agentCapabilities?._meta?.['amp-acp/thread-lifecycle']).toEqual({
        version: 1,
        methods: {
          nativeMetadata: 'amp-acp/session/native-metadata',
          setArchived: 'amp-acp/thread/set-archived',
        },
      });
      expect(response.authMethods).toHaveLength(1);
      expect(response.authMethods![0].id).toBe('setup');
      expect(response.authMethods![0].name).toBe('Amp API Key Setup');
      expect(response.authMethods![0].type).toBeUndefined();
      expect(response.authMethods![0]._meta?.['terminal-auth']?.command).toBeDefined();
      expect(response.authMethods![0]._meta?.['terminal-auth']?.args).toEqual(['--setup']);
      expect(response.authMethods![0]._meta?.['terminal-auth']?.label).toBe('Amp API Key Setup');
    },
  );

  it('should advertise terminal auth when the client supports it', async () => {
    const response = await agentConnection.initialize({
      protocolVersion: 1,
      clientCapabilities: { auth: { terminal: true } },
    });

    expect(response.authMethods).toEqual([{
      id: 'setup',
      type: 'terminal',
      name: 'Amp API Key Setup',
      description: 'Run interactive setup to configure your Amp API key',
      args: ['--setup'],
    }]);
  });

  it('forwards interleaved text and multiple images for local and Orb turns', async () => {
    const session = await agentConnection.newSession({ cwd: '/tmp', mcpServers: [] });
    for (const executor of ['local', 'orb']) {
      await agentConnection.setSessionConfigOption({ sessionId: session.sessionId, configId: 'execution-environment', value: executor });
      await agentConnection.prompt({
        sessionId: session.sessionId,
        prompt: [
          { type: 'text', text: 'first' },
          { type: 'image', mimeType: 'image/png', data: 'AQID' },
          { type: 'text', text: 'second' },
          { type: 'image', mimeType: 'image/jpeg', data: 'BAU=' },
          { type: 'text', text: 'last' },
        ],
      });
      expect(prompts.at(-1)).toMatchObject({
        prompt: 'firstsecondlast',
        options: { executor },
        content: [
          { type: 'text', text: 'first' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
          { type: 'text', text: 'second' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BAU=' } },
          { type: 'text', text: 'last' },
        ],
      });
    }
  });

  it('forwards image-only prompts', async () => {
    const session = await agentConnection.newSession({ cwd: '/tmp', mcpServers: [] });
    await agentConnection.prompt({ sessionId: session.sessionId, prompt: [{ type: 'image', mimeType: 'image/webp', data: 'AQID' }] });
    expect(prompts[0]).toMatchObject({ prompt: '', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'AQID' } }] });
  });

  it('accepts unpadded and whitespace-wrapped base64 image data', async () => {
    const session = await agentConnection.newSession({ cwd: '/tmp', mcpServers: [] });
    await agentConnection.prompt({ sessionId: session.sessionId, prompt: [{ type: 'image', mimeType: 'image/png', data: 'AQI' }] });
    await agentConnection.prompt({ sessionId: session.sessionId, prompt: [{ type: 'image', mimeType: 'image/png', data: 'AQ\nID' }] });
    expect(prompts.map((p) => p.content?.[0])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQI' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
    ]);
  });

  it('rejects unsupported or malformed images without starting a partial turn', async () => {
    const session = await agentConnection.newSession({ cwd: '/tmp', mcpServers: [] });
    for (const image of [
      { type: 'image' as const, mimeType: 'image/svg+xml', data: 'AQID' },
      { type: 'image' as const, mimeType: 'image/png', data: 'not base64!' },
      { type: 'image' as const, mimeType: 'image/png', data: '' },
    ]) {
      await expect(agentConnection.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'do not run without the image' }, image] })).rejects.toMatchObject({ code: -32602 });
    }
    expect(prompts).toHaveLength(0);
    await agentConnection.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'retry' }] });
    expect(prompts[0]?.prompt).toBe('retry');
    expect(prompts[0]?.content).toBeUndefined();
  });

  it('should handle newSession and return a valid sessionId', async () => {
    const response = await agentConnection.newSession({
      cwd: '/tmp/test',
      mcpServers: [],
    });

    expect(response.sessionId).toBeDefined();
    expect(response.sessionId).toMatch(/^S-/);
    expect(response.models).toBeUndefined();
    expect(response.modes).toBeUndefined();
    expect(response.configOptions).toHaveLength(4);
    expect(response.configOptions?.map((option) => option.id)).toEqual([
      'execution-environment',
      'permission',
      'amp-mode',
      'reasoning-effort',
    ]);
    expect(response.configOptions?.map((option) => option.category)).toEqual([
      'mode',
      'mode',
      'model',
      'thought_level',
    ]);
    expect(response.configOptions?.find((option) => option.id === 'execution-environment')).toMatchObject({
      currentValue: 'local',
      options: [
        { value: 'local', name: 'Local' },
        { value: 'orb', name: 'Orb' },
      ],
    });
    expect(response.configOptions?.find((option) => option.id === 'amp-mode')).toMatchObject({
      currentValue: 'medium',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'ultra', name: 'Ultra' },
      ],
    });

    expect(await agentConnection.extMethod('amp-acp/session/native-metadata', {
      sessionId: response.sessionId,
    })).toEqual({
      version: 1,
      sessionId: response.sessionId,
      ampThreadId: null,
    });
  });

  it('should handle setSessionConfigOption', async () => {
    const session = await agentConnection.newSession({
      cwd: '/tmp',
      mcpServers: [],
    });

    const result = await agentConnection.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'amp-mode',
      value: 'high',
    });

    expect(result.configOptions).toHaveLength(4);
    expect(result.configOptions.find((option) => option.id === 'amp-mode')).toMatchObject({
      currentValue: 'high',
    });
  });

  it('should set reasoning effort and reject unknown values', async () => {
    const session = await agentConnection.newSession({
      cwd: '/tmp',
      mcpServers: [],
    });

    const result = await agentConnection.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'reasoning-effort',
      value: 'xhigh',
    });

    expect(result.configOptions.find((option) => option.id === 'reasoning-effort')).toMatchObject({
      currentValue: 'xhigh',
      options: [
        { value: 'auto', name: 'Auto' },
        { value: 'none', name: 'None' },
        { value: 'minimal', name: 'Minimal' },
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'xhigh', name: 'Extra high' },
        { value: 'max', name: 'Max' },
      ],
    });

    await expect(agentConnection.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'reasoning-effort',
      value: 'turbo',
    })).rejects.toThrow('Internal error');
  });

  it('should update the execution environment', async () => {
    const session = await agentConnection.newSession({
      cwd: '/tmp',
      mcpServers: [],
    });

    const result = await agentConnection.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'execution-environment',
      value: 'orb',
    });

    expect(result.configOptions.find((option) => option.id === 'execution-environment')).toMatchObject({
      currentValue: 'orb',
    });
  });

  it('should accept a custom plugin agent mode', async () => {
    const session = await agentConnection.newSession({
      cwd: '/tmp',
      mcpServers: [],
    });

    // The discovery stub lists no plugin modes, so 'acp-flash' is unknown to
    // amp-acp; it still passes through because Amp is the authority on
    // resolving mode keys.
    const result = await agentConnection.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'amp-mode',
      value: 'acp-flash',
    });

    expect(result.configOptions.find((option) => option.id === 'amp-mode')).toMatchObject({
      currentValue: 'acp-flash',
    });
  });

  it('should reject an empty Amp mode', async () => {
    const session = await agentConnection.newSession({
      cwd: '/tmp',
      mcpServers: [],
    });

    await expect(agentConnection.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'amp-mode',
      value: '   ',
    })).rejects.toThrow('Internal error');
  });

  it('should handle newSession with MCP servers', async () => {
    const response = await agentConnection.newSession({
      cwd: '/tmp/test',
      mcpServers: [
        {
          type: 'http',
          name: 'exa',
          url: 'https://mcp.exa.ai/mcp',
          headers: [],
        },
        {
          name: 'local-server',
          command: 'npx',
          args: ['mcp-server'],
          env: [],
        },
      ],
    });

    expect(response.sessionId).toBeDefined();
    expect(response.sessionId).toMatch(/^S-/);
  });

  it('should handle setSessionMode', async () => {
    const session = await agentConnection.newSession({
      cwd: '/tmp',
      mcpServers: [],
    });

    const result = await agentConnection.setSessionMode({
      sessionId: session.sessionId,
      modeId: 'bypass',
    });

    expect(result).toEqual({});
  });

  it('should handle setSessionMode for both default and bypass', async () => {
    const session = await agentConnection.newSession({
      cwd: '/tmp',
      mcpServers: [],
    });

    const r1 = await agentConnection.setSessionMode({
      sessionId: session.sessionId,
      modeId: 'bypass',
    });
    expect(r1).toEqual({});

    const r2 = await agentConnection.setSessionMode({
      sessionId: session.sessionId,
      modeId: 'default',
    });
    expect(r2).toEqual({});
  });

  it('should reject authenticate when AMP_API_KEY is not set', async () => {
    const saved = process.env.AMP_API_KEY;
    delete process.env.AMP_API_KEY;
    try {
      await agentConnection.authenticate({ methodId: 'setup' });
      expect(true).toBe(false);
    } catch (e: unknown) {
      expect(e).toBeDefined();
    } finally {
      if (saved) process.env.AMP_API_KEY = saved;
    }
  });

  it('should create multiple independent sessions', async () => {
    const s1 = await agentConnection.newSession({ cwd: '/tmp/a', mcpServers: [] });
    const s2 = await agentConnection.newSession({ cwd: '/tmp/b', mcpServers: [] });

    expect(s1.sessionId).not.toBe(s2.sessionId);
    expect(s1.sessionId).toMatch(/^S-/);
    expect(s2.sessionId).toMatch(/^S-/);
  });

  it('should send available_commands_update notification after newSession', async () => {
    await agentConnection.newSession({ cwd: '/tmp', mcpServers: [] });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const cmdUpdate = testClient.notifications.find(
      (n) => n.update && 'sessionUpdate' in n.update && n.update.sessionUpdate === 'available_commands_update',
    );
    expect(cmdUpdate).toBeDefined();
    if (!cmdUpdate || !('availableCommands' in cmdUpdate.update)) {
      throw new Error('missing available_commands_update');
    }
    expect(cmdUpdate.update.availableCommands.map((command) => command.name)).toEqual([
      'init',
      'review',
      'ship',
      'update-base',
      'refactor-commits',
    ]);
  });

  it('forwards built-in Amp slash prompts to the agent unchanged', async () => {
    const session = await agentConnection.newSession({ cwd: '/tmp', mcpServers: [] });

    await agentConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: '/review focus on the retry path' }],
    });

    expect(prompts.at(-1)?.prompt).toBe('/review focus on the retry path');
  });

  it('replaces /init with the AGENTS.md authoring prompt', async () => {
    const session = await agentConnection.newSession({ cwd: '/tmp', mcpServers: [] });

    await agentConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: '/init' }],
    });

    expect(prompts.at(-1)?.prompt).toContain('create an AGENTS.md file');
  });
});

describe('toAcpNotifications', () => {

  it('should convert string content to text notification', () => {
    const result = toAcpNotifications(
      { type: 'assistant', message: { content: 'Hello world' } },
      'session-1',
    );

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('session-1');
    expect(result[0].update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hello world' },
    });
  });

  it('should convert text content block', () => {
    const result = toAcpNotifications(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } },
      'session-1',
    );

    expect(result).toHaveLength(1);
    expect(result[0].update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hi' },
    });
  });

  it('should convert thinking block', () => {
    const result = toAcpNotifications(
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Analyzing...' }] } },
      'session-1',
    );

    expect(result).toHaveLength(1);
    expect(result[0].update).toMatchObject({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Analyzing...' },
    });
  });

  it('should convert tool_use block', () => {
    const result = toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/tmp/file.txt' } }],
        },
      },
      'session-1',
    );

    expect(result).toHaveLength(1);
    expect(result[0].update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'Read: /tmp/file.txt',
      status: 'in_progress',
      kind: 'read',
      locations: [{ path: '/tmp/file.txt' }],
    });
  });

  it('should render Bash tool calls with the command', () => {
    const result = toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tool-2', name: 'Bash', input: { cmd: 'rg "tool_call" src' } }],
        },
      },
      'session-1',
    );

    expect(result).toHaveLength(1);
    expect(result[0].update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-2',
      title: 'Bash: rg "tool_call" src',
      status: 'in_progress',
      kind: 'execute',
    });
  });

  it('should render nested Bash commands in tool title', () => {
    const result = toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tool-2b', name: 'Bash', input: { input: { command: 'uptime' } } }],
        },
      },
      'session-1',
    );

    expect(result).toHaveLength(1);
    expect(result[0].update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-2b',
      title: 'Bash: uptime',
      status: 'in_progress',
      kind: 'execute',
    });
  });

  it('should convert tool_result block (success)', () => {
    const result = toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents', is_error: false }],
        },
      },
      'session-1',
    );

    expect(result).toHaveLength(1);
    expect(result[0].update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'completed',
    });
  });

  it('should convert tool_result block (error)', () => {
    const result = toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'not found', is_error: true }],
        },
      },
      'session-1',
    );

    expect(result).toHaveLength(1);
    expect(result[0].update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'failed',
    });
  });

  it('should convert image block with base64 source', () => {
    const result = toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'image', source: { type: 'base64', data: 'abc123', media_type: 'image/png' } }],
        },
      },
      'session-1',
    );

    expect(result).toHaveLength(1);
    expect(result[0].update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', data: 'abc123', mimeType: 'image/png' },
    });
  });

  it('should handle mixed content blocks', () => {
    const result = toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Let me think...' },
            { type: 'text', text: 'Here is the answer' },
            { type: 'tool_use', id: 'tool-2', name: 'Bash', input: { cmd: 'ls' } },
          ],
        },
      },
      'session-1',
    );

    expect(result).toHaveLength(3);
    expect(result[0].update).toMatchObject({ sessionUpdate: 'agent_thought_chunk' });
    expect(result[1].update).toMatchObject({ sessionUpdate: 'agent_message_chunk' });
    expect(result[2].update).toMatchObject({ sessionUpdate: 'tool_call', title: 'Bash: ls' });
  });

  it('should return empty for missing message', () => {
    const result = toAcpNotifications({ type: 'assistant' }, 'session-1');
    expect(result).toHaveLength(0);
  });
});
