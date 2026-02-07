/**
 * Test for MCP configuration passthrough from ACP to Amp SDK
 *
 * This test verifies that:
 * 1. stdio type MCP servers are correctly converted
 * 2. HTTP/SSE remote MCP servers are correctly converted
 * 3. Headers are properly converted from ACP array format to Amp SDK object format
 *
 * Run with: node --test src/mcp-config.test.js
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { convertAcpMcpServersToAmpConfig } from './mcp-config.js';

describe('MCP Configuration Passthrough', () => {
  describe('stdio type MCP servers', () => {
    it('should convert a basic stdio MCP server', () => {
      const acpMcpServers = [
        {
          name: 'filesystem',
          command: '/path/to/mcp-server',
          args: ['--stdio'],
        },
      ];

      const result = convertAcpMcpServersToAmpConfig(acpMcpServers);

      assert.deepStrictEqual(result, {
        filesystem: {
          command: '/path/to/mcp-server',
          args: ['--stdio'],
          env: undefined,
        },
      });
    });

    it('should convert a stdio MCP server with environment variables array', () => {
      const acpMcpServers = [
        {
          name: 'filesystem',
          command: '/path/to/mcp-server',
          args: ['--stdio'],
          env: [
            { name: 'API_KEY', value: 'secret123' },
            { name: 'DEBUG', value: 'true' },
          ],
        },
      ];

      const result = convertAcpMcpServersToAmpConfig(acpMcpServers);

      assert.deepStrictEqual(result, {
        filesystem: {
          command: '/path/to/mcp-server',
          args: ['--stdio'],
          env: {
            API_KEY: 'secret123',
            DEBUG: 'true',
          },
        },
      });
    });

    it('should convert a stdio MCP server with environment variables object', () => {
      const acpMcpServers = [
        {
          name: 'filesystem',
          command: '/path/to/mcp-server',
          args: ['--stdio'],
          env: {
            API_KEY: 'secret123',
            DEBUG: 'true',
          },
        },
      ];

      const result = convertAcpMcpServersToAmpConfig(acpMcpServers);

      assert.deepStrictEqual(result, {
        filesystem: {
          command: '/path/to/mcp-server',
          args: ['--stdio'],
          env: {
            API_KEY: 'secret123',
            DEBUG: 'true',
          },
        },
      });
    });
  });

  describe('HTTP type remote MCP servers', () => {
    it('should convert a basic HTTP MCP server (Exa example)', () => {
      const acpMcpServers = [
        {
          type: 'http',
          name: 'exa',
          url: 'https://mcp.exa.ai/mcp',
          headers: [],
        },
      ];

      const result = convertAcpMcpServersToAmpConfig(acpMcpServers);

      assert.deepStrictEqual(result, {
        exa: {
          url: 'https://mcp.exa.ai/mcp',
          headers: undefined,
        },
      });
    });

    it('should convert an HTTP MCP server with headers array format', () => {
      const acpMcpServers = [
        {
          type: 'http',
          name: 'api-server',
          url: 'https://api.example.com/mcp',
          headers: [
            { name: 'Authorization', value: 'Bearer token123' },
            { name: 'Content-Type', value: 'application/json' },
          ],
        },
      ];

      const result = convertAcpMcpServersToAmpConfig(acpMcpServers);

      assert.deepStrictEqual(result, {
        'api-server': {
          url: 'https://api.example.com/mcp',
          headers: {
            Authorization: 'Bearer token123',
            'Content-Type': 'application/json',
          },
        },
      });
    });

    it('should convert an HTTP MCP server with headers object format', () => {
      const acpMcpServers = [
        {
          type: 'http',
          name: 'sourcegraph',
          url: 'https://sourcegraph.example.com/.api/mcp/v1',
          headers: {
            Authorization: 'token sgp_xxx',
          },
        },
      ];

      const result = convertAcpMcpServersToAmpConfig(acpMcpServers);

      assert.deepStrictEqual(result, {
        sourcegraph: {
          url: 'https://sourcegraph.example.com/.api/mcp/v1',
          headers: {
            Authorization: 'token sgp_xxx',
          },
        },
      });
    });
  });

  describe('SSE type remote MCP servers', () => {
    it('should convert an SSE MCP server', () => {
      const acpMcpServers = [
        {
          type: 'sse',
          name: 'event-stream',
          url: 'https://events.example.com/mcp',
          headers: [{ name: 'X-API-Key', value: 'apikey456' }],
        },
      ];

      const result = convertAcpMcpServersToAmpConfig(acpMcpServers);

      assert.deepStrictEqual(result, {
        'event-stream': {
          url: 'https://events.example.com/mcp',
          headers: {
            'X-API-Key': 'apikey456',
          },
        },
      });
    });
  });

  describe('Mixed MCP servers', () => {
    it('should convert a mix of stdio and HTTP MCP servers', () => {
      const acpMcpServers = [
        {
          name: 'playwright',
          command: 'npx',
          args: ['-y', '@playwright/mcp@latest', '--headless'],
        },
        {
          type: 'http',
          name: 'exa',
          url: 'https://mcp.exa.ai/mcp',
          headers: [],
        },
        {
          type: 'sse',
          name: 'monday',
          url: 'https://mcp.monday.com/sse',
          headers: [{ name: 'Authorization', value: 'Bearer monday_token' }],
        },
      ];

      const result = convertAcpMcpServersToAmpConfig(acpMcpServers);

      assert.deepStrictEqual(result, {
        playwright: {
          command: 'npx',
          args: ['-y', '@playwright/mcp@latest', '--headless'],
          env: undefined,
        },
        exa: {
          url: 'https://mcp.exa.ai/mcp',
          headers: undefined,
        },
        monday: {
          url: 'https://mcp.monday.com/sse',
          headers: {
            Authorization: 'Bearer monday_token',
          },
        },
      });
    });
  });

  describe('Edge cases', () => {
    it('should handle empty mcpServers array', () => {
      const result = convertAcpMcpServersToAmpConfig([]);
      assert.deepStrictEqual(result, {});
    });

    it('should handle undefined mcpServers', () => {
      const result = convertAcpMcpServersToAmpConfig(undefined);
      assert.deepStrictEqual(result, {});
    });

    it('should handle null mcpServers', () => {
      const result = convertAcpMcpServersToAmpConfig(null);
      assert.deepStrictEqual(result, {});
    });
  });
});
