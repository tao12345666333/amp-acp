import {
  RequestError,
  type AgentSideConnection,
  type Agent,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type ClientCapabilities,
} from '@agentclientprotocol/sdk';
import { execute, type StreamMessage } from '@sourcegraph/amp-sdk';
import { convertAcpMcpServersToAmpConfig, type AmpMcpConfig } from './mcp-config.js';
import { toAcpNotifications } from './to-acp.js';
import packageJson from '../package.json';

const PACKAGE_VERSION: string = packageJson.version;

interface SessionState {
  threadId: string | null;
  controller: AbortController | null;
  cancelled: boolean;
  active: boolean;
  mode: string;
  mcpConfig: AmpMcpConfig;
  cwd: string;
}

export class AmpAcpAgent implements Agent {
  private client: AgentSideConnection;
  sessions = new Map<string, SessionState>();
  private clientCapabilities?: ClientCapabilities;

  constructor(client: AgentSideConnection) {
    this.client = client;
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = request.clientCapabilities;
    console.info(`[acp] amp-acp v${PACKAGE_VERSION} initialized`);
    return {
      protocolVersion: 1,
      _meta: { version: PACKAGE_VERSION },
      agentCapabilities: {
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
      },
      authMethods: [],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = `S-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const mcpConfig = convertAcpMcpServersToAmpConfig(params.mcpServers);

    this.sessions.set(sessionId, {
      threadId: null,
      controller: null,
      cancelled: false,
      active: false,
      mode: 'default',
      mcpConfig,
      cwd: params.cwd || process.cwd(),
    });

    const result: NewSessionResponse = {
      sessionId,
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default', description: 'Prompts for permission on first use of each tool' },
          { id: 'bypass', name: 'Bypass', description: 'Skips all permission prompts' },
        ],
      },
    };

    setImmediate(async () => {
      try {
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              {
                name: 'init',
                description: 'Generate an AGENTS.md file for the project',
              },
            ],
          },
        });
      } catch (e) {
        console.error('[acp] failed to send available_commands_update', e);
      }
    });

    return result;
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    throw RequestError.authRequired();
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new Error('Session not found');
    s.cancelled = false;
    s.active = true;

    let textInput = '';
    for (const chunk of params.prompt) {
      switch (chunk.type) {
        case 'text':
          if (chunk.text.trim() === '/init') {
            textInput += `Please analyze this codebase and create an AGENTS.md file containing:
1. Build/lint/test commands - especially for running a single test
2. Architecture and codebase structure information, including important subprojects, internal APIs, databases, etc.
3. Code style guidelines, including imports, conventions, formatting, types, naming conventions, error handling, etc.

The file you create will be given to agentic coding tools (such as yourself) that operate in this repository. Make it about 20 lines long.

If there are Cursor rules (in .cursor/rules/ or .cursorrules), Claude rules (CLAUDE.md), Windsurf rules (.windsurfrules), Cline rules (.clinerules), Goose rules (.goosehints), or Copilot rules (in .github/copilot-instructions.md), make sure to include them. Also, first check if there is an existing AGENTS.md or AGENT.md file, and if so, update it instead of overwriting it.`;
          } else {
            textInput += chunk.text;
          }
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
          break;
        default:
          break;
      }
    }

    const options: Record<string, unknown> = {
      cwd: s.cwd,
      env: { TERM: 'dumb' },
    };

    if (s.mode === 'bypass') {
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
      if (s.cancelled || (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted')))) {
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

  async cancel(params: CancelNotification): Promise<void> {
    const s = this.sessions.get(params.sessionId);
    if (!s) return;
    if (s.active && s.controller) {
      s.cancelled = true;
      s.controller.abort();
    }
  }

  async setSessionModel(_params: SetSessionModelRequest): Promise<SetSessionModelResponse> { return {}; }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new Error('Session not found');
    s.mode = params.modeId;
    return {};
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> { return this.client.readTextFile(params); }
  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> { return this.client.writeTextFile(params); }
}
