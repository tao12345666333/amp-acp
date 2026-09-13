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
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type ClientCapabilities,
  type SessionConfigOption,
  type LoadSessionRequest,
  type LoadSessionResponse,
} from '@agentclientprotocol/sdk';
import {
  createAmpTransport,
  isAmpThreadId,
  setAmpThreadArchived,
  type AmpExecutionOptions,
  type AmpThreadLifecycleOptions,
  type AmpTransport,
} from './amp-transport.js';
import { convertAcpMcpServersToAmpConfig, type AmpMcpConfig } from './mcp-config.js';
import {
  FileThreadMappingStore,
  type AmpThreadMapping,
  type ThreadMappingStore,
} from './thread-mapping-store.js';
import { toAcpNotifications } from './to-acp.js';
import { exportThreadHistory, exportThreadMessages, historyToNotifications, type ThreadHistoryExporter } from './thread-history.js';
import path from 'node:path';
import packageJson from '../package.json';

const PACKAGE_VERSION: string = packageJson.version;
const CONFIG_PERMISSION = 'permission';
const CONFIG_AMP_MODE = 'amp-mode';
const CONFIG_EXECUTOR = 'execution-environment';
const PERMISSION_MODES = ['default', 'bypass'] as const;
const EXECUTORS = ['local', 'orb'] as const;
const THREAD_LIFECYCLE_CAPABILITY = 'amp-acp/thread-lifecycle';
const NATIVE_METADATA_METHOD = 'amp-acp/session/native-metadata';
const SET_ARCHIVED_METHOD = 'amp-acp/thread/set-archived';

const AMP_MODELS = [
  {
    modelId: 'low',
    name: 'Low',
    description: 'Fast and economical for simple, well-defined tasks.',
  },
  {
    modelId: 'medium',
    name: 'Medium',
    description: 'Balanced capability and cost for everyday coding tasks.',
  },
  {
    modelId: 'high',
    name: 'High',
    description: 'Greater capability and reasoning for difficult tasks.',
  },
  {
    modelId: 'ultra',
    name: 'Ultra',
    description: 'Maximum capability for the most demanding tasks.',
  },
] as const;

type AmpModelId = typeof AMP_MODELS[number]['modelId'];
type PermissionMode = typeof PERMISSION_MODES[number];
type Executor = typeof EXECUTORS[number];

function isAmpModelId(modelId: string): modelId is AmpModelId {
  return AMP_MODELS.some((model) => model.modelId === modelId);
}

function isPermissionMode(mode: string): mode is PermissionMode {
  return PERMISSION_MODES.some((permissionMode) => permissionMode === mode);
}

function isExecutor(executor: string): executor is Executor {
  return EXECUTORS.some((candidate) => candidate === executor);
}

function buildSessionConfigOptions(s: Pick<SessionState, 'mode' | 'model' | 'executor'>): SessionConfigOption[] {
  return [
    {
      type: 'select',
      id: CONFIG_EXECUTOR,
      name: 'Execution Environment',
      description: 'Choose whether Amp runs in the local project or a remote Amp Orb.',
      category: 'mode',
      currentValue: s.executor,
      options: [
        {
          value: 'local',
          name: 'Local',
          description: 'Run Amp on this machine in the directory supplied by the ACP client.',
        },
        {
          value: 'orb',
          name: 'Orb',
          description: 'Run Amp remotely. Project settings control permissions and MCP servers.',
        },
      ],
    },
    {
      type: 'select',
      id: CONFIG_PERMISSION,
      name: 'Permissions',
      description: 'Controls whether Amp uses configured permissions or force-allows tool calls.',
      category: 'mode',
      currentValue: s.mode,
      options: [
        {
          value: 'default',
          name: 'Default',
          description:
            "Use Amp's configured behavior. As of Amp Neo, tools run without prompts unless you've opted into permissions.",
        },
        {
          value: 'bypass',
          name: 'Bypass',
          description: 'Force-allow every tool call, overriding any configured permissions plugin.',
        },
      ],
    },
    {
      type: 'select',
      id: CONFIG_AMP_MODE,
      name: 'Amp Mode',
      description: 'Select the Amp execution mode.',
      category: 'model',
      currentValue: s.model,
      options: AMP_MODELS.map((model) => ({
        value: model.modelId,
        name: model.name,
        description: model.description,
      })),
    },
  ];
}

interface SessionState {
  threadId: string | null;
  controller: AbortController | null;
  cancelled: boolean;
  active: boolean;
  mode: PermissionMode;
  model: AmpModelId;
  executor: Executor;
  mcpConfig: AmpMcpConfig;
  cwd: string;
}

interface InitializeResponseWithAgentInfo extends InitializeResponse {
  agentInfo: {
    name: string;
    title: string;
    version: string;
  };
}

type SetThreadArchived = (
  threadId: string,
  archived: boolean,
  options?: AmpThreadLifecycleOptions,
) => Promise<void>;

interface AmpAcpAgentOptions {
  threadStore?: ThreadMappingStore;
  setThreadArchived?: SetThreadArchived;
  exportThread?: ThreadHistoryExporter;
  /** Transport used for Orb execution; defaults to the Amp SDK transport. */
  orbTransport?: AmpTransport;
  /** Retry policy for empty history exports on session/load; mainly for tests. */
  replayRetry?: { attempts: number; delayMs: number };
}

export class AmpAcpAgent implements Agent {
  private client: AgentSideConnection;
  private transport: AmpTransport;
  private orbTransport: AmpTransport;
  private threadStore: ThreadMappingStore;
  private setThreadArchived: SetThreadArchived;
  sessions = new Map<string, SessionState>();
  private clientCapabilities?: ClientCapabilities;

  private exportThread: ThreadHistoryExporter;
  private replayRetry: { attempts: number; delayMs: number };

  constructor(
    client: AgentSideConnection,
    transport = createAmpTransport(),
    options: AmpAcpAgentOptions = {},
  ) {
    this.client = client;
    this.transport = transport;
    this.orbTransport = options.orbTransport ?? createAmpTransport('sdk');
    this.threadStore = options.threadStore ?? new FileThreadMappingStore();
    this.setThreadArchived = options.setThreadArchived ?? setAmpThreadArchived;
    this.exportThread = options.exportThread ?? exportThreadHistory;
    this.replayRetry = options.replayRetry ?? { attempts: 5, delayMs: 2000 };
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponseWithAgentInfo> {
    this.clientCapabilities = request.clientCapabilities;
    console.info(`[acp] amp-acp v${PACKAGE_VERSION} initialized`);
    return {
      protocolVersion: 1,
      agentInfo: {
        name: 'amp-acp',
        title: 'Amp ACP Agent',
        version: PACKAGE_VERSION,
      },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { resume: {} },
        _meta: {
          [THREAD_LIFECYCLE_CAPABILITY]: {
            version: 1,
            methods: {
              nativeMetadata: NATIVE_METADATA_METHOD,
              setArchived: SET_ARCHIVED_METHOD,
            },
          },
        },
      },
      authMethods: [
        {
          id: 'setup',
          name: 'Amp API Key Setup',
          description: 'Run interactive setup to configure your Amp API key',
          _meta: {
            'terminal-auth': {
              command: getTerminalAuthCommand(),
              args: ['--setup'],
              label: 'Amp API Key Setup',
            },
          },
        },
      ],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = `S-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const mcpConfig = convertAcpMcpServersToAmpConfig(params.mcpServers);

    const session: SessionState = {
      threadId: null,
      controller: null,
      cancelled: false,
      active: false,
      mode: 'default',
      model: 'medium',
      executor: 'local',
      mcpConfig,
      cwd: params.cwd || process.cwd(),
    };
    this.sessions.set(sessionId, session);

    const result: NewSessionResponse = {
      sessionId,
      configOptions: buildSessionConfigOptions(session),
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

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    let session = this.sessions.get(params.sessionId);

    if (!session) {
      const mapping = await this.threadStore.load(params.sessionId);
      if (!mapping) {
        throw RequestError.invalidParams(undefined, `No durable Amp thread mapping for ACP session ${params.sessionId}`);
      }
      session = this.sessionFromMapping(mapping, params);
      this.sessions.set(params.sessionId, session);
      console.error(`[acp] loaded session ${params.sessionId} -> thread ${mapping.threadId}`);
    }

    if (session.threadId) {
      try {
        const messages = await exportThreadMessages(
          this.exportThread,
          session.threadId,
          session.cwd,
          this.replayRetry.attempts,
          this.replayRetry.delayMs,
        );
        for (const notification of historyToNotifications(messages, params.sessionId)) {
          await this.client.sessionUpdate(notification);
        }
      } catch (e) {
        // History replay is best-effort: the thread still continues correctly
        // without it, so a failed export must not fail the load.
        console.error('[acp] failed to replay thread history', e);
      }
    }

    setImmediate(async () => {
      try {
        await this.client.sessionUpdate({
          sessionId: params.sessionId,
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

    return {
      configOptions: buildSessionConfigOptions(session),
    };
  }

  private sessionFromMapping(
    mapping: AmpThreadMapping,
    params: ResumeSessionRequest | LoadSessionRequest,
  ): SessionState {
    return {
      threadId: mapping.threadId,
      controller: null,
      cancelled: false,
      active: false,
      mode: mapping.mode && isPermissionMode(mapping.mode) ? mapping.mode : 'default',
      model: mapping.model && isAmpModelId(mapping.model) ? mapping.model : 'medium',
      executor: mapping.executor && isExecutor(mapping.executor) ? mapping.executor : 'local',
      mcpConfig: convertAcpMcpServersToAmpConfig(params.mcpServers),
      cwd: params.cwd || mapping.cwd || process.cwd(),
    };
  }

  private async persistSession(sessionId: string, s: SessionState): Promise<void> {
    if (!s.threadId) return;
    await this.threadStore.save({
      sessionId,
      threadId: s.threadId,
      mode: s.mode,
      model: s.model,
      executor: s.executor,
      cwd: s.cwd,
    });
  }

  /** Persist best-effort: a failed write must not reject a config change. */
  private async persistSessionQuiet(sessionId: string, s: SessionState): Promise<void> {
    try {
      await this.persistSession(sessionId, s);
    } catch (e) {
      console.error('[acp] failed to persist session settings', e);
    }
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    if (process.env.AMP_API_KEY) {
      return {};
    }
    throw RequestError.authRequired();
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const mapping = await this.threadStore.load(params.sessionId);
    if (!mapping) {
      throw RequestError.invalidParams(undefined, `No durable Amp thread mapping for ACP session ${params.sessionId}`);
    }
    const session = this.sessionFromMapping(mapping, params);
    this.sessions.set(params.sessionId, session);
    return { configOptions: buildSessionConfigOptions(session) };
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

    const options: AmpExecutionOptions = {
      cwd: s.cwd,
      env: { TERM: 'dumb' },
      mode: s.model,
      executor: s.executor,
    };

    if (s.executor === 'orb') {
      const project = process.env.AMP_ACP_ORB_PROJECT?.trim();
      if (project) options.project = project;
    } else {
      if (s.mode === 'bypass') {
        options.dangerouslyAllowAll = true;
      }

      if (Object.keys(s.mcpConfig).length > 0) {
        options.mcpConfig = s.mcpConfig;
      }
    }

    if (s.threadId) {
      options.continue = s.threadId;
    } else if (process.env.AMP_ACP_CONTINUE_LATEST) {
      options.continue = true;
      console.error('[acp] AMP_ACP_CONTINUE_LATEST set; continuing latest thread on this installation');
    }

    const controller = new AbortController();
    s.controller = controller;

    try {
      const transport = s.executor === 'orb' ? this.orbTransport : this.transport;
      for await (const message of transport.execute({ prompt: textInput, options, signal: controller.signal })) {
        if (message.session_id) {
          if (!isAmpThreadId(message.session_id)) {
            throw new Error(`Amp returned an invalid thread ID: ${message.session_id}`);
          }
          if (s.threadId && s.threadId !== message.session_id) {
            throw new Error(`Amp changed thread ID from ${s.threadId} to ${message.session_id}`);
          }
          if (!s.threadId) {
            s.threadId = message.session_id;
            await this.persistSession(params.sessionId, s);
            console.error(`[amp] thread ${s.threadId}`);
          }
        }

        if (message.type === 'assistant' || message.type === 'user') {
          for (const n of toAcpNotifications(message, params.sessionId)) {
            try {
              await this.client.sessionUpdate(n);
            } catch (e) {
              console.error('[acp] sessionUpdate failed', e);
            }
          }
        }

        if (message.type === 'result' && message.is_error) {
          if (typeof message.error === 'string' && isAuthError(message.error)) {
            console.error('[amp] Auth error in result, requesting authentication:', message.error);
            throw RequestError.authRequired();
          }
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
      if (err instanceof Error && isAuthError(err.message)) {
        console.error('[amp] Auth error, requesting authentication:', err.message);
        throw RequestError.authRequired();
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

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new Error('Session not found');
    if (typeof params.value !== 'string') {
      throw new Error(`Unsupported value for ${params.configId}`);
    }

    switch (params.configId) {
      case CONFIG_EXECUTOR:
        if (!isExecutor(params.value)) {
          throw new Error(`Unsupported execution environment: ${params.value}`);
        }
        s.executor = params.value;
        break;
      case CONFIG_PERMISSION:
        if (!isPermissionMode(params.value)) {
          throw new Error(`Unsupported permission mode: ${params.value}`);
        }
        s.mode = params.value;
        break;
      case CONFIG_AMP_MODE:
        if (!isAmpModelId(params.value)) {
          throw new Error(`Unsupported Amp mode: ${params.value}`);
        }
        s.model = params.value;
        break;
      default:
        throw new Error(`Unsupported config option: ${params.configId}`);
    }

    await this.persistSessionQuiet(params.sessionId, s);

    const configOptions = buildSessionConfigOptions(s);
    try {
      await this.client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'config_option_update',
          configOptions,
        },
      });
    } catch (e) {
      console.error('[acp] failed to send config_option_update', e);
    }

    return { configOptions };
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new Error('Session not found');
    if (!isPermissionMode(params.modeId)) {
      throw new Error(`Unsupported mode: ${params.modeId}`);
    }
    s.mode = params.modeId;
    await this.persistSessionQuiet(params.sessionId, s);
    return {};
  }

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (method) {
      case NATIVE_METADATA_METHOD:
        return this.nativeMetadata(params);
      case SET_ARCHIVED_METHOD:
        return this.updateArchivedState(params);
      default:
        throw RequestError.methodNotFound(method);
    }
  }

  private async nativeMetadata(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof params.sessionId !== 'string') {
      throw RequestError.invalidParams(undefined, 'sessionId must be a string');
    }
    const activeThreadId = this.sessions.get(params.sessionId)?.threadId ?? null;
    const persisted = activeThreadId ? null : await this.threadStore.load(params.sessionId);
    return {
      version: 1,
      sessionId: params.sessionId,
      ampThreadId: activeThreadId ?? persisted?.threadId ?? null,
    };
  }

  private async updateArchivedState(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof params.sessionId !== 'string') {
      throw RequestError.invalidParams(undefined, 'sessionId must be a string');
    }
    if (!isAmpThreadId(params.threadId)) {
      throw RequestError.invalidParams(undefined, 'threadId must be a durable Amp T-... thread ID');
    }
    if (typeof params.archived !== 'boolean') {
      throw RequestError.invalidParams(undefined, 'archived must be a boolean');
    }

    const active = this.sessions.get(params.sessionId);
    const persisted = await this.threadStore.load(params.sessionId);
    const mappedThreadId = active?.threadId ?? persisted?.threadId ?? null;
    if (!mappedThreadId) {
      throw RequestError.invalidParams(
        undefined,
        `No durable Amp thread mapping for ACP session ${params.sessionId}`,
      );
    }
    if (mappedThreadId !== params.threadId) {
      throw RequestError.invalidParams(
        undefined,
        `Amp thread ${params.threadId} does not match ACP session ${params.sessionId}`,
      );
    }

    await this.setThreadArchived(params.threadId, params.archived);
    return { version: 1, threadId: params.threadId, archived: params.archived };
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> { return this.client.readTextFile(params); }
  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> { return this.client.writeTextFile(params); }
}

export function isAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('invalid or missing api key') ||
    lower.includes("run 'amp login'") ||
    lower.includes('authentication') ||
    lower.includes('unauthorized') ||
    lower.includes('no api key found') ||
    (lower.includes('api key') && lower.includes('login flow')) ||
    (lower.includes('api key') && (lower.includes('missing') || lower.includes('invalid')));
}

export function getTerminalAuthCommand(
  argv1: string | undefined = process.argv[1],
  execPath: string = process.execPath,
): string {
  const resolvedArgv1 = argv1 ? path.resolve(argv1) : '';
  if (!resolvedArgv1 || resolvedArgv1.startsWith('/$bunfs/')) {
    return execPath;
  }
  return resolvedArgv1;
}
