import { afterEach, describe, expect, it } from 'bun:test';
import type { AgentSideConnection, ClientCapabilities, PromptResponse, SessionNotification } from '@agentclientprotocol/sdk';
import type { AmpStreamMessage, AmpTransport } from './amp-transport.js';
import type { AmpThreadMapping } from './thread-mapping-store.js';
import { AmpAcpAgent } from './server.js';
import {
  contextWindowSize,
  isMcpProblemStatus,
  mcpStatusReports,
  permissionDenialNames,
  stopReasonFromAssistant,
} from './turn-events.js';

const threadId = 'T-01a03c00-e608-7007-8181-5c1cc56757be';

function fakeTransport(messages: AmpStreamMessage[]): AmpTransport {
  return {
    name: 'cli',
    async *execute() {
      for (const message of messages) yield message;
    },
  };
}

interface RunResult {
  response: PromptResponse;
  updates: SessionNotification[];
  agent: AmpAcpAgent;
  sessionId: string;
}

async function runPrompt(
  messages: AmpStreamMessage[],
  clientCapabilities: ClientCapabilities = {},
): Promise<RunResult> {
  const updates: SessionNotification[] = [];
  const mappings = new Map<string, AmpThreadMapping>();
  const client = {
    sessionUpdate: async (notification: SessionNotification) => {
      updates.push(notification);
    },
  } as unknown as AgentSideConnection;
  const agent = new AmpAcpAgent(client, fakeTransport(messages), {
    threadStore: {
      load: async (sessionId) => mappings.get(sessionId) ?? null,
      save: async (mapping) => {
        mappings.set(mapping.sessionId, mapping);
      },
    },
    discoverPluginModes: () => [],
  });
  await agent.initialize({ protocolVersion: 1, clientCapabilities });
  const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
  const response = await agent.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'hello' }],
  });
  return { response, updates, agent, sessionId: session.sessionId };
}

const updateKinds = (updates: SessionNotification[], kind: string) =>
  updates.filter((notification) => notification.update.sessionUpdate === kind).map((notification) => notification.update);

describe('prompt usage, stop reason, and notices', () => {
  const originalSize = process.env.AMP_ACP_CONTEXT_WINDOW_SIZE;

  afterEach(() => {
    if (originalSize === undefined) {
      delete process.env.AMP_ACP_CONTEXT_WINDOW_SIZE;
    } else {
      process.env.AMP_ACP_CONTEXT_WINDOW_SIZE = originalSize;
    }
  });

  it('sends usage updates for the latest model call and deduplicates unchanged values', async () => {
    delete process.env.AMP_ACP_CONTEXT_WINDOW_SIZE;
    const { response, updates } = await runPrompt([
      { type: 'system', subtype: 'init', session_id: threadId, mcp_servers: [] },
      {
        type: 'assistant',
        session_id: threadId,
        message: {
          id: 'msg_1',
          content: [{ type: 'text', text: 'a' }],
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900 },
          stop_reason: 'end_turn',
        },
      },
      {
        type: 'assistant',
        session_id: threadId,
        message: {
          id: 'msg_1',
          content: [{ type: 'text', text: 'b' }],
          usage: { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 900 },
          stop_reason: 'end_turn',
        },
      },
      {
        type: 'assistant',
        session_id: threadId,
        message: {
          id: 'msg_2',
          content: [{ type: 'text', text: 'c' }],
          usage: { input_tokens: 30, output_tokens: 20, cache_creation_input_tokens: 200 },
          stop_reason: 'end_turn',
        },
      },
      { type: 'result', subtype: 'success', session_id: threadId, is_error: false },
    ]);

    const usages = updateKinds(updates, 'usage_update') as Array<{ used: number; size: number }>;
    expect(usages.map((usage) => usage.used)).toEqual([915, 950, 250]);
    expect(usages.every((usage) => usage.size === 200_000)).toBe(true);
    expect(response).toEqual({
      stopReason: 'end_turn',
      usage: {
        inputTokens: 40,
        outputTokens: 60,
        cachedReadTokens: 900,
        cachedWriteTokens: 200,
        totalTokens: 1200,
      },
    });
  });

  it('reports max_tokens from the final assistant response', async () => {
    const { response } = await runPrompt([
      { type: 'system', subtype: 'init', session_id: threadId, mcp_servers: [] },
      {
        type: 'assistant',
        session_id: threadId,
        message: {
          id: 'msg_1',
          content: [{ type: 'text', text: 'cut off' }],
          stop_reason: 'max_tokens',
        },
      },
      { type: 'result', subtype: 'success', session_id: threadId, is_error: false },
    ]);
    expect(response.stopReason).toBe('max_tokens');
  });

  it('reports max_turn_requests from an error_max_turns result', async () => {
    const { response } = await runPrompt([
      { type: 'system', subtype: 'init', session_id: threadId, mcp_servers: [] },
      { type: 'result', subtype: 'error_max_turns', session_id: threadId, is_error: true, error: 'max turns' },
    ]);
    expect(response.stopReason).toBe('max_turn_requests');
  });

  it('falls back to an agent message when the client does not support notices', async () => {
    const { updates } = await runPrompt([
      {
        type: 'system',
        subtype: 'init',
        session_id: threadId,
        mcp_servers: [{ name: 'github', status: 'failed' }],
      },
      { type: 'result', subtype: 'success', session_id: threadId, is_error: false },
    ]);

    expect(updateKinds(updates, 'notice')).toHaveLength(0);
    expect(
      updateKinds(updates, 'agent_message_chunk').some(
        (update) => update.sessionUpdate === 'agent_message_chunk' &&
          update.content.type === 'text' &&
          update.content.text.includes('MCP server unavailable'),
      ),
    ).toBe(true);
  });

  it('sends MCP notices only when the client advertises support', async () => {
    const { updates } = await runPrompt(
      [
        {
          type: 'system',
          subtype: 'init',
          session_id: threadId,
          mcp_servers: [{ name: 'github', status: 'failed' }],
        },
        { type: 'result', subtype: 'success', session_id: threadId, is_error: false },
      ],
      { session: { notices: {} } },
    );

    const notices = updateKinds(updates, 'notice') as Array<{ severity: string; title: string; description?: string }>;
    expect(notices).toHaveLength(1);
    expect(notices[0]!.severity).toBe('error');
    expect(notices[0]!.title).toBe('MCP server unavailable');
    expect(notices[0]!.description).toContain('github: failed');
  });

  it('sends one notice for a permission denial result', async () => {
    const { updates } = await runPrompt(
      [
        { type: 'system', subtype: 'init', session_id: threadId, mcp_servers: [] },
        {
          type: 'result',
          subtype: 'success',
          session_id: threadId,
          is_error: false,
          permission_denials: [{ tool_name: 'shell_command' }, { tool_name: 'edit_file' }],
        },
      ],
      { session: { notices: {} } },
    );

    const notices = updateKinds(updates, 'notice') as Array<{ severity: string; title: string; description?: string }>;
    expect(notices).toHaveLength(1);
    expect(notices[0]!.severity).toBe('warning');
    expect(notices[0]!.description).toContain('shell_command, edit_file');
  });
});

describe('turn event helpers', () => {
  it('validates the context window override', () => {
    expect(contextWindowSize({})).toBe(200_000);
    expect(contextWindowSize({ AMP_ACP_CONTEXT_WINDOW_SIZE: '1000000' })).toBe(1_000_000);
    expect(contextWindowSize({ AMP_ACP_CONTEXT_WINDOW_SIZE: '0' })).toBe(200_000);
    expect(contextWindowSize({ AMP_ACP_CONTEXT_WINDOW_SIZE: 'nope' })).toBe(200_000);
  });

  it('parses MCP status reports and problem states', () => {
    expect(mcpStatusReports([
      { name: 'github', status: 'failed' },
      { id: 'docs', state: 'blocked_by_registry' },
      { name: 'missing-status' },
    ])).toEqual([
      { name: 'github', status: 'failed' },
      { name: 'docs', status: 'blocked_by_registry' },
    ]);
    expect(isMcpProblemStatus('blocked_by_registry')).toBe(true);
    expect(isMcpProblemStatus('reconnecting')).toBe(true);
    expect(isMcpProblemStatus('connected')).toBe(false);
  });

  it('extracts permission denial names', () => {
    expect(permissionDenialNames([{ tool_name: 'a' }, { toolName: 'b' }, { tool: 'c' }, {}])).toEqual(['a', 'b', 'c', 'tool 4']);
  });

  it('maps only known assistant stop reasons', () => {
    expect(stopReasonFromAssistant('max_tokens')).toBe('max_tokens');
    expect(stopReasonFromAssistant('end_turn')).toBe('end_turn');
    expect(stopReasonFromAssistant('stop_sequence')).toBeNull();
  });
});
