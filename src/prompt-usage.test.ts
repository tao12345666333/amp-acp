import { describe, expect, it, mock } from 'bun:test';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type { AmpThreadMapping } from './thread-mapping-store.js';

const threadId = 'T-01a03c00-e608-7007-8181-5c1cc56757be';

mock.module('@ampcode/sdk', () => ({
  execute: () =>
    (async function* () {
      yield { type: 'system', subtype: 'init', session_id: threadId };
      yield {
        type: 'assistant',
        session_id: threadId,
        message: {
          id: 'msg_1',
          role: 'assistant',
          model: 'claude-sonnet',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4000 },
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        session_id: threadId,
        is_error: false,
        result: 'hi',
        usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4000 },
      };
    })(),
}));

const [{ AmpAcpAgent }, { createAmpTransport }] = await Promise.all([
  import('./server.js'),
  import('./amp-transport.js'),
]);

const client = {
  sessionUpdate: async () => {},
} as unknown as AgentSideConnection;

describe('AmpAcpAgent prompt() usage', () => {
  it('answers the turn with its token usage', async () => {
    const mappings = new Map<string, AmpThreadMapping>();
    const agent = new AmpAcpAgent(client, createAmpTransport('sdk'), {
      threadStore: {
        load: async (sessionId) => mappings.get(sessionId) ?? null,
        save: async (mapping) => {
          mappings.set(mapping.sessionId, mapping);
        },
      },
    });
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    const response = await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hello' }] });
    expect(response).toEqual({
      stopReason: 'end_turn',
      usage: { inputTokens: 12, outputTokens: 3, cachedReadTokens: 4000, totalTokens: 4015 },
    });
  });
});
