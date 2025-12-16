import { RequestError } from '@agentclientprotocol/sdk';
import { execute } from '@sourcegraph/amp-sdk';
import { toAcpNotifications } from './to-acp.js';

export class AmpAcpAgent {
  constructor(client) {
    this.client = client;
    this.sessions = new Map();
  }

  async initialize(request) {
    this.clientCapabilities = request.clientCapabilities;
    return {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
      },
      authMethods: [],
    };
  }

  async newSession(params) {
    const sessionId = `S-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    // Convert ACP mcpServers to Amp SDK mcpConfig format
    const mcpConfig = {};
    if (Array.isArray(params.mcpServers)) {
      for (const server of params.mcpServers) {
        if ('type' in server && (server.type === 'http' || server.type === 'sse')) {
          // HTTP/SSE type - Amp SDK may not support this directly
          // Skip for now or handle if SDK supports it
        } else {
          // stdio type
          mcpConfig[server.name] = {
            command: server.command,
            args: server.args,
            env: server.env ? Object.fromEntries(server.env.map((e) => [e.name, e.value])) : undefined,
          };
        }
      }
    }

    this.sessions.set(sessionId, {
      threadId: null,
      controller: null,
      cancelled: false,
      active: false,
      mode: 'default',
      mcpConfig,
    });

    return {
      sessionId,
      models: { currentModelId: 'default', availableModels: [{ modelId: 'default', name: 'Default', description: 'Amp default' }] },
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Always Ask', description: 'Prompts for permission on first use of each tool' },
          { id: 'acceptEdits', name: 'Accept Edits', description: 'Automatically accepts file edit permissions for the session' },
          { id: 'bypassPermissions', name: 'Bypass Permissions', description: 'Skips all permission prompts' },
          { id: 'plan', name: 'Plan Mode', description: 'Analyze but not modify files or execute commands' },
        ],
      },
    };
  }

  async authenticate(_params) {
    throw RequestError.authRequired();
  }

  async prompt(params) {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new Error('Session not found');
    s.cancelled = false;
    s.active = true;

    // Build plain-text input for Amp from ACP prompt chunks
    let textInput = '';
    for (const chunk of params.prompt) {
      switch (chunk.type) {
        case 'text':
          textInput += chunk.text;
          break;
        case 'resource_link':
          textInput += `\n${chunk.uri}\n`;
          break;
        case 'resource':
          if ('text' in chunk.resource) {
            textInput += `\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>\n`;
          }
          break;
        case 'image':
          // Images not supported by Amp SDK yet via simple prompt string; ignore for now
          break;
        default:
          break;
      }
    }

    const options = {
      cwd: params.cwd || process.cwd(),
    };

    if (s.mode === 'bypassPermissions') {
      options.dangerouslyAllowAll = true;
    }

    if (Object.keys(s.mcpConfig).length > 0) {
      options.mcpConfig = s.mcpConfig;
    }

    if (s.threadId) {
      options.continue = s.threadId;
    }

    const controller = new AbortController();
    s.controller = controller;

    try {
      for await (const message of execute({ prompt: textInput, options, signal: controller.signal })) {
        if (!s.threadId && message.session_id) {
          s.threadId = message.session_id;
        }

        if (message.type === 'assistant') {
          for (const n of toAcpNotifications(message, params.sessionId)) {
            try {
              await this.client.sessionUpdate(n);
            } catch (e) {
              console.error('[acp] sessionUpdate failed', e);
            }
          }
        }

        if (message.type === 'result' && message.is_error) {
          await this.client.sessionUpdate({
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Error: ${message.error}` } },
          });
        }
      }

      return { stopReason: s.cancelled ? 'cancelled' : 'end_turn' };
    } catch (err) {
      if (s.cancelled || (err.name === 'AbortError') || err.message.includes('aborted')) {
        return { stopReason: 'cancelled' };
      }
      console.error('[amp] Execution error:', err);
      throw err;
    } finally {
      s.active = false;
      s.cancelled = false;
      s.controller = null;
    }
  }

  async cancel(params) {
    const s = this.sessions.get(params.sessionId);
    if (!s) return {};
    if (s.active && s.controller) {
      s.cancelled = true;
      s.controller.abort();
    }
    return {};
  }

  async setSessionModel(_params) { return {}; }

  async setSessionMode(params) {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new Error('Session not found');
    s.mode = params.modeId;
    return {};
  }

  async readTextFile(params) { return this.client.readTextFile(params); }
  async writeTextFile(params) { return this.client.writeTextFile(params); }
}
