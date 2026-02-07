/**
 * Converts ACP mcpServers format to Amp SDK mcpConfig format.
 *
 * @param {Array} mcpServers - Array of MCP server configurations from ACP
 * @returns {Object} mcpConfig object for Amp SDK
 */
export function convertAcpMcpServersToAmpConfig(mcpServers) {
  const mcpConfig = {};
  if (!Array.isArray(mcpServers)) {
    return mcpConfig;
  }

  for (const server of mcpServers) {
    if ('type' in server && (server.type === 'http' || server.type === 'sse')) {
      // HTTP/SSE remote MCP server
      // Convert ACP headers array format to Amp SDK object format
      const headers = {};
      if (Array.isArray(server.headers)) {
        for (const h of server.headers) {
          headers[h.name] = h.value;
        }
      } else if (server.headers && typeof server.headers === 'object') {
        // Already in object format
        Object.assign(headers, server.headers);
      }
      mcpConfig[server.name] = {
        url: server.url,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      };
    } else {
      // stdio type (local MCP server)
      // Handle env in both array and object formats
      let env;
      if (Array.isArray(server.env)) {
        env = Object.fromEntries(server.env.map((e) => [e.name, e.value]));
      } else if (server.env && typeof server.env === 'object') {
        env = server.env;
      }
      mcpConfig[server.name] = {
        command: server.command,
        args: server.args,
        env,
      };
    }
  }

  return mcpConfig;
}
