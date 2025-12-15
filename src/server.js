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
      },
      authMethods: [],
    };
  }

  async newSession(params) {
    const sessionId = `S-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    this.sessions.set(sessionId, {
      threadId: null,
      controller: null,
      cancelled: false,
      active: false,
      mode: 'default', // Default mode
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

    const env = { ...process.env };
    if (process.env.AMP_PREFER_SYSTEM_PATH === '1' && env.PATH) {
       // Drop npx/npm-local node_modules/.bin segments so we pick the system 'amp' if needed
       // Note: The SDK tries to find local @sourcegraph/amp first.
       const parts = env.PATH.split(':').filter((p) => !/\bnode_modules\/\.bin\b|\/_npx\//.test(p));
       env.PATH = parts.join(':');
    }

    const options = {
      cwd: params.cwd || process.cwd(),
      env: env,
      mode: s.mode === 'plan' ? 'smart' : undefined, // 'smart' is default.
      // If mode is 'plan', we might want to restrict tools, but SDK `mode` option is 'smart' | 'rush' | 'large'.
      // 'plan' mode in ACP usually means read-only. We might need to handle this via permissions or just trust the user prompt?
      // For now, we only map 'bypassPermissions'.
    };

    if (s.mode === 'bypassPermissions') {
        options.dangerouslyAllowAll = true;
    }

    if (s.threadId) {
      options.continue = s.threadId;
    }

    const controller = new AbortController();
    s.controller = controller;

    let hadOutput = false;

    try {
      const iterator = execute({
        prompt: textInput,
        options,
        signal: controller.signal
      });

      for await (const message of iterator) {
        hadOutput = true;

        // Capture threadId if we don't have it yet
        if (!s.threadId && message.session_id) {
          s.threadId = message.session_id;
        }

        // Log system messages
        if (message.type === 'system') {
           // console.log('Amp System:', message);
        }

        // Forward assistant messages to ACP
        // We ignore user messages to avoid echoing input
        if (message.type === 'assistant') {
            const notifications = toAcpNotifications(message, params.sessionId);
            for (const n of notifications) {
                try {
                  await this.client.sessionUpdate(n);
                } catch (e) {
                  console.error('[acp] sessionUpdate failed', e);
                }
            }
        }

        if (message.type === 'result') {
            if (message.is_error) {
                console.error('[amp] Error result:', message.error);
                // We might want to send this error to the user via ACP?
                // The current implementation ends the turn.
            }
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
