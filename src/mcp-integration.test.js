/**
 * Integration test for MCP server passthrough via AmpAcpAgent
 *
 * This test validates that MCP configurations are correctly stored
 * in sessions when passed through the AmpAcpAgent class.
 *
 * Run with: node --test src/mcp-integration.test.js
 */

import assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { AmpAcpAgent } from './server.js';

// Mock client for testing
const mockClient = {
  sessionUpdate: async () => {},
  readTextFile: async () => {},
  writeTextFile: async () => {},
};

describe('AmpAcpAgent MCP Integration', () => {
  let agent;

  beforeEach(async () => {
    agent = new AmpAcpAgent(mockClient);
    await agent.initialize({ clientCapabilities: {} });
  });

  it('should pass through HTTP MCP server (Exa example)', async () => {
    const session = await agent.newSession({
      cwd: '/tmp',
      mcpServers: [
        {
          type: 'http',
          name: 'exa',
          url: 'https://mcp.exa.ai/mcp',
          headers: [],
        },
      ],
    });

    const storedSession = agent.sessions.get(session.sessionId);

    assert.deepStrictEqual(storedSession.mcpConfig, {
      exa: {
        url: 'https://mcp.exa.ai/mcp',
        headers: undefined,
      },
    });
  });

  it('should pass through mixed local and remote MCP servers', async () => {
    const session = await agent.newSession({
      cwd: '/tmp',
      mcpServers: [
        {
          name: 'playwright',
          command: 'npx',
          args: ['-y', '@playwright/mcp@latest', '--headless'],
        },
        {
          type: 'http',
          name: 'exa',
          url: 'https://mcp.exa.ai/mcp?tools=web_search_exa',
          headers: [],
        },
        {
          type: 'http',
          name: 'sourcegraph',
          url: 'https://sourcegraph.example.com/.api/mcp/v1',
          headers: [{ name: 'Authorization', value: 'token sgp_xxx' }],
        },
        {
          type: 'sse',
          name: 'monday',
          url: 'https://mcp.monday.com/sse',
          headers: [{ name: 'Authorization', value: 'Bearer monday_token' }],
        },
      ],
    });

    const storedSession = agent.sessions.get(session.sessionId);
    const { mcpConfig } = storedSession;

    // Verify all servers are present with correct structure
    assert.strictEqual(mcpConfig.playwright?.command, 'npx');
    assert.deepStrictEqual(mcpConfig.playwright?.args, ['-y', '@playwright/mcp@latest', '--headless']);

    assert.strictEqual(mcpConfig.exa?.url, 'https://mcp.exa.ai/mcp?tools=web_search_exa');

    assert.strictEqual(mcpConfig.sourcegraph?.url, 'https://sourcegraph.example.com/.api/mcp/v1');

    assert.strictEqual(mcpConfig.monday?.url, 'https://mcp.monday.com/sse');
  });

  it('should correctly convert headers from array to object format', async () => {
    const session = await agent.newSession({
      cwd: '/tmp',
      mcpServers: [
        {
          type: 'http',
          name: 'api',
          url: 'https://api.example.com/mcp',
          headers: [
            { name: 'Authorization', value: 'Bearer token123' },
            { name: 'X-Custom-Header', value: 'custom-value' },
          ],
        },
      ],
    });

    const storedSession = agent.sessions.get(session.sessionId);

    assert.deepStrictEqual(storedSession.mcpConfig.api.headers, {
      Authorization: 'Bearer token123',
      'X-Custom-Header': 'custom-value',
    });
  });

  it('should handle session without MCP servers', async () => {
    const session = await agent.newSession({
      cwd: '/tmp',
    });

    const storedSession = agent.sessions.get(session.sessionId);

    assert.deepStrictEqual(storedSession.mcpConfig, {});
  });
});
