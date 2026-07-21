import type { McpServer } from '@agentclientprotocol/sdk';
import type { AmpMcpConfig } from './amp-transport.js';

export type { AmpMcpConfig } from './amp-transport.js';

export function convertAcpMcpServersToAmpConfig(mcpServers: McpServer[] | undefined | null): AmpMcpConfig {
  const mcpConfig: AmpMcpConfig = {};
  if (!Array.isArray(mcpServers)) {
    return mcpConfig;
  }

  for (const server of mcpServers) {
    if ('type' in server) {
      if (server.type === 'acp') {
        continue;
      }

      const headers: Record<string, string> = {};
      for (const header of server.headers) {
        headers[header.name] = header.value;
      }
      mcpConfig[server.name] = {
        url: server.url,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      };
      continue;
    }

    const env = server.env.length > 0
      ? Object.fromEntries(server.env.map((entry) => [entry.name, entry.value]))
      : undefined;
    mcpConfig[server.name] = {
      command: server.command,
      args: server.args,
      env,
    };
  }

  return mcpConfig;
}
