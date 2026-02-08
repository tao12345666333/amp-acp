import type { McpServer } from '@agentclientprotocol/sdk';

interface AmpMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export type AmpMcpConfig = Record<string, AmpMcpServerConfig>;

export function convertAcpMcpServersToAmpConfig(mcpServers: McpServer[] | undefined | null): AmpMcpConfig {
  const mcpConfig: AmpMcpConfig = {};
  if (!Array.isArray(mcpServers)) {
    return mcpConfig;
  }

  for (const server of mcpServers) {
    if ('type' in server && (server.type === 'http' || server.type === 'sse')) {
      const headers: Record<string, string> = {};
      for (const h of server.headers) {
        headers[h.name] = h.value;
      }
      mcpConfig[server.name] = {
        url: server.url,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      };
    } else {
      const env = server.env.length > 0
        ? Object.fromEntries(server.env.map((e) => [e.name, e.value]))
        : undefined;
      mcpConfig[server.name] = {
        command: server.command,
        args: server.args,
        env,
      };
    }
  }

  return mcpConfig;
}
