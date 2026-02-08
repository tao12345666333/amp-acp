import { describe, it, beforeEach, expect } from 'bun:test';
import { ClientSideConnection, AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { AmpAcpAgent } from './server.js';
import { toAcpNotifications } from './to-acp.js';
import type { SessionNotification } from '@agentclientprotocol/sdk';

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

  beforeEach(() => {
    clientToAgent = new TransformStream();
    agentToClient = new TransformStream();
    testClient = new TestClient();

    agentConnection = new ClientSideConnection(
      () => testClient,
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );
    new AgentSideConnection(
      (client) => new AmpAcpAgent(client),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );
  });

  it('should handle initialize request and return correct capabilities', async () => {
    const response = await agentConnection.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });

    expect(response.protocolVersion).toBe(1);
    expect(response._meta?.version).toBeDefined();
    expect(response.agentCapabilities?.promptCapabilities?.image).toBe(true);
    expect(response.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(true);
    expect(response.agentCapabilities?.mcpCapabilities?.http).toBe(true);
    expect(response.agentCapabilities?.mcpCapabilities?.sse).toBe(true);
    expect(response.authMethods).toEqual([]);
  });

  it('should handle newSession and return a valid sessionId', async () => {
    const response = await agentConnection.newSession({
      cwd: '/tmp/test',
      mcpServers: [],
    });

    expect(response.sessionId).toBeDefined();
    expect(response.sessionId).toMatch(/^S-/);
    expect(response.modes?.currentModeId).toBe('default');
    expect(response.modes?.availableModes).toHaveLength(2);
    expect(response.modes?.availableModes?.map((m) => m.id)).toEqual(['default', 'bypass']);
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

  it('should reject authenticate with authRequired', async () => {
    try {
      await agentConnection.authenticate({ methodId: 'oauth' });
      expect(true).toBe(false);
    } catch (e: unknown) {
      expect(e).toBeDefined();
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
      title: 'Read',
      status: 'pending',
      kind: 'other',
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
    expect(result[2].update).toMatchObject({ sessionUpdate: 'tool_call', title: 'Bash' });
  });

  it('should return empty for missing message', () => {
    const result = toAcpNotifications({ type: 'assistant' }, 'session-1');
    expect(result).toHaveLength(0);
  });
});
